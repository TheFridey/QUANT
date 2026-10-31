/**
 * §29 Real DB/worker paper lifecycle — no mocks for settlement/DB.
 * Ingest → pulse → plan → executor commit → fill → strategy allocation settle → ledger cash.
 */
import { DEFAULT_STRATEGY, d, INTEGRATION_TEST_ADVISORY_LOCK } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const solanaConfig = {
  ...DEFAULT_STRATEGY,
  multiMarketPaperIngest: false,
  paperLatencyMs: 0,
  entryM5ChangePct: "1",
  minH1ChangePct: "0",
  allowDemoPaperEntries: true,
};

describe.skipIf(!enabled)("paper lifecycle worker+DB (no mocks)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "StrategyAllocation", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState", "TradeMemory" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config: solanaConfig,
    });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: "RUNNING", config: toJson(solanaConfig) },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("attributed instance entry settles fill + StrategyAllocation and ledger cash", async () => {
    await prisma.cycleRun.updateMany({
      where: { status: "RUNNING" },
      data: { status: "FAILED", error: "TEST_RESET", finishedAt: new Date() },
    });

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
              raw: { fixture: "paper-lifecycle" },
            },
          ],
        };
      },
    };

    const before = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "paper-lifecycle" });
    expect(ingested.skipped).toBe(false);
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);
    await runner.archivist(ingested.cycleId);

    const fills = await prisma.fill.findMany({ where: { order: { cycleId: ingested.cycleId } } });
    expect(fills.length).toBeGreaterThanOrEqual(1);

    const order = await prisma.order.findFirstOrThrow({
      where: { cycleId: ingested.cycleId, status: "FILLED", side: "BUY" },
    });
    expect(order.strategyInstanceId).toBeTruthy();

    const alloc = await prisma.strategyAllocation.findFirst({
      where: {
        accountId: "primary",
        strategyInstanceId: order.strategyInstanceId!,
        pairAddress,
      },
    });
    expect(alloc).toBeTruthy();
    expect(d(alloc!.qty.toString()).gt(0)).toBe(true);

    const after = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    expect(d(after.cashUsd.toString()).lt(d(before.cashUsd.toString()))).toBe(true);
    const lines = await prisma.ledgerEntry.findMany({ where: { accountId: "primary" } });
    const summed = lines
      .filter((line) => line.affectsCash)
      .reduce((total, line) => total.plus(d(line.amountUsd.toString())), d("0"));
    expect(summed.eq(d(after.cashUsd.toString()))).toBe(true);
  });
});
