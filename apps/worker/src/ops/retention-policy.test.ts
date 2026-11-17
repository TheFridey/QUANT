import { describe, expect, it } from "vitest";
import {
  PROPOSED_RETENTION,
  batchSelectSql,
  candidateWhere,
  clampBatch,
  cutoffFor,
  diskPressure,
  executablePolicies,
  dryRunSql,
  policyHash,
  sha256,
  validatePolicy,
  verifyManifest,
  type ArchiveManifest,
  type TableRetention,
} from "./retention-policy.js";

const byTable = (t: string) => PROPOSED_RETENTION.find((p) => p.table === t)!;

describe("retention policy (dry-run only)", () => {
  it("the proposed policy is valid: 30/30/30/90 days", () => {
    expect(validatePolicy(PROPOSED_RETENTION)).toEqual({ ok: true });
    expect(PROPOSED_RETENTION.map((p) => [p.table, p.hotDays])).toEqual([
      ["AgentDecision", 30],
      ["MarketObservation", 30],
      ["CyclePlan", 30],
      ["OpportunityFunnelEvent", 90],
    ]);
  });

  it("refuses evidence tables, duplicates, short windows, unsafe columns and rule-free tables", () => {
    const base = byTable("CyclePlan");
    expect(validatePolicy([{ ...base, table: "Order" as never }]).ok).toBe(false);
    expect(validatePolicy([{ ...base, table: "LedgerEntry" as never }]).ok).toBe(false);
    expect(validatePolicy([base, base]).ok).toBe(false);
    expect(validatePolicy([{ ...base, hotDays: 1 }]).ok).toBe(false);
    expect(validatePolicy([{ ...base, hotDays: 7.5 }]).ok).toBe(false);
    expect(validatePolicy([{ ...base, ageColumns: [`plannedAt"; DROP TABLE x; --`] }]).ok).toBe(false);
    expect(validatePolicy([{ ...base, ageColumns: [] }]).ok).toBe(false);
    expect(validatePolicy([{ ...base, preserveWhen: [] }]).ok).toBe(false);
  });

  it("every table preserves rows tied to orders; observations preserve every referencing column", () => {
    for (const p of PROPOSED_RETENTION) expect(p.preserveWhen.join(" ")).toMatch(/"Order"/);
    const obs = byTable("MarketObservation").preserveWhen.join(" ");
    for (const col of ['o."observationId"', 'o."decisionObservationId"', 'o."fillObservationId"', '"Fill"', '"TradeIntent"', '"WatchlistEntry"', '"BacktestTrade"']) {
      expect(obs).toContain(col);
    }
    expect(byTable("AgentDecision").preserveWhen.join(" ")).toContain(`NOT IN ('NO_INTENT')`);
  });

  it("generated SQL is read-only and parameterised by cutoff", () => {
    for (const p of PROPOSED_RETENTION) {
      const sql = dryRunSql(p) + batchSelectSql(p);
      expect(sql).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|ALTER)\b/i);
      expect(candidateWhere(p)).toMatch(/^(t\."\w+"|GREATEST\(t\."\w+", t\."\w+"\)) < \$1 AND NOT \(/);
    }
    expect(batchSelectSql(byTable("CyclePlan"))).toContain(`ORDER BY t."cycleId" ASC LIMIT $3`);
  });

  it("AgentDecision ages on GREATEST(createdAt, updatedAt); the executor may not touch MarketObservation yet", () => {
    expect(candidateWhere(byTable("AgentDecision"))).toContain(`GREATEST(t."createdAt", t."updatedAt") < $1`);
    expect(executablePolicies(PROPOSED_RETENTION).map((p) => p.table)).toEqual(["AgentDecision", "CyclePlan", "OpportunityFunnelEvent"]);
    expect(executablePolicies([{ ...byTable("CyclePlan"), hotDays: 1 }])).toEqual([]);
  });

  it("cutoffs, batch clamp and invalid inputs", () => {
    expect(cutoffFor(byTable("OpportunityFunnelEvent"), new Date("2026-11-17T00:00:00Z")).toISOString()).toBe("2026-08-19T00:00:00.000Z");
    expect(() => cutoffFor(byTable("CyclePlan"), new Date("x"))).toThrow("INVALID_NOW");
    expect(clampBatch(50_000)).toBe(10_000);
    expect(() => clampBatch(0)).toThrow();
  });

  it("policy hash is order-independent and changes with any rule", () => {
    const reversed = [...PROPOSED_RETENTION].reverse();
    expect(policyHash(reversed)).toBe(policyHash(PROPOSED_RETENTION));
    const changed: TableRetention[] = PROPOSED_RETENTION.map((p) => (p.table === "CyclePlan" ? { ...p, hotDays: 31 } : p));
    expect(policyHash(changed)).not.toBe(policyHash(PROPOSED_RETENTION));
  });
});

describe("archive manifest verification", () => {
  const file = Buffer.from('{"id":"a"}\n{"id":"b"}\n');
  const manifest: ArchiveManifest = {
    version: "aurum-retention-1",
    createdAt: "2026-11-17T00:00:00Z",
    policyHash: policyHash(PROPOSED_RETENTION),
    cutoffs: {},
    batches: [{ table: "CyclePlan", seq: 1, firstKey: "a", lastKey: "b", rows: 2, file: "cp-1.jsonl.gz", sha256: sha256(file), bytes: file.byteLength }],
  };

  it("passes on intact files and fails on missing, truncated or altered files", () => {
    expect(verifyManifest(manifest, () => file)).toEqual({ ok: true, rows: 2 });
    expect(verifyManifest(manifest, () => null)).toMatchObject({ ok: false, failures: [{ reason: "MISSING" }] });
    expect(verifyManifest(manifest, () => file.subarray(1))).toMatchObject({ ok: false, failures: [{ reason: "SIZE_MISMATCH" }] });
    const altered = Buffer.from(file);
    altered[2] = 0x58;
    expect(verifyManifest(manifest, () => altered)).toMatchObject({ ok: false, failures: [{ reason: "HASH_MISMATCH" }] });
    expect(verifyManifest({ ...manifest, batches: [...manifest.batches, manifest.batches[0]!] }, () => file)).toMatchObject({ ok: false, failures: [{ reason: "DUPLICATE_BATCH" }] });
    expect(verifyManifest(manifest, () => file, "other")).toMatchObject({ ok: false, failures: [{ reason: "POLICY_MISMATCH" }] });
    expect(verifyManifest(manifest, () => file, manifest.policyHash)).toEqual({ ok: true, rows: 2 });
  });
});

describe("disk pressure", () => {
  const GB = 1024 ** 3;
  it("uses the observed production figures: 49 GB free, +0.75 GB/day", () => {
    expect(diskPressure({ freeBytes: 49 * GB, totalBytes: 150 * GB, dailyGrowthBytes: 0.75 * GB })).toMatchObject({ level: "OK" });
    expect(diskPressure({ freeBytes: 25 * GB, totalBytes: 150 * GB, dailyGrowthBytes: 0.75 * GB }).level).toBe("WARN");
    expect(diskPressure({ freeBytes: 8 * GB, totalBytes: 150 * GB, dailyGrowthBytes: 0.75 * GB }).level).toBe("CRITICAL");
    expect(diskPressure({ freeBytes: Number.NaN, totalBytes: 1, dailyGrowthBytes: 0 }).level).toBe("CRITICAL");
  });
});
