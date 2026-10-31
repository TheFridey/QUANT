/**
 * Operation Autonomy — full automatic paper lifecycle through the real StageRunner and DB:
 * BUY → FILL → PROTECTED POSITION → automatic SELL (take-profit) → settlement → performance,
 * plus an unsafe (mint-authority) token that is rejected before any order exists.
 * This proves machinery correctness on a scripted price path (FIXTURE-shaped data injected
 * through the feed seam), not strategy profitability, and it is never real-data trading evidence.
 */
import { DEFAULT_STRATEGY, d, INTEGRATION_TEST_ADVISORY_LOCK, type NormalizedPair } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed, type OnChainSecuritySource } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

// Synthetic pair address: a real one would let the held-mark refresh fetch a live price mid-test.
const solPair = "AutonomyTestPair1111111111111111111111111111";
const riskyPair = "RiskyPair11111111111111111111111111111111111";
const riskyMint = "RiskyMint11111111111111111111111111111111111";
const config = {
  ...DEFAULT_STRATEGY,
  multiMarketPaperIngest: false,
  paperLatencyMs: 0,
};

function pair(overrides: Partial<NormalizedPair>): NormalizedPair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress: solPair,
    dexId: "orca",
    url: null,
    baseAddress: "So11111111111111111111111111111111111111112",
    baseSymbol: "SOL",
    baseName: "Wrapped SOL",
    quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteSymbol: "USDC",
    priceUsd: "100",
    liquidityUsd: "25000000",
    volume24hUsd: "60000000",
    volume5mUsd: "400000",
    priceChangeM5Pct: "3.5",
    priceChangeH1Pct: "1.2",
    priceChangeH24Pct: "2",
    txnsM5Buys: 120,
    txnsM5Sells: 40,
    raw: { fixture: "autonomy-lifecycle" },
    ...overrides,
  };
}

/** The risky mint keeps an active mint authority on-chain; everything else reads clean. */
const securitySource: OnChainSecuritySource = {
  async getMint(mint) {
    const result = await passingSecuritySource.getMint(mint);
    if (!result.ok || mint !== riskyMint) return result;
    return { ...result, data: { ...result.data, mintAuthority: "MintAuth1111111111111111111111111111111111" } };
  },
  getTopHolderConcentration: passingSecuritySource.getTopHolderConcentration,
};

describe.skipIf(!enabled)("autonomous paper lifecycle worker+DB", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState", "TradeMemory" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config,
    });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: "RUNNING", config: toJson(config) },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  async function runCycle(pairs: NormalizedPair[], at: Date, trigger: string): Promise<string> {
    const feed: MarketFeed = {
      security: securitySource,
      async fetchUniverse() {
        return { ok: true, fetchedAt: at.toISOString(), data: pairs };
      },
    };
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => at);
    const ingested = await runner.ingest({ trigger });
    expect(ingested.skipped).toBe(false);
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);
    await runner.archivist(ingested.cycleId);
    return ingested.cycleId;
  }

  it("enters, protects, exits on take-profit, settles and reports — and rejects the unsafe token", async () => {
    const start = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    const t0 = new Date();
    const risky = pair({
      pairAddress: riskyPair,
      baseAddress: riskyMint,
      baseSymbol: "RISK",
      baseName: "Risky",
      priceUsd: "2",
      priceChangeM5Pct: "4",
    });

    // Cycle 1: both pairs show the same momentum; only the authority-free mint may be bought.
    const entryCycle = await runCycle([pair({}), risky], t0, "autonomy-entry");
    const buy = await prisma.order.findFirstOrThrow({ where: { cycleId: entryCycle, side: "BUY", status: "FILLED" } });
    expect(buy.pairAddress).toBe(solPair);
    expect(buy.strategyInstanceId).toBeTruthy();
    expect(await prisma.order.count({ where: { pairAddress: riskyPair } })).toBe(0);
    const riskyAssessment = await prisma.securityAssessment.findUniqueOrThrow({ where: { tokenAddress: riskyMint } });
    expect(riskyAssessment.category).toBe("REVIEW");
    expect(riskyAssessment.reasonCodes).toContain("MINT_AUTHORITY_PRESENT");
    expect(riskyAssessment.source).toBe("solana_rpc");

    const opened = await prisma.position.findUniqueOrThrow({
      where: { accountId_pairAddress: { accountId: "primary", pairAddress: solPair } },
    });
    expect(d(opened.baseQty.toString()).gt(0)).toBe(true);
    const armed = await prisma.protectionOrder.findMany({
      where: { accountId: "primary", lifecycleId: opened.lifecycleId!, status: "ARMED" },
    });
    expect(armed.some((leg) => leg.kind === "STOP")).toBe(true);

    // Cycle 2: price rises beyond takeProfitPct (DEFAULT 5%) — the system exits on its own.
    const exitPrice = d("100").mul(d(config.takeProfitPct).div(100).plus(1)).plus(1).toFixed(2);
    const exitCycle = await runCycle(
      [pair({ priceUsd: exitPrice, priceChangeM5Pct: "0.5" })],
      new Date(t0.getTime() + 60_000),
      "autonomy-exit",
    );
    const sell = await prisma.order.findFirstOrThrow({ where: { pairAddress: solPair, side: "SELL", status: "FILLED" } });
    expect(sell.cycleId).toBe(exitCycle);

    const closed = await prisma.position.findUniqueOrThrow({
      where: { accountId_pairAddress: { accountId: "primary", pairAddress: solPair } },
    });
    expect(d(closed.baseQty.toString()).eq(0)).toBe(true);
    expect(d(closed.realizedPnlUsd.toString()).gt(0)).toBe(true);
    const leftArmed = await prisma.protectionOrder.count({
      where: { accountId: "primary", lifecycleId: opened.lifecycleId!, status: "ARMED" },
    });
    expect(leftArmed).toBe(0);

    // Settlement reconciles: cash equals the sum of cash-affecting ledger lines, and the round
    // trip's cash change equals realised P&L net of fees.
    const end = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    const lines = await prisma.ledgerEntry.findMany({ where: { accountId: "primary" } });
    const ledgerCash = lines
      .filter((line) => line.affectsCash)
      .reduce((total, line) => total.plus(d(line.amountUsd.toString())), d("0"));
    expect(ledgerCash.eq(d(end.cashUsd.toString()))).toBe(true);
    expect(d(end.cashUsd.toString()).gt(d(start.cashUsd.toString()))).toBe(true);

    const snapshot = await prisma.equitySnapshot.findFirstOrThrow({
      where: { cycleId: exitCycle },
      orderBy: { createdAt: "desc" },
    });
    const metrics = snapshot.metrics as { closedTrades?: number; wins?: number };
    expect(metrics.closedTrades).toBe(1);
    expect(metrics.wins).toBe(1);
  });
});
