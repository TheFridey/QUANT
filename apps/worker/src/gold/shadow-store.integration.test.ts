import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GoldShadowStore, MAX_REJECTION_SAMPLES, eventIdentity, parseProviderTime, sha256, type ShadowPolicies, type ShadowQuoteInput } from "./shadow-store.js";

/** HELIOS (D11) on a disposable database: every persistence guarantee is exercised against real PostgreSQL. */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const POLICIES: ShadowPolicies = { qualityPolicyHash: sha256("quality-test"), samplingPolicyHash: sha256("sampling-5s"), bucketMs: 5_000, maxQuotesPerDay: 17_280 };
const NOW = new Date("2026-11-17T15:00:10.000Z");

const quote = (over: Partial<ShadowQuoteInput> = {}): ShadowQuoteInput => ({
  instrument: "XAU_USD",
  providerTimeRaw: "2026-11-17T15:00:01.123456789Z",
  receivedAt: NOW,
  rawRow: { instrument: "XAU_USD", time: over.providerTimeRaw ?? "2026-11-17T15:00:01.123456789Z", bids: [{ price: over.bid ?? "2650.12" }], asks: [{ price: over.ask ?? "2650.43" }] },
  bid: "2650.12",
  ask: "2650.43",
  providerTradeable: true,
  sessionState: "OPEN",
  qualityVerdict: "ACCEPTED",
  qualityReasons: [],
  ...over,
});

describe.skipIf(!enabled)("gold shadow store (disposable database)", () => {
  let prisma: PrismaClient;
  let store: GoldShadowStore;

  beforeAll(async () => {
    const setup = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await setup.$executeRawUnsafe(`ALTER DATABASE odin_test SET timezone = 'Europe/London'`);
    await setup.$disconnect();
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    expect((await prisma.$queryRawUnsafe<{ tz: string }[]>(`SELECT current_setting('TimeZone') AS tz`))[0]!.tz).toBe("Europe/London");
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "GoldShadowQuote" DISABLE TRIGGER USER`);
    await prisma.$executeRawUnsafe(`TRUNCATE "GoldShadowSamplingBucket", "GoldShadowQuote", "GoldShadowIngestRun"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "GoldShadowQuote" ENABLE TRIGGER USER`);
    store = new GoldShadowStore(prisma);
  });
  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$executeRawUnsafe(`ALTER DATABASE odin_test RESET timezone`);
    await prisma.$disconnect();
  });

  const start = async (owner = "w1", now = NOW, policies = POLICIES) => {
    const r = await store.startRun({ instrument: "XAU_USD", owner, leaseMs: 60_000, configHash: sha256("cfg"), policies, now });
    if (!r.ok) throw new Error(r.reason);
    return r.runId;
  };

  it("stores a quote exactly, keeps the nanosecond provider time, and is never executable", async () => {
    const runId = await start();
    const r = await store.persist(runId, "w1", quote(), POLICIES, NOW);
    expect(r.status).toBe("STORED");
    const row = await prisma.goldShadowQuote.findFirstOrThrow();
    expect(row).toMatchObject({ providerTimeRaw: "2026-11-17T15:00:01.123456789Z", executionEligible: false, quoteKind: "REFERENCE_MARKET_QUOTE", sessionState: "OPEN" });
    expect(row.bid.toFixed(2)).toBe("2650.12");
    expect(row.spread.toFixed(2)).toBe("0.31");
    expect(row.mid.toFixed(3)).toBe("2650.275");
    expect(row.eventTime.toISOString()).toBe("2026-11-17T15:00:01.123Z");
    expect(row.eventIdentity).toBe(eventIdentity("XAU_USD", "2026-11-17T15:00:01.123456789Z"));
    expect((await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: runId } })).accepted).toBe(1);
    // The database refuses an executable quote however it is written.
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "GoldShadowQuote" SELECT gen_random_uuid()::text, "runId", "provider", "environment", "instrument", "quoteKind", "providerTimeRaw", "eventTime", "receivedAt", md5('x') || md5('y'), "payloadHash", "bid", "ask", "mid", "spread", "providerTradeable", "sessionState", "qualityVerdict", "qualityReasons", "qualityPolicyHash", "samplingPolicyHash", "bucketStart" + interval '1 hour', true, now() FROM "GoldShadowQuote" LIMIT 1`)).rejects.toThrow(/GoldShadowQuote_not_executable/);
  });

  it("a restarted worker does not store the same event twice", async () => {
    const run1 = await start("w1");
    expect((await store.persist(run1, "w1", quote(), POLICIES, NOW)).status).toBe("STORED");
    await store.stopRun(run1, "w1", NOW, "STOPPED");
    const restarted = new GoldShadowStore(prisma);
    const run2 = (await restarted.startRun({ instrument: "XAU_USD", owner: "w1", leaseMs: 60_000, configHash: sha256("cfg"), policies: POLICIES, now: NOW })) as { ok: true; runId: string };
    expect((await restarted.persist(run2.runId, "w1", quote(), POLICIES, NOW)).status).toBe("DUPLICATE");
    expect(await prisma.goldShadowQuote.count()).toBe(1);
  });

  it("the same event with a different payload is a conflict and never overwrites the stored quote", async () => {
    const runId = await start();
    await store.persist(runId, "w1", quote(), POLICIES, NOW);
    expect((await store.persist(runId, "w1", quote({ bid: "2651.00", ask: "2651.30" }), POLICIES, NOW)).status).toBe("CONFLICT");
    const row = await prisma.goldShadowQuote.findFirstOrThrow();
    expect(row.bid.toFixed(2)).toBe("2650.12");
    const run = await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.rejected).toBe(1);
    expect(run.rejectionSamples).toEqual([expect.objectContaining({ reason: "CONFLICTING_PAYLOAD", eventIdentity: row.eventIdentity })]);
  });

  it("one canonical quote per bucket; later responses are counted, not stored", async () => {
    const runId = await start();
    expect((await store.persist(runId, "w1", quote(), POLICIES, NOW)).status).toBe("STORED");
    // A different event (different nanoseconds, different price) inside the same 5 s bucket.
    const later = quote({ providerTimeRaw: "2026-11-17T15:00:03.000000001Z", bid: "2650.20", ask: "2650.50", receivedAt: new Date(NOW.getTime() + 2_000) });
    expect((await store.persist(runId, "w1", later, POLICIES, NOW)).status).toBe("SUPPRESSED_SAME_BUCKET");
    expect(await prisma.goldShadowQuote.count()).toBe(1);
    const bucket = await prisma.goldShadowSamplingBucket.findFirstOrThrow();
    expect(bucket.suppressedCount).toBe(1);
    expect(bucket.lastReceivedAt.getTime()).toBe(NOW.getTime() + 2_000);
    // Nanosecond-distinct events have distinct identities.
    expect(eventIdentity("XAU_USD", "2026-11-17T15:00:01.123456789Z")).not.toBe(eventIdentity("XAU_USD", "2026-11-17T15:00:01.123456788Z"));
    // The next bucket stores again.
    expect((await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T15:00:06.0Z" }), POLICIES, NOW)).status).toBe("STORED");
  });

  it("two workers racing for the same bucket store exactly one quote", async () => {
    const runId = await start();
    const a = quote({ providerTimeRaw: "2026-11-17T15:00:00.100Z", bid: "2650.10", ask: "2650.40" });
    const b = quote({ providerTimeRaw: "2026-11-17T15:00:00.200Z", bid: "2650.11", ask: "2650.41" });
    const other = new GoldShadowStore(new PrismaClient({ datasources: { db: { url: databaseUrl } } }));
    const results = await Promise.all([store.persist(runId, "w1", a, POLICIES, NOW), other.persist(runId, "w1", b, POLICIES, NOW)]);
    expect(results.map((r) => r.status).sort()).toEqual(["STORED", "SUPPRESSED_SAME_BUCKET"]);
    expect(await prisma.goldShadowQuote.count()).toBe(1);
  });

  it("only one live lease per instrument; a writer that lost its lease cannot persist", async () => {
    // A same-owner restart inside the lease window closes the earlier run: never two RUNNING runs.
    const first = await start("w1");
    const runId = await start("w1");
    expect((await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: first } })).status).toBe("STOPPED");
    expect((await store.persist(first, "w1", quote(), POLICIES, NOW)).status).toBe("LEASE_LOST");
    expect(await store.startRun({ instrument: "XAU_USD", owner: "w2", leaseMs: 60_000, configHash: sha256("cfg"), policies: POLICIES, now: NOW })).toMatchObject({ ok: false, reason: "LEASE_HELD" });
    const later = new Date(NOW.getTime() + 61_000);
    // w1's lease expired: w2 takes over and w1's old run is closed.
    const w2 = (await store.startRun({ instrument: "XAU_USD", owner: "w2", leaseMs: 60_000, configHash: sha256("cfg"), policies: POLICIES, now: later })) as { ok: true; runId: string };
    expect(w2.ok).toBe(true);
    expect((await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("STOPPED");
    expect((await store.persist(runId, "w1", quote(), POLICIES, later)).status).toBe("LEASE_LOST");
    expect(await store.renewLease(runId, "w1", later, 60_000)).toBe(false);
    expect(await store.renewLease(w2.runId, "w2", later, 60_000)).toBe(true);
  });

  it("the daily budget is counted in the database and survives a restart", async () => {
    const small = { ...POLICIES, maxQuotesPerDay: 3 };
    let runId = await start("w1", NOW, small);
    for (let i = 0; i < 3; i++) {
      expect((await store.persist(runId, "w1", quote({ providerTimeRaw: `2026-11-17T14:5${i}:00.000Z` }), small, NOW)).status).toBe("STORED");
    }
    // At the limit, a repeated poll of a stored event is still a duplicate and does not end the run.
    expect((await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T14:52:00.000Z" }), small, NOW)).status).toBe("DUPLICATE");
    expect((await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("RUNNING");
    expect((await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T14:55:00.000Z" }), small, NOW)).status).toBe("BUDGET_EXHAUSTED");
    expect((await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("BUDGET_EXHAUSTED");
    runId = await start("w1", NOW, small);
    expect((await new GoldShadowStore(prisma).persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T14:56:00.000Z" }), small, NOW)).status).toBe("BUDGET_EXHAUSTED");
    // The next UTC day has its own budget.
    const tomorrow = new Date("2026-11-18T00:00:10Z");
    runId = await start("w1", tomorrow, small);
    expect((await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-18T00:00:01.000Z", receivedAt: tomorrow }), small, tomorrow)).status).toBe("STORED");
  });

  it("rejection evidence is bounded at 50 samples in the database while every rejection is counted", async () => {
    const runId = await start();
    for (let i = 0; i < MAX_REJECTION_SAMPLES + 25; i++) await store.recordRejection(runId, "PROVIDER_TIMEOUT", NOW, { i });
    const run = await prisma.goldShadowIngestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.rejected).toBe(MAX_REJECTION_SAMPLES + 25);
    expect((run.rejectionSamples as unknown[]).length).toBe(MAX_REJECTION_SAMPLES);
    await expect(prisma.$executeRawUnsafe(`UPDATE "GoldShadowIngestRun" SET "rejectionSamples" = "rejectionSamples" || '[1]'::jsonb WHERE "id" = '${runId}'`)).rejects.toThrow(/rejection_samples_bounded/);
  });

  it("quotes are append-only, and invalid input is refused before it reaches the database", async () => {
    const runId = await start();
    await store.persist(runId, "w1", quote(), POLICIES, NOW);
    await expect(prisma.$executeRawUnsafe(`UPDATE "GoldShadowQuote" SET "bid" = 1`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "GoldShadowQuote"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "GoldShadowQuote" CASCADE`)).rejects.toThrow(/append-only/);
    expect((await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17 15:00:01" }), POLICIES, NOW))).toEqual({ status: "INVALID", reason: "PROVIDER_TIME_UNPARSEABLE" });
    expect((await store.persist(runId, "w1", quote({ bid: "2650.5", ask: "2650.5" }), POLICIES, NOW)).status).toBe("INVALID");
    expect((await store.persist(runId, "w1", quote({ bid: "1e400" }), POLICIES, NOW))).toEqual({ status: "INVALID", reason: "PRICE_NOT_REPRESENTABLE" });
    expect((await store.persist(runId, "w1", quote({ bid: "2650.123456789" }), POLICIES, NOW))).toEqual({ status: "INVALID", reason: "PRICE_NOT_REPRESENTABLE" });
    // The database refuses a crossed quote even if the application did not.
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "GoldShadowQuote" SELECT gen_random_uuid()::text, "runId", "provider", "environment", "instrument", "quoteKind", "providerTimeRaw", "eventTime", "receivedAt", md5('a') || md5('b'), "payloadHash", "ask", "bid", "mid", "spread", "providerTradeable", "sessionState", "qualityVerdict", "qualityReasons", "qualityPolicyHash", "samplingPolicyHash", "bucketStart" + interval '2 hour', false, now() FROM "GoldShadowQuote" LIMIT 1`)).rejects.toThrow(/GoldShadowQuote_prices/);
    expect(parseProviderTime("2026-11-17T15:00:01Z")?.iso).toBe("2026-11-17T15:00:01.000000Z");
    expect(await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T15:00:12.000Z" }), POLICIES, NOW)).toEqual({ status: "INVALID", reason: "FUTURE_EVENT_TIME" });
    expect(await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T15:00:11.000500Z" }), POLICIES, NOW)).toEqual({ status: "INVALID", reason: "FUTURE_EVENT_TIME" });
    expect((await store.persist(runId, "w1", quote({ providerTimeRaw: "2026-11-17T15:00:11.000000Z" }), POLICIES, NOW)).status).toBe("STORED");
  });
});
