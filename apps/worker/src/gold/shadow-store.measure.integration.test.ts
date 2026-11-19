import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoldShadowStore, sha256, type ShadowPolicies } from "./shadow-store.js";

/**
 * HELIOS storage measurement on a disposable database (opt-in: HELIOS_MEASURE=1). One full day at the proposed
 * ceiling of 17,280 accepted quotes (one per 5 s bucket) through the real store, then a full replay of the same day
 * (restart deduplication), a burst of in-bucket responses and a one-hour range query plan. Prints a JSON summary.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test") && process.env.HELIOS_MEASURE === "1");
const POLICIES: ShadowPolicies = { qualityPolicyHash: sha256("quality-measure"), samplingPolicyHash: sha256("sampling-5s"), bucketMs: 5_000, maxQuotesPerDay: 17_280 };
const DAY = Date.parse("2026-11-16T00:00:00Z");

describe.skipIf(!enabled)("gold shadow storage measurement", () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "GoldShadowQuote" DISABLE TRIGGER USER`);
    await prisma.$executeRawUnsafe(`TRUNCATE "GoldShadowSamplingBucket", "GoldShadowQuote", "GoldShadowIngestRun"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "GoldShadowQuote" ENABLE TRIGGER USER`);
  });
  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("one day at the ceiling", { timeout: 1_800_000 }, async () => {
    const store = new GoldShadowStore(prisma);
    const now = new Date(DAY + 86_400_000 + 60_000);
    const start = await store.startRun({ instrument: "XAU_USD", owner: "m", leaseMs: 3_600_000, configHash: sha256("cfg"), policies: POLICIES, now });
    if (!start.ok) throw new Error("lease");
    const size = async () => (await prisma.$queryRawUnsafe<{ b: bigint }[]>(`SELECT (pg_total_relation_size('"GoldShadowQuote"') + pg_total_relation_size('"GoldShadowSamplingBucket"') + pg_total_relation_size('"GoldShadowIngestRun"'))::bigint AS b`))[0]!.b;
    const lsn = async () => (await prisma.$queryRawUnsafe<{ l: string }[]>(`SELECT pg_current_wal_lsn()::text AS l`))[0]!.l;
    const walSince = async (l: string) => Number((await prisma.$queryRawUnsafe<{ b: string }[]>(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '${l}'::pg_lsn)::text AS b`))[0]!.b);
    const q = (i: number, jitter = 0) => {
      const t = new Date(DAY + i * 5_000 + 1_234 + jitter);
      const raw = `${t.toISOString().slice(0, 19)}.${String(t.getUTCMilliseconds()).padStart(3, "0")}456789Z`;
      const bid = (2650 + Math.sin(i / 50) * 10).toFixed(2);
      const ask = (Number(bid) + 0.3 + (i % 7) * 0.05).toFixed(2);
      return { instrument: "XAU_USD", providerTimeRaw: raw, receivedAt: new Date(t.getTime() + 150), rawRow: { time: raw, bid, ask }, bid, ask, providerTradeable: true, sessionState: "OPEN" as const, qualityVerdict: "ACCEPTED" as const, qualityReasons: [] };
    };

    // Storage and WAL for one full day at the ceiling: one set-based insert with the store's exact column shapes.
    const s0 = await size();
    const l0 = await lsn();
    const t0 = Date.now();
    await prisma.$executeRawUnsafe(`
      WITH g AS (SELECT i, timestamptz '2026-11-16T00:00:00Z' + make_interval(secs => i * 5 + 1.234) AS t,
                        round((2650 + sin(i / 50.0) * 10)::numeric, 2) AS bid FROM generate_series(0, 17279) AS i),
      q AS (INSERT INTO "GoldShadowQuote" ("id","runId","provider","environment","instrument","providerTimeRaw","eventTime","receivedAt",
              "eventIdentity","payloadHash","bid","ask","mid","spread","providerTradeable","sessionState","qualityVerdict","qualityReasons",
              "qualityPolicyHash","samplingPolicyHash","bucketStart")
            SELECT gen_random_uuid()::text, '${start.runId}', 'oanda_practice', 'PRACTICE', 'XAU_USD',
              to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '789Z', t, t + interval '150 ms',
              encode(sha256(('e' || i)::bytea), 'hex'), encode(sha256(('p' || i)::bytea), 'hex'),
              bid, bid + 0.30 + (i % 7) * 0.05, bid + (0.30 + (i % 7) * 0.05) / 2, 0.30 + (i % 7) * 0.05, true, 'OPEN', 'ACCEPTED', ARRAY[]::text[],
              '${POLICIES.qualityPolicyHash}', '${POLICIES.samplingPolicyHash}', timestamptz '2026-11-16T00:00:00Z' + make_interval(secs => i * 5)
            FROM g RETURNING "id", "bucketStart", "receivedAt")
      INSERT INTO "GoldShadowSamplingBucket" ("id","provider","environment","instrument","samplingPolicyHash","bucketStart","quoteId","firstReceivedAt","lastReceivedAt")
      SELECT gen_random_uuid()::text, 'oanda_practice', 'PRACTICE', 'XAU_USD', '${POLICIES.samplingPolicyHash}', "bucketStart", "id", "receivedAt", "receivedAt" FROM q`);
    const insertMs = Date.now() - t0;
    await prisma.$executeRawUnsafe(`ANALYZE "GoldShadowQuote"`);
    const s1 = await size();
    const wal1 = await walSince(l0);
    // The day is saturated (every 5 s bucket holds a quote): one more response in that day.
    const over = await store.persist(start.runId, "m", q(17_279, 2_000), POLICIES, now);

    // Application path: latency of the real store on the next day, then restart replay and an in-bucket burst.
    const day2 = { ...POLICIES, maxQuotesPerDay: 40_000 };
    const later = new Date(now.getTime() + 86_400_000);
    const replay = await new GoldShadowStore(prisma).startRun({ instrument: "XAU_USD", owner: "m2", leaseMs: 3_600_000, configHash: sha256("cfg"), policies: day2, now: later });
    if (!replay.ok) throw new Error("replay lease");
    const replayStore = new GoldShadowStore(prisma);
    const lat: number[] = [];
    for (let i = 17_280; i < 17_580; i++) {
      const a = performance.now();
      const r = await replayStore.persist(replay.runId, "m2", q(i), day2, later);
      lat.push(performance.now() - a);
      if (r.status !== "STORED") throw new Error(`app row ${i}: ${r.status}`);
    }
    const statuses: Record<string, number> = {};
    const l1 = await lsn();
    for (let i = 17_280; i < 17_580; i++) {
      const r = await replayStore.persist(replay.runId, "m2", q(i), day2, later);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    for (let i = 17_280; i < 17_340; i++) for (let k = 1; k <= 5; k++) {
      const r = await replayStore.persist(replay.runId, "m2", q(i, k * 500), day2, later);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    const walReplay = await walSince(l1);
    const s2 = await size();
    const rows = await prisma.goldShadowQuote.count();
    const plan = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS) SELECT "eventTime","bid","ask" FROM "GoldShadowQuote" WHERE "instrument"='XAU_USD' AND "eventTime" >= '2026-11-16T14:00:00Z' AND "eventTime" < '2026-11-16T15:00:00Z' ORDER BY "eventTime"`);
    lat.sort((a, b) => a - b);
    const summary = {
      rows,
      bytesForDay: Number(s1 - s0),
      bytesPerQuote: Math.round(Number(s1 - s0) / 17_280),
      walBytesForDay: wal1,
      walBytesPerQuote: Math.round(wal1 / 17_280),
      bulkInsertMs: insertMs,
      persistMs: { p50: +lat[Math.floor(lat.length * 0.5)]!.toFixed(2), p95: +lat[Math.floor(lat.length * 0.95)]!.toFixed(2), p99: +lat[Math.floor(lat.length * 0.99)]!.toFixed(2), max: +lat[lat.length - 1]!.toFixed(2) },
      overBudget: over.status,
      replayAndBurst: statuses,
      replayWalBytes: walReplay,
      bytesAfterReplay: Number(s2 - s1),
      oneHourRangeQuery: plan.map((r) => r["QUERY PLAN"]).filter((l) => /Index|Execution Time|Buffers/.test(l)).slice(0, 4),
    };
    console.log("HELIOS_MEASURE", JSON.stringify(summary));
    expect(rows).toBe(17_580);
    // With 5 s buckets the ceiling equals the number of buckets in a day: a saturated day has no free bucket, so an
    // extra response is classified before the budget is reached. The budget refusal itself is covered in the main test.
    expect(over.status).toBe("SUPPRESSED_SAME_BUCKET");
    expect(statuses.STORED ?? 0).toBe(0);
  });
});
