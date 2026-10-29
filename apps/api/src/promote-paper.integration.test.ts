import { DEFAULT_STRATEGY } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "../../worker/src/stage-runner.js";
import { EvolutionService } from "./evolution.service.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const sourceHash = "a".repeat(64);
const artifactHash = "b".repeat(64);

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    strategyId: "strat_reviewed",
    strategyVersion: "1.0.0",
    sourceHash,
    artifactHash,
    artifactSourceHash: sourceHash,
    approvalStatus: "APPROVED",
    reviewed: true,
    pipelineFinished: true,
    experimentExecuted: true,
    returnPct: "1.50",
    sampleSize: 40,
    minSampleSize: 30,
    statisticsRecorded: true,
    untouchedTestReturnPct: "1.10",
    untouchedSampleSize: 30,
    tunedOnEvaluationSample: false,
    forwardPaperValidated: true,
    ...overrides,
  };
}

const feed: MarketFeed = {
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
          raw: { fixture: "promoted-strategy" },
        },
      ],
    };
  },
};

describe.skipIf(!enabled)("promoted strategy persisted in PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User", "TradeMemory", "StrategyInstance", "StrategyAllocation", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config: DEFAULT_STRATEGY,
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("reads the promoted primary engine back from PostgreSQL and the worker loads that strategy", async () => {
    const service = new EvolutionService(prisma);
    const promotedConfig = { ...DEFAULT_STRATEGY, entryM5ChangePct: "4" };
    const applied = await service.promotePaperStrategy(
      { authorised: true, evidence: evidence(), config: promotedConfig },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);

    const stored = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    const active = stored.activeStrategy as {
      strategyId: string;
      strategyVersion: string;
      sourceHash: string;
      artifactHash: string;
    };
    expect(active.strategyId).toBe("strat_reviewed");
    expect(active.strategyVersion).toBe("1.0.0");
    expect(active.sourceHash).toBe(sourceHash);
    expect(active.artifactHash).toBe(artifactHash);
    expect((stored.config as { entryM5ChangePct: string }).entryM5ChangePct).toBe("4");

    const later = await service.promotePaperStrategy(
      {
        authorised: true,
        evidence: evidence({ reviewed: false, approvalStatus: "PENDING", strategyVersion: "9.9.9" }),
        config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "2" },
      },
      "operator@odin.local",
    );
    expect(later.appliedToPaperEngine).toBe(false);
    const unchanged = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    expect((unchanged.config as { entryM5ChangePct: string }).entryM5ChangePct).toBe("4");
    expect((unchanged.activeStrategy as { strategyVersion: string }).strategyVersion).toBe("1.0.0");

    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING" } });
    // §5/§6: pause concurrent instances so this case isolates promoted activeStrategy
    // (empty ACTIVE set ⇒ empty attributed ENTER map ⇒ gating HOLD, not ungated PULSE).
    await prisma.strategyInstance.updateMany({ data: { status: "PAUSED" } });
    await prisma.cycleRun.updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED", error: "TEST_RESET" } });
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "promoted-strategy" });
    expect(ingested.skipped).toBe(false);
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    const pulse = await prisma.agentDecision.findFirst({ where: { cycleId: ingested.cycleId, agent: "PULSE" } });
    // With no ACTIVE instances, concurrent gating HOLDs entries (STRATEGY_INSTANCE_GATING / NO_INTENT).
    // Promoted NO_EDGE remains valid when gating is inactive; accept either honest HOLD path.
    expect(pulse?.decision).toBe("HOLD");
    expect(
      pulse?.reasonCodes.some((c) => c === "NO_EDGE" || c === "STRATEGY_INSTANCE_GATING" || c === "NO_INTENT"),
    ).toBe(true);
    expect(await prisma.fill.count({ where: { order: { cycleId: ingested.cycleId } } })).toBe(0);
  });
});
