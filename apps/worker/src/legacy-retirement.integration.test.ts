import { DEFAULT_STRATEGY } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { legacyRetirementFromEnv } from "./legacy-retirement.js";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";

/**
 * CATALYST: legacy crypto retirement through the real stage runner on a disposable database.
 * RETIRED must not call discovery, must not open entries, must cancel queued entries, must not write a
 * permanent REJECT decision per empty cycle, and must leave the account's money and history untouched.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

let clock = new Date();
let discoveryCalls = 0;

const feed: MarketFeed = {
  security: passingSecuritySource,
  async fetchUniverse() {
    discoveryCalls += 1;
    return {
      ok: true,
      fetchedAt: clock.toISOString(),
      data: [
        {
          source: "dexscreener",
          chainId: "solana",
          pairAddress,
          dexId: "orca",
          url: `https://dexscreener.com/solana/${pairAddress}`,
          baseAddress: "So11111111111111111111111111111111111111112",
          baseSymbol: "SOL",
          baseName: "Wrapped SOL",
          quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          quoteSymbol: "USDC",
          priceUsd: "100",
          liquidityUsd: "1000000",
          volume24hUsd: "5000000",
          volume5mUsd: "10000",
          priceChangeM5Pct: "3.5",
          priceChangeH1Pct: "1.2",
          priceChangeH24Pct: "4",
          txnsM5Buys: 80,
          txnsM5Sells: 20,
          raw: { fixture: "legacy-retirement" },
        },
      ],
    };
  },
};

const RETIRED = legacyRetirementFromEnv({ LEGACY_CRYPTO_MODE: "RETIRED" });
const ACTIVE = legacyRetirementFromEnv({});

describe.skipIf(!enabled)("legacy crypto retirement (database)", () => {
  let prisma: PrismaClient;

  async function reset(paperLatencyMs: number) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "CycleRun", "CyclePlan", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
    );
    const config = { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs };
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING", config: toJson(config) } });
  }

  async function runCycle(legacy = RETIRED, advanceMs = 60_000) {
    await prisma.cycleRun.updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED", error: "TEST_RESET" } });
    clock = new Date(clock.getTime() + advanceMs);
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => clock, legacy);
    const { cycleId, skipped } = await runner.ingest({ trigger: "legacy-retirement" });
    expect(skipped).toBe(false);
    await runner.sentinel(cycleId);
    await runner.pulse(cycleId);
    await runner.aegis(cycleId);
    await runner.atlas(cycleId);
    await runner.executor(cycleId);
    return cycleId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });

  beforeEach(() => {
    discoveryCalls = 0;
    clock = new Date();
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("ACTIVE (the default) still discovers and enters: behaviour unchanged", async () => {
    await reset(0);
    const cycleId = await runCycle(ACTIVE);
    expect(discoveryCalls).toBe(1);
    expect(await prisma.order.count({ where: { cycleId, side: "BUY" } })).toBeGreaterThan(0);
  });

  it("RETIRED on a flat book: no discovery, no entries, no observations, no permanent REJECT row", async () => {
    await reset(0);
    const accountBefore = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    const cycleId = await runCycle(RETIRED);
    expect(discoveryCalls).toBe(0);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.marketObservation.count({ where: { ingestJobId: cycleId } })).toBe(0);
    // An empty retired cycle is the expected state, not an error (it would otherwise show as a system error).
    const cycle = await prisma.cycleRun.findUniqueOrThrow({ where: { id: cycleId } });
    expect(cycle.error).toBeNull();
    const decisions = await prisma.agentDecision.findMany({ where: { cycleId } });
    expect(decisions.filter((d) => d.reasonCodes.includes("EMPTY_UNIVERSE"))).toEqual([]);
    const accountAfter = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    expect(accountAfter.cashUsd.toString()).toBe(accountBefore.cashUsd.toString());
    // The stored config is never rewritten: the pause is applied at read time only.
    const stored = (await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } })).config as { pauseNewEntries?: boolean };
    expect(stored.pauseNewEntries).toBe(false);
  });

  it("RETIRED cancels a queued entry, keeps the history, and does not touch cash", async () => {
    // The maximum valid paper latency (60 s) leaves the ACTIVE cycle's BUY pending; the retired cycle runs 30 s later.
    await reset(60_000);
    const activeCycle = await runCycle(ACTIVE);
    const pending = await prisma.order.findMany({ where: { cycleId: activeCycle, side: "BUY", status: "PENDING" } });
    expect(pending.length).toBeGreaterThan(0);
    const cashBefore = (await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } })).cashUsd.toString();
    const decisionsBefore = await prisma.agentDecision.count();
    const observationsBefore = await prisma.marketObservation.count();

    discoveryCalls = 0;
    const retiredCycle = await runCycle(RETIRED, 30_000);
    expect(discoveryCalls).toBe(0);
    for (const row of pending) {
      const after = await prisma.order.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject({ status: "CANCELLED", rejectReason: "ENGINE_HALTED" });
    }
    expect(await prisma.order.count({ where: { cycleId: retiredCycle, side: "BUY" } })).toBe(0);
    expect(await prisma.fill.count()).toBe(0);
    expect((await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } })).cashUsd.toString()).toBe(cashBefore);
    // Nothing historical was deleted.
    expect(await prisma.agentDecision.count()).toBeGreaterThanOrEqual(decisionsBefore);
    expect(await prisma.marketObservation.count()).toBeGreaterThanOrEqual(observationsBefore);
    expect(await prisma.order.count({ where: { cycleId: activeCycle } })).toBe(pending.length + (await prisma.order.count({ where: { cycleId: activeCycle, side: { not: "BUY" } } })));

    // Reversal: ACTIVE again discovers and may enter.
    discoveryCalls = 0;
    await runCycle(ACTIVE);
    expect(discoveryCalls).toBe(1);
  });

  it("RETIRED with an open position: held marks still refresh without discovery and the exit still fills", async () => {
    await reset(0);
    // Held-mark refresh calls DexScreener directly (held-refresh.ts). Serve it from a controlled price and
    // refuse every other outbound request, so the test needs no network.
    let heldPrice = "100";
    const original = globalThis.fetch;
    const heldShape = () => ({
      chainId: "solana",
      dexId: "orca",
      url: `https://dexscreener.com/solana/${pairAddress}`,
      pairAddress,
      baseToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
      quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin", symbol: "USDC" },
      priceUsd: heldPrice,
      liquidity: { usd: 1_000_000 },
      volume: { h24: 5_000_000, m5: 10_000 },
      priceChange: { m5: 0, h1: 0, h24: 0 },
      txns: { m5: { buys: 50, sells: 50 } },
      pairCreatedAt: Date.parse("2025-01-01T00:00:00Z"),
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return original(input as never);
      if (url.hostname === "api.dexscreener.com") {
        if (url.pathname.startsWith("/latest/dex/pairs/solana/")) return Response.json({ pairs: [heldShape()] });
        if (url.pathname.startsWith("/tokens/v1/solana/")) return Response.json([heldShape()]);
      }
      throw new TypeError(`network disabled in test: ${url.host}`);
    }) as typeof fetch;
    try {
      // ACTIVE: enter, then settle the entry into a position.
      for (let i = 0; i < 3 && (await prisma.position.count({ where: { pairAddress } })) === 0; i++) await runCycle(ACTIVE);
      const opened = await prisma.position.findFirst({ where: { pairAddress } });
      expect(opened, "fixture must open a position under ACTIVE").not.toBeNull();
      expect(Number(opened!.baseQty)).toBeGreaterThan(0);

      // RETIRED: the price halves. No discovery; the held mark must still arrive and the stop must still fire.
      heldPrice = "50";
      discoveryCalls = 0;
      let sold = 0;
      let heldObserved = 0;
      for (let i = 0; i < 4 && sold === 0; i++) {
        const cycleId = await runCycle(RETIRED);
        heldObserved += await prisma.marketObservation.count({ where: { ingestJobId: cycleId, pairAddress, priceUsd: "50" } });
        sold = await prisma.order.count({ where: { pairAddress, side: "SELL", status: "FILLED" } });
      }
      expect(discoveryCalls).toBe(0);
      expect(heldObserved).toBeGreaterThan(0);
      expect(sold).toBeGreaterThan(0);
      // No new entry while retired.
      expect(await prisma.order.count({ where: { side: "BUY", createdAt: { gt: opened!.updatedAt } } })).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
