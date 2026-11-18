import { describe, expect, it } from "vitest";
import {
  APPROVED_RETENTION_POLICY_HASHES,
  PROPOSED_RETENTION,
  batchDeleteSql,
  batchExportSql,
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

  it("P3: MarketObservation stays executor-blocked as a hard invariant", () => {
    const unblocked = { ...byTable("MarketObservation"), executorBlocked: undefined };
    expect(validatePolicy([unblocked])).toEqual({ ok: false, reason: "MARKET_OBSERVATION_MUST_STAY_BLOCKED" });
    expect(validatePolicy([{ ...unblocked, executorBlocked: "" }]).ok).toBe(false);
    expect(executablePolicies([unblocked])).toEqual([]);
    expect(APPROVED_RETENTION_POLICY_HASHES).toEqual([]);
  });

  it("export and delete SQL re-check age, dependencies and row content", () => {
    const cp = byTable("CyclePlan");
    expect(batchExportSql(cp)).toContain("to_jsonb(t)::text AS doc");
    expect(batchExportSql(cp)).toContain(candidateWhere(cp));
    const del = batchDeleteSql(cp);
    expect(del).toMatch(/^DELETE FROM "CyclePlan" t USING unnest\(\$2::text\[\], \$3::text\[\]\)/);
    expect(del).toContain("md5(to_jsonb(t)::text) = v.h");
    expect(del).toContain(candidateWhere(cp));
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

  const H = manifest.policyHash;

  it("passes on intact files and fails on missing, truncated or altered files", () => {
    expect(verifyManifest(manifest, () => file, H)).toEqual({ ok: true, rows: 2 });
    expect(verifyManifest(manifest, () => null, H)).toMatchObject({ ok: false, failures: [{ reason: "MISSING" }] });
    expect(verifyManifest(manifest, () => file.subarray(1), H)).toMatchObject({ ok: false, failures: [{ reason: "SIZE_MISMATCH" }] });
    const altered = Buffer.from(file);
    altered[2] = 0x58;
    expect(verifyManifest(manifest, () => altered, H)).toMatchObject({ ok: false, failures: [{ reason: "HASH_MISMATCH" }] });
    expect(verifyManifest({ ...manifest, batches: [...manifest.batches, manifest.batches[0]!] }, () => file, H)).toMatchObject({ ok: false, failures: [{ reason: "DUPLICATE_BATCH" }] });
    expect(verifyManifest(manifest, () => file, "other")).toMatchObject({ ok: false, failures: [{ reason: "POLICY_MISMATCH" }] });
  });

  it("P1: the expected policy hash is mandatory", () => {
    expect(verifyManifest(manifest, () => file, "")).toMatchObject({ ok: false, failures: [{ reason: "POLICY_MISMATCH" }] });
    expect(verifyManifest(manifest, () => file, undefined as unknown as string)).toMatchObject({ ok: false, failures: [{ reason: "POLICY_MISMATCH" }] });
    expect(verifyManifest({ ...manifest, version: "x" as never }, () => file, H)).toMatchObject({ ok: false, failures: [{ reason: "BAD_VERSION" }] });
  });

  it("P2: the same file or content under another seq, and overlapping key ranges, are refused", () => {
    const b = manifest.batches[0]!;
    const other = Buffer.from('{"id":"c"}\n');
    const read = (f: string) => (f === b.file ? file : other);
    const sameFile = { ...b, seq: 2 };
    expect(verifyManifest({ ...manifest, batches: [b, sameFile] }, read, H)).toMatchObject({ ok: false, failures: [{ reason: "DUPLICATE_FILE" }] });
    const sameContent = { ...b, seq: 2, file: "cp-2.jsonl.gz", firstKey: "x", lastKey: "y" };
    expect(verifyManifest({ ...manifest, batches: [b, sameContent] }, () => file, H)).toMatchObject({ ok: false, failures: [{ reason: "DUPLICATE_FILE" }] });
    const overlap = { ...b, seq: 2, file: "cp-2.jsonl.gz", firstKey: "ab", lastKey: "c", rows: 1, sha256: sha256(other), bytes: other.byteLength };
    expect(verifyManifest({ ...manifest, batches: [b, overlap] }, read, H)).toMatchObject({ ok: false, failures: [{ reason: "KEY_RANGE_OVERLAP" }] });
    const contained = { ...overlap, firstKey: "a0", lastKey: "a1" };
    expect(verifyManifest({ ...manifest, batches: [b, contained] }, read, H)).toMatchObject({ ok: false, failures: [{ reason: "KEY_RANGE_OVERLAP" }] });
    const adjacent = { ...overlap, firstKey: "c", lastKey: "d" };
    expect(verifyManifest({ ...manifest, batches: [b, adjacent] }, read, H)).toEqual({ ok: true, rows: 3 });
    // The same range in another table is not an overlap.
    expect(verifyManifest({ ...manifest, batches: [b, { ...overlap, table: "AgentDecision" }] }, read, H)).toEqual({ ok: true, rows: 3 });
    expect(verifyManifest({ ...manifest, batches: [{ ...b, firstKey: "z" }] }, () => file, H)).toMatchObject({ ok: false, failures: [{ reason: "BAD_KEY_RANGE" }] });
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
