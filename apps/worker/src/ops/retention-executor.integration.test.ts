import { PrismaClient } from "@odin/shared/db";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROPOSED_RETENTION, policyHash, type ArchiveManifest } from "./retention-policy.js";
import { executeRetention, restoreRetentionRun, type ExecuteOptions } from "./retention-executor.js";
import { prismaRetentionDb, prismaRetentionLock } from "./retention-prisma.js";

/**
 * AURUM Workstream Zero disposable-database proof (STORAGE-PLAN §4). Runs only against an *odin_test* database.
 * Every consequential boundary is failed on purpose: interruption before and after the delete, corruption,
 * duplicates, overlapping ranges, a changed policy, changed rows, new evidence, failed restore, low disk,
 * WAL budget and concurrent runners.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const HASH = policyHash(PROPOSED_RETENTION);
const GB = 1024 ** 3;

describe.skipIf(!enabled)("retention executor on a disposable database", () => {
  let prisma: PrismaClient;
  let dir: string;
  let backup: string;

  const snapshot = async (table: string, key: string) =>
    (await prisma.$queryRawUnsafe<{ k: string; doc: string }[]>(`SELECT t."${key}"::text AS k, to_jsonb(t)::text AS doc FROM "${table}" t ORDER BY 1`)).map(
      (r) => `${r.k}|${r.doc}`,
    );
  const count = async (table: string, where = "TRUE") =>
    Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" t WHERE ${where}`))[0]!.n);

  const options = (over: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
    db: prismaRetentionDb(prisma),
    lock: prismaRetentionLock(databaseUrl!, prisma),
    policy: PROPOSED_RETENTION,
    expectedPolicyHash: HASH,
    approvedPolicyHashes: [HASH],
    archiveDir: dir,
    now: new Date(),
    batchRows: 100,
    maxBatches: 1000,
    maxWalBytes: 4 * GB,
    walHeadroomBytes: 0,
    dailyGrowthBytes: 0,
    backup: { path: backup, maxAgeHours: 26 },
    statfs: () => ({ freeBytes: 500 * GB, totalBytes: 1000 * GB }),
    ...over,
  });

  /**
   * Fixture: 250 aged NO_INTENT decisions (candidates) in cycles 11..260; cycles 1..10 have an EquitySnapshot
   * (evidence) and their decisions, plans and funnel events must stay; 20 aged non-NO_INTENT decisions stay;
   * 30 young decisions stay; aged observations stay (MarketObservation is executor-blocked).
   */
  async function seed() {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "AgentDecision", "CyclePlan", "OpportunityFunnelEvent", "MarketObservation", "EquitySnapshot", "TradeIntent", "Order" RESTART IDENTITY CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      INSERT INTO "AgentDecision" ("id","cycleId","agent","modelVersion","pairAddress","decision","confidence","reasonCodes","input","output","createdAt","updatedAt")
      SELECT 'ad-' || lpad(i::text, 5, '0'), 'cyc-' || lpad(i::text, 5, '0'), 'ATLAS', 'v1', 'pair', 'NO_INTENT', 0.512345, ARRAY['NO_EDGE','LOW_VOL'],
             jsonb_build_object('i', i, 'nested', jsonb_build_object('px', 1.10 * i)), '{"ok":true}'::jsonb,
             now() - interval '60 days' + (i || ' seconds')::interval, now() - interval '59 days'
      FROM generate_series(1, 260) AS i`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "AgentDecision" ("id","cycleId","agent","modelVersion","decision","confidence","reasonCodes","input","output","createdAt","updatedAt")
      SELECT 'ae-' || lpad(i::text, 5, '0'), 'cyc-x' || i, 'AEGIS', 'v1', 'REJECT', 1, ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, now() - interval '90 days', now() - interval '90 days'
      FROM generate_series(1, 20) AS i`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "AgentDecision" ("id","cycleId","agent","modelVersion","decision","confidence","reasonCodes","input","output","createdAt","updatedAt")
      SELECT 'ay-' || lpad(i::text, 5, '0'), 'cyc-y' || i, 'ATLAS', 'v1', 'NO_INTENT', 0, ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, now() - interval '1 day', now() - interval '1 day'
      FROM generate_series(1, 30) AS i`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "CyclePlan" ("cycleId","plannedAt","plan","createdAt")
      SELECT 'cyc-' || lpad(i::text, 5, '0'), now() - interval '60 days', jsonb_build_object('n', i), now() - interval '60 days' FROM generate_series(1, 260) AS i`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "OpportunityFunnelEvent" ("id","cycleId","pairAddress","stage","reasonCodes","createdAt")
      SELECT 'of-' || lpad(i::text, 5, '0'), 'cyc-' || lpad(i::text, 5, '0'), 'pair', 'SCREEN', ARRAY['X'], now() - interval '120 days' FROM generate_series(1, 260) AS i`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "EquitySnapshot" ("id","cycleId","cashUsd","realizedPnlUsd","valuation","feesUsd","metrics")
      SELECT 'es-' || i, 'cyc-' || lpad(i::text, 5, '0'), 10000, 0, 'MARKED', 0, '{}'::jsonb FROM generate_series(1, 10) AS i`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "MarketObservation" ("id","ingestJobId","source","chainId","pairAddress","dexId","baseAddress","baseSymbol","baseName","quoteAddress","quoteSymbol","freshness","receivedAt","raw")
      SELECT 'mo-' || i, 'job', 'test', 'solana', 'p' || i, 'dex', 'b', 'B', 'B', 'q', 'Q', 'FRESH', now() - interval '200 days', '{}'::jsonb FROM generate_series(1, 25) AS i`);
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    backup = join(mkdtempSync(join(tmpdir(), "aurum-backup-")), "quant.dump");
    writeFileSync(backup, "backup");
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "aurum-archive-"));
    await seed();
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  const manifestOf = (runId: string) => JSON.parse(readFileSync(join(dir, runId, "manifest.json"), "utf8")) as ArchiveManifest;

  it("archives and deletes only candidates, preserves evidence and restores byte-identical rows", async () => {
    const before = {
      ad: await snapshot("AgentDecision", "id"),
      cp: await snapshot("CyclePlan", "cycleId"),
      of: await snapshot("OpportunityFunnelEvent", "id"),
      mo: await snapshot("MarketObservation", "id"),
    };
    const r = await executeRetention(options());
    expect(r).toMatchObject({ ok: true, complete: true });
    if (!r.ok) return;
    expect(r.tables).toMatchObject({
      AgentDecision: { archived: 250, deleted: 250, retained: 0, batches: 3 },
      CyclePlan: { archived: 250, deleted: 250, retained: 0 },
      OpportunityFunnelEvent: { archived: 250, deleted: 250, retained: 0 },
    });
    expect(r.tables.MarketObservation).toBeUndefined();
    expect(await count("AgentDecision")).toBe(10 + 20 + 30);
    expect(await count("AgentDecision", `t."cycleId" <= 'cyc-00010' AND t."cycleId" LIKE 'cyc-0%'`)).toBe(10);
    expect(await count("CyclePlan")).toBe(10);
    expect(await count("OpportunityFunnelEvent")).toBe(10);
    expect(await snapshot("MarketObservation", "id")).toEqual(before.mo);
    expect(manifestOf(r.runId).state).toBe("COMPLETE");

    const restored = await restoreRetentionRun({ db: prismaRetentionDb(prisma), archiveDir: dir, runId: r.runId, expectedPolicyHash: HASH, policy: PROPOSED_RETENTION });
    expect(restored).toEqual({ ok: true, runId: r.runId, inserted: 750, skippedExisting: 0, verified: 750 });
    expect(await snapshot("AgentDecision", "id")).toEqual(before.ad);
    expect(await snapshot("CyclePlan", "cycleId")).toEqual(before.cp);
    expect(await snapshot("OpportunityFunnelEvent", "id")).toEqual(before.of);
    // A second restore is idempotent.
    expect(await restoreRetentionRun({ db: prismaRetentionDb(prisma), archiveDir: dir, runId: r.runId, expectedPolicyHash: HASH, policy: PROPOSED_RETENTION })).toMatchObject({
      ok: true,
      inserted: 0,
      skippedExisting: 750,
    });
  });

  it("refuses without approval, without a hash, with a wrong hash, and with MarketObservation unblocked", async () => {
    expect(await executeRetention(options({ approvedPolicyHashes: [] }))).toMatchObject({ ok: false, reason: "POLICY_NOT_APPROVED" });
    expect(await executeRetention(options({ approvedPolicyHashes: undefined }))).toMatchObject({ ok: false, reason: "POLICY_NOT_APPROVED" });
    expect(await executeRetention(options({ expectedPolicyHash: "" }))).toMatchObject({ ok: false, reason: "POLICY_HASH_REQUIRED" });
    expect(await executeRetention(options({ expectedPolicyHash: "f".repeat(64) }))).toMatchObject({ ok: false, reason: "POLICY_HASH_MISMATCH" });
    const unblocked = PROPOSED_RETENTION.map((p) => (p.table === "MarketObservation" ? { ...p, executorBlocked: undefined } : p));
    expect(await executeRetention(options({ policy: unblocked, expectedPolicyHash: policyHash(unblocked), approvedPolicyHashes: [policyHash(unblocked)] }))).toMatchObject({
      ok: false,
      reason: "MARKET_OBSERVATION_MUST_STAY_BLOCKED",
    });
    expect(await count("AgentDecision")).toBe(310);
  });

  it("interrupted before the delete: a new run is refused, and resume completes exactly once", async () => {
    let n = 0;
    const r1 = await executeRetention(
      options({
        hooks: {
          beforeDelete: async () => {
            if (++n === 2) throw new Error("simulated crash before delete");
          },
        },
      }),
    );
    expect(r1).toMatchObject({ ok: false, reason: "INTERRUPTED" });
    if (r1.ok) return;
    const runId = r1.runId!;
    expect(await count("AgentDecision")).toBe(310 - 100);
    expect(manifestOf(runId).batches.map((b) => b.status)).toEqual(["DELETED", "PENDING_DELETE"]);

    expect(await executeRetention(options())).toMatchObject({ ok: false, reason: "INCOMPLETE_RUN_EXISTS" });
    const r2 = await executeRetention(options({ resumeRunId: runId }));
    expect(r2).toMatchObject({ ok: true, complete: true, tables: { AgentDecision: { archived: 250, deleted: 250, retained: 0 } } });
    expect(await count("AgentDecision")).toBe(60);
    expect(await executeRetention(options({ resumeRunId: runId }))).toMatchObject({ ok: false, reason: "RUN_ALREADY_COMPLETE" });
  });

  it("interrupted after the delete committed: resume reconciles from the archive without losing rows", async () => {
    const before = await snapshot("AgentDecision", "id");
    let n = 0;
    const r1 = await executeRetention(
      options({
        hooks: {
          afterDelete: async () => {
            if (++n === 1) throw new Error("simulated crash after delete");
          },
        },
      }),
    );
    expect(r1).toMatchObject({ ok: false, reason: "INTERRUPTED" });
    if (r1.ok) return;
    expect(manifestOf(r1.runId!).batches[0]).toMatchObject({ status: "PENDING_DELETE", rows: 100 });
    const r2 = await executeRetention(options({ resumeRunId: r1.runId! }));
    expect(r2).toMatchObject({ ok: true, tables: { AgentDecision: { archived: 250, deleted: 250, retained: 0 } } });
    expect(await restoreRetentionRun({ db: prismaRetentionDb(prisma), archiveDir: dir, runId: r1.runId!, expectedPolicyHash: HASH, policy: PROPOSED_RETENTION })).toMatchObject({ ok: true });
    expect(await snapshot("AgentDecision", "id")).toEqual(before);
  });

  it("a changed policy hash cannot resume a run", async () => {
    const r1 = await executeRetention(options({ hooks: { beforeDelete: async () => Promise.reject(new Error("stop")) } }));
    if (r1.ok) throw new Error("expected interruption");
    const changed = PROPOSED_RETENTION.map((p) => (p.table === "CyclePlan" ? { ...p, hotDays: 31 } : p));
    const h = policyHash(changed);
    expect(await executeRetention(options({ policy: changed, expectedPolicyHash: h, approvedPolicyHashes: [h], resumeRunId: r1.runId! }))).toMatchObject({
      ok: false,
      reason: "POLICY_MISMATCH",
    });
    expect(await count("AgentDecision")).toBe(310);
  });

  it("rows changed after export, and rows that gained evidence, are not deleted", async () => {
    const r = await executeRetention(
      options({
        hooks: {
          beforeDelete: async (b) => {
            if (b.table !== "AgentDecision" || b.seq !== 1) return;
            // Another writer changes one archived row's content; another cycle gains durable evidence.
            await prisma.$executeRawUnsafe(`UPDATE "AgentDecision" SET "output" = '{"changed":true}'::jsonb WHERE "id" = 'ad-00011'`);
            await prisma.$executeRawUnsafe(
              `INSERT INTO "EquitySnapshot" ("id","cycleId","cashUsd","realizedPnlUsd","valuation","feesUsd","metrics") VALUES ('es-new','cyc-00012',1,0,'MARKED',0,'{}')`,
            );
          },
        },
      }),
    );
    expect(r).toMatchObject({ ok: true, tables: { AgentDecision: { archived: 250, deleted: 248, retained: 2 } } });
    expect(await count("AgentDecision", `t."id" IN ('ad-00011','ad-00012')`)).toBe(2);
    expect(await count("CyclePlan", `t."cycleId" = 'cyc-00012'`)).toBe(1);
    // Restore never overwrites the newer row, and reports that it differs from the archive.
    const restored = await restoreRetentionRun({ db: prismaRetentionDb(prisma), archiveDir: dir, runId: r.ok ? r.runId : "", expectedPolicyHash: HASH, policy: PROPOSED_RETENTION });
    expect(restored).toMatchObject({ ok: false, reason: "RESTORE_VERIFY_FAILED", detail: { count: 1, mismatched: ["AgentDecision:ad-00011"] } });
    expect(await count("AgentDecision", `t."id" = 'ad-00011' AND t."output" = '{"changed":true}'::jsonb`)).toBe(1);
  });

  it("corrupted, duplicated and overlapping archives are refused before anything is written", async () => {
    const r = await executeRetention(options());
    if (!r.ok) throw new Error("expected success");
    const runDir = join(dir, r.runId);
    const deletedState = await count("AgentDecision");
    const restore = () => restoreRetentionRun({ db: prismaRetentionDb(prisma), archiveDir: dir, runId: r.runId, expectedPolicyHash: HASH, policy: PROPOSED_RETENTION });
    const m = manifestOf(r.runId);
    const original = readFileSync(join(runDir, "manifest.json"), "utf8");

    const file = join(runDir, m.batches[0]!.file);
    const bytes = readFileSync(file);
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 5] ^= 0xff;
    writeFileSync(file, corrupt);
    expect(await restore()).toMatchObject({ ok: false, reason: "ARCHIVE_INVALID", detail: [{ reason: "HASH_MISMATCH" }] });
    writeFileSync(file, bytes);

    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ ...m, batches: [...m.batches, { ...m.batches[0]!, seq: 99 }] }));
    expect(await restore()).toMatchObject({ ok: false, reason: "ARCHIVE_INVALID", detail: [{ reason: "DUPLICATE_FILE" }] });

    const overlapping = m.batches.map((b, i) => (i === 1 ? { ...b, firstKey: m.batches[0]!.lastKey } : b));
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ ...m, batches: overlapping }));
    expect(await restore()).toMatchObject({ ok: false, reason: "ARCHIVE_INVALID", detail: [{ reason: "KEY_RANGE_OVERLAP" }] });

    writeFileSync(join(runDir, "manifest.json"), original);
    expect(await restoreRetentionRun({ db: prismaRetentionDb(prisma), archiveDir: dir, runId: r.runId, expectedPolicyHash: "", policy: PROPOSED_RETENTION })).toMatchObject({
      ok: false,
      reason: "ARCHIVE_INVALID",
      detail: [{ reason: "POLICY_MISMATCH" }],
    });
    rmSync(file);
    expect(await restore()).toMatchObject({ ok: false, reason: "ARCHIVE_INVALID", detail: [{ reason: "MISSING" }] });
    expect(await count("AgentDecision")).toBe(deletedState);
  });

  it("a corrupted archive blocks resuming an interrupted run", async () => {
    const r1 = await executeRetention(options({ hooks: { beforeDelete: async () => Promise.reject(new Error("stop")) } }));
    if (r1.ok) throw new Error("expected interruption");
    const b = manifestOf(r1.runId!).batches[0]!;
    writeFileSync(join(dir, r1.runId!, b.file), Buffer.from("not gzip"));
    expect(await executeRetention(options({ resumeRunId: r1.runId! }))).toMatchObject({ ok: false, reason: "ARCHIVE_INVALID" });
    expect(await count("AgentDecision")).toBe(310);
  });

  it("refuses on insufficient disk, critical disk pressure and a missing or stale backup", async () => {
    expect(await executeRetention(options({ statfs: () => ({ freeBytes: 1, totalBytes: 1000 }) }))).toMatchObject({ ok: false, reason: "DISK_CRITICAL" });
    expect(await executeRetention(options({ archiveDir: join(dir, "a"), statfs: () => ({ freeBytes: 900 * GB, totalBytes: 1000 * GB }), walHeadroomBytes: 901 * GB }))).toMatchObject({
      ok: false,
      reason: "INSUFFICIENT_DISK",
    });
    expect(await executeRetention(options({ archiveDir: join(dir, "b"), backup: { path: join(dir, "none.dump"), maxAgeHours: 26 } }))).toMatchObject({
      ok: false,
      reason: "BACKUP_MISSING",
    });
    const stale = join(dir, "stale.dump");
    writeFileSync(stale, "x");
    const old = (Date.now() - 48 * 3_600_000) / 1000;
    utimesSync(stale, old, old);
    expect(await executeRetention(options({ archiveDir: join(dir, "c"), backup: { path: stale, maxAgeHours: 26 } }))).toMatchObject({ ok: false, reason: "BACKUP_STALE" });
    expect(await count("AgentDecision")).toBe(310);
  });

  it("stops at the WAL budget and at the batch bound, and resumes", async () => {
    const r1 = await executeRetention(options({ maxWalBytes: 1 }));
    expect(r1).toMatchObject({ ok: true, complete: false, stopReason: "WAL_BUDGET_EXCEEDED", tables: { AgentDecision: { batches: 1 } } });
    if (!r1.ok) return;
    const r2 = await executeRetention(options({ resumeRunId: r1.runId, maxBatches: 2 }));
    expect(r2).toMatchObject({ ok: true, complete: false, stopReason: "MAX_BATCHES" });
    const r3 = await executeRetention(options({ resumeRunId: r1.runId }));
    expect(r3).toMatchObject({ ok: true, complete: true, tables: { AgentDecision: { deleted: 250 }, CyclePlan: { deleted: 250 }, OpportunityFunnelEvent: { deleted: 250 } } });
  });

  it("excludes concurrent runners and fences the delete on the lock", async () => {
    const [a, b] = await Promise.all([executeRetention(options()), executeRetention(options())]);
    const reasons = [a, b].map((x) => (x.ok ? "OK" : x.reason)).sort();
    expect(reasons).toEqual(["LOCKED", "OK"]);

    await seed();
    const d2 = mkdtempSync(join(tmpdir(), "aurum-archive-"));
    const external = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      // The lock is lost mid-run (the holder's session is killed): the next delete must not happen.
      const r = await executeRetention(
        options({
          archiveDir: d2,
          hooks: {
            beforeDelete: async (batch) => {
              if (batch.seq !== 2) return;
              await external.$executeRawUnsafe(
                `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${0x41555255} AND objsubid = 1`,
              );
            },
          },
        }),
      );
      expect(r).toMatchObject({ ok: false });
      expect(await count("AgentDecision")).toBe(310 - 100);
    } finally {
      await external.$disconnect();
    }
    expect(existsSync(d2)).toBe(true);
  });
});
