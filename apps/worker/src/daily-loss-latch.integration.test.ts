import { DEFAULT_STRATEGY, startOfLondonDay } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const solanaOnlyConfig = { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs: 0 };

const feed: MarketFeed = {
  security: passingSecuritySource,
  async fetchUniverse() {
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      data: [
        {
          source: "dexscreener",
          chainId: "solana",
          pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
          dexId: "orca",
          url: "https://dexscreener.com/solana/Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
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
          raw: { fixture: "daily-loss-latch" },
        },
      ],
    };
  },
};

/**
 * ASCEND-00 F1 through the real worker cycle and Postgres: an account that breached -3% earlier in
 * the London day and has since recovered to -2.90% stays blocked from new entries, across a fresh
 * StageRunner (worker restart), until the session rolls at the next London midnight.
 */
describe.skipIf(!enabled)("daily-loss latch (worker + Postgres)", () => {
  let prisma: PrismaClient;

  async function runCycle() {
    await prisma.cycleRun.updateMany({
      where: { status: "RUNNING" },
      data: { status: "FAILED", error: "TEST_RESET", finishedAt: new Date() },
    });
    // A fresh runner per cycle: nothing carries over in memory, as after a worker restart.
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "test" });
    expect(ingested.skipped).toBe(false);
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);
    await runner.archivist(ingested.cycleId);
    return ingested.cycleId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config: solanaOnlyConfig,
    });
    // Resumed by the operator after the breach.
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: "RUNNING", config: toJson(solanaOnlyConfig), updatedBy: "operator: resume entries" },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("keeps entries blocked the same London day after a recovery, across worker restarts", async () => {
    await prisma.paperAccount.update({
      where: { id: "primary" },
      data: {
        cashUsd: "9710",
        sessionStartedAt: startOfLondonDay(new Date()),
        sessionStartEquityUsd: "10000",
        sessionLowEquityUsd: "9679.11",
        highWaterMarkUsd: "10000",
      },
    });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const cycleId = await runCycle();
      const breaker = await prisma.agentDecision.findMany({
        where: { cycleId, agent: "ATLAS", reasonCodes: { has: "CIRCUIT_BREAKER" } },
      });
      expect(breaker.length).toBeGreaterThan(0);
    }
    expect(await prisma.order.count({ where: { side: "BUY" } })).toBe(0);
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    expect(account.sessionLowEquityUsd?.toString()).toBe("9679.11");
    expect(account.sessionStartEquityUsd?.toString()).toBe("10000");
  });

  it("control: the same book with no breach earlier in the day trades, and the session low is written atomically", async () => {
    await prisma.paperAccount.update({
      where: { id: "primary" },
      data: {
        cashUsd: "9710",
        sessionStartedAt: startOfLondonDay(new Date()),
        sessionStartEquityUsd: "10000",
        // Unset within the day: the worker must start it through the session-scoped LEAST write.
        sessionLowEquityUsd: null,
        highWaterMarkUsd: "10000",
      },
    });
    await runCycle();
    expect(await prisma.fill.count({ where: { side: "BUY" } })).toBe(1);
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    // Written (it was null) and at most $9,710; the entry's fees and slippage may lower it further.
    const low = Number(account.sessionLowEquityUsd?.toString());
    expect(low).toBeLessThanOrEqual(9710);
    expect(low).toBeGreaterThan(9690);
  });

  it("lifts the latch at the next London day and resets the session low to that day's equity", async () => {
    const yesterday = new Date(startOfLondonDay(new Date()).getTime() - 12 * 3_600_000);
    await prisma.paperAccount.update({
      where: { id: "primary" },
      data: {
        cashUsd: "9679.11",
        sessionStartedAt: startOfLondonDay(yesterday),
        sessionStartEquityUsd: "10000",
        sessionLowEquityUsd: "9679.11",
        highWaterMarkUsd: "10000",
      },
    });
    await runCycle();
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    expect(account.sessionStartedAt?.getTime()).toBe(startOfLondonDay(new Date()).getTime());
    expect(account.sessionStartEquityUsd?.toString()).toBe("9679.11");
    expect(await prisma.fill.count({ where: { side: "BUY" } })).toBe(1);
  });
});
