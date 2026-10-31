import { DEFAULT_STRATEGY, d, newId, SAFETY_CODES } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import {
  activateSafetyState,
  isEntriesSuspended,
  lockAccount,
  settlePendingOrder,
} from "@odin/trading-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

function livePair(priceUsd: string) {
  return {
    source: "dexscreener" as const,
    chainId: "solana" as const,
    pairAddress,
    dexId: "orca",
    url: `https://dexscreener.com/solana/${pairAddress}`,
    baseAddress: "So11111111111111111111111111111111111111112",
    baseSymbol: "SOL",
    baseName: "Wrapped SOL",
    quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteSymbol: "USDC",
    priceUsd,
    liquidityUsd: "1000000",
    volume24hUsd: "5000000",
    volume5mUsd: "10000",
    priceChangeM5Pct: "3.5",
    priceChangeH1Pct: "1.2",
    priceChangeH24Pct: "4",
    txnsM5Buys: 80,
    txnsM5Sells: 20,
    raw: { fixture: "release1" },
  };
}

describe.skipIf(!enabled)("release1 executor regressions", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config: { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, marketDataPaperFxIngest: true, paperLatencyMs: 0 },
    });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: {
        status: "RUNNING",
        config: toJson({
          ...DEFAULT_STRATEGY,
          // Same-cycle fill mechanics: latency 0 (the 1 s default defers fills to the next cycle).
          paperLatencyMs: 0,
          multiMarketPaperIngest: false,
          marketDataPaperFxIngest: true,
          tradingEnvironment: "MARKET_DATA_PAPER",
        }),
      },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("R01: filled entry arms lifecycle-scoped protection", async () => {
    const feed: MarketFeed = {
      security: passingSecuritySource,
      async fetchUniverse() {
        return { ok: true, fetchedAt: new Date().toISOString(), data: [livePair("100")] };
      },
    };
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "r01" });
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);

    const position = await prisma.position.findFirst({
      where: { accountId: "primary", pairAddress, baseQty: { gt: 0 } },
    });
    expect(position?.lifecycleId).toBeTruthy();
    const armed = await prisma.protectionOrder.findMany({
      where: {
        accountId: "primary",
        lifecycleId: position!.lifecycleId!,
        status: "ARMED",
      },
    });
    expect(armed.some((leg) => leg.kind === "STOP")).toBe(true);
  });

  it("R06: alert ACK leaves ENTRIES_SUSPENDED safety active for admission", async () => {
    await activateSafetyState(prisma, {
      accountId: "primary",
      code: SAFETY_CODES.ENTRIES_SUSPENDED,
      detail: { test: true },
    });
    const alert = await prisma.durableAlert.create({
      data: {
        accountId: "primary",
        severity: "CRITICAL",
        code: SAFETY_CODES.ENTRIES_SUSPENDED,
        message: "test",
        acked: false,
      },
    });
    await prisma.durableAlert.update({
      where: { id: alert.id },
      data: { acked: true, ackedAt: new Date() },
    });
    expect(await isEntriesSuspended(prisma, "primary")).toBe(true);

    const feed: MarketFeed = {
      security: passingSecuritySource,
      async fetchUniverse() {
        return { ok: true, fetchedAt: new Date().toISOString(), data: [livePair("120")] };
      },
    };
    const beforeOrders = await prisma.order.count({
      where: { accountId: "primary", status: "FILLED", side: "BUY" },
    });
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "r06" });
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);
    const afterOrders = await prisma.order.count({
      where: { accountId: "primary", status: "FILLED", side: "BUY" },
    });
    // Suspension blocks new entries; filled count must not increase from new admissions.
    expect(afterOrders).toBe(beforeOrders);
  });

  it("R05: pending BUY suppress same-symbol re-admission after settle refresh", async () => {
    // Clear suspension from prior test via resolve path simulation.
    await prisma.accountSafetyState.updateMany({
      where: { accountId: "primary", code: SAFETY_CODES.ENTRIES_SUSPENDED },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });

    const now = new Date();
    const eligibleAt = new Date(now.getTime() + 60_000);
    const obs = await prisma.marketObservation.findFirst({
      where: { pairAddress, priceUsd: { not: null } },
      orderBy: { receivedAt: "desc" },
    });
    expect(obs).toBeTruthy();
    const clientOrderId = newId("pend");
    await prisma.order.create({
      data: {
        clientOrderId,
        cycleId: "pending_seed",
        accountId: "primary",
        pairAddress,
        baseSymbol: "SOL",
        side: "BUY",
        intent: "ENTRY",
        status: "PENDING",
        qty: "1",
        observationId: obs!.id,
        decisionObservationId: obs!.id,
        reasonCodes: ["ORDER_PENDING"],
        submittedAt: now,
        eligibleAt,
        expiresAt: new Date(eligibleAt.getTime() + 60_000),
      },
    });

    // Settle is not yet eligible — executor should suppress duplicate same-symbol proposal.
    const feed: MarketFeed = {
      security: passingSecuritySource,
      async fetchUniverse() {
        return { ok: true, fetchedAt: new Date().toISOString(), data: [livePair("130")] };
      },
    };
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => now);
    const ingested = await runner.ingest({ trigger: "r05" });
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);

    const pendingSame = await prisma.order.count({
      where: { accountId: "primary", pairAddress, status: "PENDING", side: "BUY" },
    });
    expect(pendingSame).toBe(1);

    // Direct settle path still works when eligibility arrives with a newer mark.
    const later = new Date(eligibleAt.getTime() + 1_000);
    await prisma.marketObservation.create({
      data: {
        ingestJobId: "cyc_r05_fill",
        source: "dexscreener",
        chainId: "solana",
        pairAddress,
        dexId: "orca",
        baseAddress: "So11111111111111111111111111111111111111112",
        baseSymbol: "SOL",
        baseName: "Wrapped SOL",
        quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        quoteSymbol: "USDC",
        priceUsd: "140",
        liquidityUsd: "1000000",
        freshness: "LIVE",
        dataOrigin: "LIVE_FEED",
        tradingEnvironment: "MARKET_DATA_PAPER",
        receivedAt: later,
        eventTime: later,
        raw: {},
      },
    });
    const settled = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      const row = await tx.order.findUniqueOrThrow({ where: { clientOrderId } });
      return settlePendingOrder(tx, {
        accountId: "primary",
        orderId: row.id,
        config: DEFAULT_STRATEGY,
        mode: "live",
        now: later,
        tradingEnvironment: "MARKET_DATA_PAPER",
      });
    });
    expect(settled.status).toBe("FILLED");
    const fill = await prisma.fill.findFirst({
      where: { order: { clientOrderId } },
    });
    expect(d(fill!.priceUsd.toString()).gte("135")).toBe(true);
  });
});
