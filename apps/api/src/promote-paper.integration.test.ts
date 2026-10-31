import { builtinArtifactIdentity } from "@odin/agent-core";
import {
  buildExperimentReport,
  finaliseEvaluation,
  EVALUATION_PROTOCOLS,
} from "@odin/evolution";
import { DEFAULT_STRATEGY, configHashOf, parseStrategyConfig } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "../../worker/src/stage-runner.js";
import { EvolutionService } from "./evolution.service.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const identity = builtinArtifactIdentity("pulse-momentum-v1")!;

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

async function seedValidatedPromotion(prisma: PrismaClient, entryM5ChangePct: string) {
  const config = parseStrategyConfig({ ...DEFAULT_STRATEGY, entryM5ChangePct });
  const configHash = configHashOf(config);
  const hypothesis = await prisma.researchProposal.create({
    data: {
      status: "PROPOSED",
      parameterPatch: { entryM5ChangePct },
      rationale: "integration fixture hypothesis",
    },
  });
  // artifactHash is unique; later fixtures reuse the same builtin artifact.
  const artifact = await prisma.strategyArtifact.upsert({
    where: { artifactHash: identity.artifactHash },
    update: {},
    create: {
      kind: "BUILTIN_MODULE",
      moduleRef: identity.moduleRef,
      moduleVersion: identity.moduleVersion,
      sourceHash: identity.sourceHash,
      artifactHash: identity.artifactHash,
      runtimeLoadable: true,
      createdBy: "operator@odin.local",
    },
  });
  const executable = {
    kind: "BUILTIN_MODULE" as const,
    moduleRef: identity.moduleRef,
    moduleVersion: identity.moduleVersion,
    sourceHash: identity.sourceHash,
    artifactHash: identity.artifactHash,
    runtimeLoadable: true,
  };
  const evaluation = finaliseEvaluation(
    {
      protocol: EVALUATION_PROTOCOLS.PIPELINE_SANDBOX_V1,
      config,
      configHash,
      dataset: {
        id: "ds_integration",
        hash: "dataset-hash-integration",
        basis: "fixture",
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-31T00:00:00.000Z",
        observationCount: 100,
      },
      partitions: [
        {
          name: "FULL",
          startAt: "2026-01-01T00:00:00.000Z",
          endAt: "2026-01-31T00:00:00.000Z",
          measured: true,
          sampleSize: 40,
          returnPct: "1.50",
          maxDrawdownPct: "4",
        },
        {
          name: "TEST",
          startAt: "2026-01-20T00:00:00.000Z",
          endAt: "2026-01-31T00:00:00.000Z",
          measured: true,
          sampleSize: 30,
          returnPct: "1.10",
          maxDrawdownPct: "3",
        },
      ],
      minSampleSize: 30,
      tuning: {
        parameterTrials: 1,
        tunedOnEvaluationSample: false,
        basis: "single candidate",
        history: [],
      },
      costs: {
        feeBps: config.feeBps,
        slippageModel: "fixture",
        latencyMs: config.paperLatencyMs,
      },
      forwardPaper: {
        status: "RECORDED",
        resultIds: ["fwd_integration_1"],
        closedTradeCount: 30,
        returnPct: "0.80",
      },
    },
    executable,
  );
  const reportPayload = buildExperimentReport({
    reportId: `rpt_integration_m5_${entryM5ChangePct}`,
    hypothesisId: hypothesis.id,
    strategyModuleId: "strat_reviewed",
    strategyVersion: "1.0.0",
    models: [],
    datasetManifest: {
      observationCount: 100,
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-31T00:00:00.000Z",
      sources: ["fixture"],
      contentHash: "dataset-hash-integration",
    },
    periods: { train: null, validation: null, test: "2026-01-20T00:00:00.000Z" },
    results: {
      sampleSize: 40,
      returnPct: "1.50",
      maxDrawdownPct: "4",
      releaseGateLabel: "PROMOTION_REVIEW",
    },
    uncertainty: [],
    weaknesses: [],
    challenge: { passed: true, summary: "ok", findings: [], reviewer: "CHALLENGE", independent: true },
    approval: {
      status: "APPROVED",
      approvedBy: "operator@odin.local",
      approvedAt: "2026-10-28T19:00:00.000Z",
    },
    reproducibility: { codeHash: identity.sourceHash, configHash, seed: null },
    evaluation,
    executable,
  });
  // Persist with id matching reportId so REPORT_SIGNATURE_VALID can check report.reportId === row.id.
  const report = await prisma.experimentReport.create({
    data: {
      id: reportPayload.reportId,
      hypothesisId: hypothesis.id,
      strategyModuleId: reportPayload.strategyModuleId,
      strategyVersion: reportPayload.strategyVersion,
      payload: reportPayload,
      contentHash: reportPayload.contentHash,
      signature: reportPayload.signature,
      approvalStatus: "APPROVED",
      approvedBy: "operator@odin.local",
      approvedAt: new Date("2026-10-28T19:00:00.000Z"),
      provenance: evaluation.provenance,
      sourceHash: identity.sourceHash,
      artifactHash: identity.artifactHash,
      configHash,
      datasetHash: evaluation.dataset.hash,
    },
  });
  // Rebuild with the persisted id if Prisma generated a different one (we forced id above).
  expect(report.id).toBe(reportPayload.reportId);
  const approval = await prisma.promotionApproval.create({
    data: {
      reportId: report.id,
      reportContentHash: report.contentHash,
      artifactId: artifact.id,
      artifactHash: artifact.artifactHash,
      sourceHash: artifact.sourceHash,
      configHash,
      decision: "APPROVED",
      reviewer: "operator@odin.local",
      notes: "integration approval",
    },
  });
  return { config, configHash, hypothesis, artifact, report, approval };
}

describe.skipIf(!enabled)("promoted strategy persisted in PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ForwardPaperResult", "StrategyPromotion", "PromotionApproval", "StrategyArtifact", "ExperimentReport", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User", "TradeMemory", "StrategyInstance", "StrategyAllocation", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
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
    const seeded = await seedValidatedPromotion(prisma, "4");
    const applied = await service.promotePaperStrategy(
      {
        authorised: true,
        reportId: seeded.report.id,
        artifactId: seeded.artifact.id,
        approvalId: seeded.approval.id,
        config: seeded.config,
      },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);
    expect(applied.deploymentEligible).toBe(true);

    const stored = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    const active = stored.activeStrategy as {
      strategyId: string;
      strategyVersion: string;
      sourceHash: string;
      artifactHash: string;
      mode: string;
      deploymentEligible: boolean;
    };
    expect(active.strategyId).toBe("strat_reviewed");
    expect(active.strategyVersion).toBe("1.0.0");
    expect(active.sourceHash).toBe(identity.sourceHash);
    expect(active.artifactHash).toBe(identity.artifactHash);
    expect(active.mode).toBe("VALIDATED");
    expect(active.deploymentEligible).toBe(true);
    expect((stored.config as { entryM5ChangePct: string }).entryM5ChangePct).toBe("4");

    await expect(
      service.promotePaperStrategy(
        {
          authorised: true,
          reportId: "rpt_missing",
          artifactId: seeded.artifact.id,
          config: seeded.config,
        },
        "operator@odin.local",
      ),
    ).rejects.toThrow(/REPORT_PERSISTED|rejected|ExperimentReport/i);

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
  it("refuses promotion while RUNNING and leaves the stored config unchanged (audit C4)", async () => {
    const service = new EvolutionService(prisma);
    const seeded = await seedValidatedPromotion(prisma, "6");
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING" } });
    const before = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    const promotionsBefore = await prisma.strategyPromotion.count();
    await expect(
      service.promotePaperStrategy(
        { authorised: true, reportId: seeded.report.id, artifactId: seeded.artifact.id, approvalId: seeded.approval.id, config: seeded.config },
        "operator@odin.local",
      ),
    ).rejects.toThrow(/RUNNING/);
    const after = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    expect(after.config).toEqual(before.config);
    expect(after.activeStrategy).toEqual(before.activeStrategy);
    expect(await prisma.strategyPromotion.count()).toBe(promotionsBefore);
  });
  it("serialises concurrent promotions so the previousPromotionId chain stays consistent (audit C4)", async () => {
    const service = new EvolutionService(prisma);
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "PAUSED" } });
    const first = await seedValidatedPromotion(prisma, "7");
    const second = await seedValidatedPromotion(prisma, "8");
    const latestBefore = await prisma.strategyPromotion.findFirst({ orderBy: { createdAt: "desc" } });
    const promote = (seeded: Awaited<ReturnType<typeof seedValidatedPromotion>>) =>
      service.promotePaperStrategy(
        { authorised: true, reportId: seeded.report.id, artifactId: seeded.artifact.id, approvalId: seeded.approval.id, config: seeded.config },
        "operator@odin.local",
      );
    const results = await Promise.allSettled([promote(first), promote(second)]);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const created = await prisma.strategyPromotion.findMany({
      where: { createdAt: { gt: latestBefore?.createdAt ?? new Date(0) } },
      orderBy: { createdAt: "asc" },
    });
    expect(created).toHaveLength(succeeded.length);
    // Each promotion points at the one written immediately before it: no two share a predecessor.
    expect(created[0]?.previousPromotionId).toBe(latestBefore?.id ?? null);
    for (let index = 1; index < created.length; index += 1) {
      expect(created[index]?.previousPromotionId).toBe(created[index - 1]?.id);
    }
    const engine = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    const lastConfig = created.at(-1)?.config as { entryM5ChangePct: string };
    expect((engine.config as { entryM5ChangePct: string }).entryM5ChangePct).toBe(lastConfig.entryM5ChangePct);
  });
});
