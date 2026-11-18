import { DEFAULT_GOLD_SHADOW_CONFIG, GoldShadowFeed, parseOandaPricing } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GoldShadowTicker, goldShadowPolicies } from "./shadow-job.js";
import { GoldShadowStore } from "./shadow-store.js";

/**
 * HELIOS end to end without the network: the real GoldShadowFeed (with a stubbed practice pricing response in
 * OANDA's shape) and the real store on a disposable database.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

describe.skipIf(!enabled)("gold shadow ingestion end to end (disposable database)", () => {
  let prisma: PrismaClient;
  let clock = new Date("2026-11-17T15:00:10.000Z"); // Tuesday, metals session open
  let row = { time: "2026-11-17T15:00:09.876543210Z", bid: "2650.120", ask: "2650.430" };

  const pricing = async () => ({
    ok: true as const,
    fetchedAt: clock.toISOString(),
    data: parseOandaPricing({ prices: [{ instrument: "XAU_USD", time: row.time, bids: [{ price: row.bid, liquidity: 1 }], asks: [{ price: row.ask, liquidity: 1 }], tradeable: true }] }, clock)!,
  });
  const make = (owner: string) => {
    const feed = new GoldShadowFeed({ ...DEFAULT_GOLD_SHADOW_CONFIG, enabled: true, minPollIntervalMs: 1_000 }, { pricing, now: () => clock });
    return new GoldShadowTicker(feed, new GoldShadowStore(prisma), { owner, leaseMs: 60_000, policies: goldShadowPolicies({}), configHash: "a".repeat(64), now: () => clock });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "GoldShadowQuote" DISABLE TRIGGER USER`);
    await prisma.$executeRawUnsafe(`TRUNCATE "GoldShadowSamplingBucket", "GoldShadowQuote", "GoldShadowIngestRun"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "GoldShadowQuote" ENABLE TRIGGER USER`);
    clock = new Date("2026-11-17T15:00:10.000Z");
    row = { time: "2026-11-17T15:00:09.876543210Z", bid: "2650.120", ask: "2650.430" };
  });
  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("stores one quote per bucket with the nanosecond provider time; a restarted worker adds nothing", async () => {
    const a = make("w1");
    expect(await a.tick()).toMatchObject({ poll: "ACCEPTED", persisted: "STORED" });
    // Same response 2 s later: the feed sees a duplicate event and nothing is stored.
    clock = new Date(clock.getTime() + 2_000);
    expect(await a.tick()).toMatchObject({ poll: "DUPLICATE" });
    // A new event in the same 15 s bucket: suppressed by the store.
    row = { time: "2026-11-17T15:00:11.000000001Z", bid: "2650.200", ask: "2650.500" };
    clock = new Date(clock.getTime() + 1_500);
    expect(await a.tick()).toMatchObject({ poll: "ACCEPTED", persisted: "SUPPRESSED_SAME_BUCKET" });
    // Restart: a new process with a fresh in-memory feed sees the stored event again; the store refuses it.
    row = { time: "2026-11-17T15:00:09.876543210Z", bid: "2650.120", ask: "2650.430" };
    const b = make("w1");
    expect(await b.tick()).toMatchObject({ poll: "ACCEPTED", persisted: "DUPLICATE" });
    const quotes = await prisma.goldShadowQuote.findMany();
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ providerTimeRaw: "2026-11-17T15:00:09.876543210Z", executionEligible: false, sessionState: "OPEN", qualityVerdict: "ACCEPTED" });
    expect(quotes[0]!.spread.toFixed(2)).toBe("0.31");
  });

  it("a second worker cannot ingest while the first holds the lease", async () => {
    expect(await make("w1").tick()).toMatchObject({ persisted: "STORED" });
    expect(await make("w2").tick()).toEqual({ status: "NO_LEASE", reason: "LEASE_HELD" });
    expect(await prisma.goldShadowQuote.count()).toBe(1);
  });
});
