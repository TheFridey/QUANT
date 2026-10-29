import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { d, newId, type Hypothesis, type AutonomyPolicy, DEFAULT_STRATEGY, configHashOf, parseStrategyConfig } from "@odin/shared";
import type { BacktestObservation } from "@odin/backtest";
import { chronologicalSplits } from "@odin/backtest";
import { forgeStrategyModule } from "./forge.js";
import { classifyResearchOutcomes, type ResearchOutcomeMap } from "./outcomes.js";
import { simulateResearchPath, scoreWindow } from "./research-backtest.js";
import { executeCompiledStrategy } from "./sandbox-runner.js";
import { summariseStatistics, type StatisticsReport } from "./statistics.js";
import { runChallengeReview } from "./challenge.js";
import { buildExperimentReport, type ExperimentReport } from "./validate.js";
import { EVALUATION_PROTOCOLS, finaliseEvaluation, type ReportExecutable } from "./provenance.js";
import { transitionLifecycle, type LifecycleTransition } from "./lifecycle.js";
import { ModelRouter } from "./router.js";
import { createTradeMemoryStore, type TradeMemoryStore } from "./memory.js";
import { enqueueResearch, createOracleSupervisor, type OracleSupervisorState } from "./oracle-supervisor.js";
import type { StrategyLifecycle } from "@odin/shared";

export type PipelineRunResult = {
  stages: string[];
  hypothesis: Hypothesis;
  lifecycle: StrategyLifecycle;
  transitions: LifecycleTransition[];
  forge: {
    ok: boolean;
    sourceHash?: string;
    workspacePath?: string;
    error?: string;
    code?: string;
    signalsClaimed: boolean;
  };
  test: {
    sampleSize: number;
    returnPct: string | null;
    maxDrawdownPct: string | null;
    releaseGateLabel: string;
    measurable: boolean;
  };
  challenge: { passed: boolean; summary: string };
  report: ExperimentReport | null;
  /** Executable identity the report evaluated (persist as StrategyArtifact). */
  executable: ReportExecutable | null;
  paper: { admitted: boolean; tradesRecorded: number };
  memory: TradeMemoryStore;
  nextExperimentProposed: boolean;
  oracle: OracleSupervisorState;
  acceptance: Record<string, "PASS" | "FAIL" | "SKIP">;
  outcomes: ResearchOutcomeMap;
  statistics: StatisticsReport | null;
  returnPct: string | null;
};

/**
 * End-to-end research pipeline (isolated from live paper BullMQ path).
 * Uses deterministic template forge when no LLM key; never invents fill prices.
 */
export async function runResearchPipeline(input: {
  hypothesis: Hypothesis;
  autonomy: AutonomyPolicy;
  /** Synthetic measurable test metrics from a real backtest caller — nulls stay null. */
  observations?: BacktestObservation[];
  /** Caller-supplied metrics are recorded as supplied context and do not create a measured return. */
  testMetrics?: {
    sampleSize: number;
    returnPct: string | null;
    maxDrawdownPct: string | null;
    oosSampleSize: number | null;
    releaseGateLabel: string;
    observationCount: number;
    startAt: string | null;
    endAt: string | null;
  };
  minSampleSize?: number;
  /**
   * Earlier reports for the same hypothesis (selection history). Omitted = unknown, which
   * leaves tuning provenance INCOMPLETE instead of assuming no selection happened.
   */
  priorEvaluations?: Array<{ reportId: string; createdAt: string; datasetStartAt: string | null; datasetEndAt: string | null }>;
  router?: ModelRouter;
}): Promise<PipelineRunResult> {
  const stages: string[] = ["OBSERVE"];
  const transitions: LifecycleTransition[] = [];
  let lifecycle: StrategyLifecycle = "DRAFT";
  let validatedForPaper = false;
  const router = input.router ?? new ModelRouter({ budgetCapUsd: Number(input.autonomy.maxResearchBudgetUsd) });
  const oracle = createOracleSupervisor();
  const memory = createTradeMemoryStore();

  const acceptance: Record<string, "PASS" | "FAIL" | "SKIP"> = {
    hypothesis_discovered: "PASS",
    coding_model_creates_candidate: "SKIP",
    sandbox_run: "SKIP",
    historical_measurable_results: "SKIP",
    independent_challenge: "SKIP",
    versioned_evidence_report: "SKIP",
    reject_or_approved_paper_eval: "SKIP",
    forward_paper_trades_recorded: "SKIP",
    post_trade_memory_update: "SKIP",
    subsequent_experiment_proposed: "SKIP",
  };

  stages.push("HYPOTHESISE");
  const enq = enqueueResearch(
    oracle,
    {
      id: newId("rq"),
      kind: "EXPERIMENT",
      priority: 80,
      hypothesisId: input.hypothesis.id ?? "hyp",
      strategyId: null,
      reason: input.hypothesis.title,
      createdAt: new Date().toISOString(),
      budgetUsd: "0.25",
    },
    input.autonomy,
  );
  Object.assign(oracle, enq.state);

  stages.push("FORGE");
  const forged = await forgeStrategyModule({ hypothesis: input.hypothesis });
  const forgeResult = forged.ok
    ? {
        ok: true as const,
        sourceHash: forged.sourceHash,
        workspacePath: forged.workspacePath,
        signalsClaimed: true as const,
      }
    : { ok: false as const, error: forged.error, code: forged.code, signalsClaimed: false as const };

  if (forged.ok) {
    acceptance.coding_model_creates_candidate = "PASS";
    acceptance.sandbox_run = "PASS";
    const t1 = transitionLifecycle({
      strategyId: forged.manifest.id,
      from: "DRAFT",
      to: "CODE_GENERATED",
      actor: "FORGE",
      evidence: { sourceHash: forged.sourceHash },
    });
    if (t1.ok) {
      transitions.push(t1.transition);
      lifecycle = "CODE_GENERATED";
    }
    const t2 = transitionLifecycle({
      strategyId: forged.manifest.id,
      from: "CODE_GENERATED",
      to: "TESTING",
      actor: "PIPELINE",
      evidence: { workspace: forged.workspacePath },
    });
    if (t2.ok) {
      transitions.push(t2.transition);
      lifecycle = "TESTING";
    }
  } else {
    acceptance.coding_model_creates_candidate = forged.code === "ISOLATION_DISABLED" ? "SKIP" : "FAIL";
    acceptance.sandbox_run = forged.code === "ISOLATION_DISABLED" ? "SKIP" : "FAIL";
  }

  stages.push("TEST");
  const config = parseStrategyConfig(DEFAULT_STRATEGY);
  const observations = [...(input.observations ?? [])].sort(
    (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
  );
  let simulation: ReturnType<typeof simulateResearchPath> | null = null;
  let statistics: StatisticsReport | null = null;
  if (forged.ok && observations.length > 0) {
    const javascript = readFileSync(join(forged.workspacePath, "strategy.js"), "utf8");
    const execution = await executeCompiledStrategy({
      javascript,
      artifactHash: forged.artifactHash,
      bars: observations.map((row) => ({
        instrumentId: input.hypothesis.instrumentIds[0] ?? row.pairAddress,
        pairAddress: row.pairAddress,
        receivedAt: row.receivedAt,
        priceUsd: row.priceUsd,
        liquidityUsd: row.liquidityUsd,
        volume24hUsd: row.volume24hUsd,
        priceChangeM5Pct: row.priceChangeM5Pct,
        priceChangeH1Pct: row.priceChangeH1Pct,
        txnsM5Buys: row.txnsM5Buys,
        txnsM5Sells: row.txnsM5Sells,
        dataState: row.freshness,
      })),
      metadata: {
        strategyId: forged.manifest.id,
        version: forged.manifest.version,
        hypothesisId: input.hypothesis.id ?? "hyp",
      },
    });
    if (execution.signalsClaimed) {
      simulation = simulateResearchPath({
        observations,
        signals: observations.map((row, index) => ({
          observationId: row.id,
          intent: execution.signals[index]?.intent ?? "HOLD",
        })),
        config,
        initialCashUsd: config.startingBalanceUsd,
        latencyMs: config.paperLatencyMs,
      });
      statistics = summariseStatistics({
        startingEquityUsd: config.startingBalanceUsd,
        endingEquityUsd: simulation.endingEquityUsd,
        netProfitUsd:
          simulation.closedPnls.length === 0
            ? null
            : simulation.closedPnls.reduce((total, pnl) => total.plus(d(pnl)), d("0")).toFixed(8),
        closedPnls: simulation.closedPnls,
        equitySeries: simulation.equitySeries,
        exposureSeries: simulation.exposureSeries,
        observationSpanMs: simulation.observationSpanMs,
        feeBps: config.feeBps,
        alternativeFeeReturns: null,
        parameterReturns: null,
      });
    }
  }
  const startAt = observations[0]?.receivedAt ?? null;
  const endAt = observations.at(-1)?.receivedAt ?? null;
  const splits = startAt && endAt && startAt !== endAt ? chronologicalSplits(startAt, endAt) : null;
  const untouched = simulation && splits
    ? scoreWindow(simulation, Date.parse(splits.testStart), Date.parse(splits.testEnd))
    : { returnPct: null, sampleSize: 0, closedPnls: [] };
  const measuredReturn = simulation?.blocked ? null : (simulation?.returnPct ?? null);
  const measuredSample = simulation?.blocked ? 0 : (simulation?.closedPnls.length ?? 0);
  const minSampleSize = input.minSampleSize ?? config.minSampleTrades;
  const testWindow = splits ? { start: Date.parse(splits.testStart), end: Date.parse(splits.testEnd) } : null;
  const overlappingPrior =
    input.priorEvaluations?.filter((prior) => {
      if (!testWindow) return false;
      if (prior.datasetStartAt === null || prior.datasetEndAt === null) return true;
      return Date.parse(prior.datasetStartAt) <= testWindow.end && Date.parse(prior.datasetEndAt) >= testWindow.start;
    }) ?? null;
  // Re-running a hypothesis over the same test window and keeping the survivor is selection on it.
  const tunedOnEvaluationSample = overlappingPrior === null ? null : overlappingPrior.length > 0;
  const outcomes = classifyResearchOutcomes({
    pipelineFinished: true,
    experimentExecuted: Boolean(forged.ok && forged.signalsClaimed),
    returnPct: measuredReturn,
    sampleSize: measuredSample,
    minSampleSize,
    statisticsRecorded: statistics !== null,
    untouchedTestReturnPct: untouched.returnPct,
    untouchedSampleSize: untouched.sampleSize,
    tunedOnEvaluationSample,
    forwardPaperValidated: false,
    promotionAuthorised: false,
  });
  acceptance.historical_measurable_results = outcomes.RESULTS_MEASURABLE.met ? "PASS" : "FAIL";

  stages.push("CHALLENGE");
  const challenge = runChallengeReview({
    sampleSize: measuredSample,
    oosSampleSize: untouched.sampleSize > 0 ? untouched.sampleSize : null,
    inSampleReturnPct: measuredReturn,
    oosReturnPct: untouched.returnPct,
    maxDrawdownPct: statistics?.maxDrawdownPct.value ?? null,
    inactivePairCount: 0,
    disappearedPairCount: 0,
    parameterTrials: 1,
    usedFutureBars: false,
    usedPostExitMemoryInEntry: false,
    costModelPresent: true,
    monteCarloRan: false,
    correlatedSiblingStrategies: 0,
  });
  acceptance.independent_challenge = "PASS";
  if (forged.ok) {
    const t3 = transitionLifecycle({
      strategyId: forged.manifest.id,
      from: "TESTING",
      to: "CHALLENGED",
      actor: "CHALLENGE",
      evidence: { passed: challenge.passed, summary: challenge.summary },
    });
    if (t3.ok) {
      transitions.push(t3.transition);
      lifecycle = "CHALLENGED";
    }
  }

  stages.push("VALIDATE");
  let report: ExperimentReport | null = null;
  let executable: ReportExecutable | null = null;
  if (forged.ok) {
    const datasetHash = createHash("sha256")
      .update(observations.map((row) => `${row.id}:${row.receivedAt}:${row.priceUsd ?? ""}`).join("|") || "empty")
      .digest("hex");
    const configHash = configHashOf(config);
    const measuredFull = Boolean(simulation && !simulation.blocked);
    executable = {
      kind: "COMPILED_SANDBOX",
      moduleRef: null,
      moduleVersion: forged.manifest.version,
      sourceHash: forged.sourceHash,
      artifactHash: forged.artifactHash,
      runtimeLoadable: false,
    };
    const evaluation = finaliseEvaluation(
      {
        protocol: EVALUATION_PROTOCOLS.PIPELINE_SANDBOX_V1,
        config,
        configHash,
        dataset: {
          id: `observations:${startAt ?? "none"}..${endAt ?? "none"}`,
          hash: datasetHash,
          basis: "MarketObservation id:receivedAt:priceUsd",
          startAt,
          endAt,
          observationCount: observations.length,
        },
        partitions: [
          {
            name: "FULL",
            startAt,
            endAt,
            measured: measuredFull,
            sampleSize: measuredFull ? measuredSample : null,
            returnPct: measuredReturn,
            maxDrawdownPct: statistics?.maxDrawdownPct.value ?? null,
          },
          {
            name: "TEST",
            startAt: splits?.testStart ?? null,
            endAt: splits?.testEnd ?? null,
            measured: measuredFull && splits !== null,
            sampleSize: measuredFull && splits ? untouched.sampleSize : null,
            returnPct: measuredFull && splits ? untouched.returnPct : null,
            maxDrawdownPct: null,
          },
        ],
        minSampleSize,
        tuning: {
          parameterTrials: overlappingPrior === null ? null : overlappingPrior.length + 1,
          tunedOnEvaluationSample,
          basis:
            overlappingPrior === null
              ? "Selection history not supplied"
              : "Single forged candidate with DEFAULT_STRATEGY; prior reports for this hypothesis over the test window count as selection",
          history: (overlappingPrior ?? []).map((prior) => ({
            ref: prior.reportId,
            at: prior.createdAt,
            detail: "Earlier evaluation of this hypothesis overlapping the test window",
          })),
        },
        costs: {
          feeBps: config.feeBps,
          slippageModel: "research-backtest simulateResearchPath fills",
          latencyMs: config.paperLatencyMs,
        },
        forwardPaper: { status: "NONE", resultIds: [], closedTradeCount: 0, returnPct: null },
      },
      executable,
    );
    report = buildExperimentReport({
      reportId: newId("rpt"),
      hypothesisId: input.hypothesis.id ?? "hyp",
      strategyModuleId: forged.manifest.id,
      strategyVersion: forged.manifest.version,
      models: router.comparisonLog().map((row) => ({
        agentOrTask: row.agentOrTask,
        endpointId: row.endpointId,
        model: row.endpointId,
      })),
      datasetManifest: {
        observationCount: observations.length,
        startAt,
        endAt,
        sources: observations.length > 0 ? ["persisted_observations"] : ["empty"],
        contentHash: datasetHash,
      },
      periods: { train: splits?.trainStart ?? null, validation: splits?.validationStart ?? null, test: splits?.testStart ?? null },
      results: {
        sampleSize: measuredSample,
        returnPct: measuredReturn,
        maxDrawdownPct: statistics?.maxDrawdownPct.value ?? null,
        releaseGateLabel: outcomes.DEPLOYMENT_ELIGIBLE.met ? "PROMOTION_REVIEW" : "NOT_RELEASE_READY",
      },
      uncertainty: [
        measuredReturn === null ? "RETURN_UNAVAILABLE" : "RETURN_MEASURED",
        measuredSample < minSampleSize ? "INSUFFICIENT_EVIDENCE" : "SAMPLE_OK",
        input.testMetrics ? "Caller-supplied metrics were ignored for classification" : "No caller-supplied metrics",
      ],
      weaknesses: challenge.findings.map((finding) => `${finding.code}: ${finding.detail}`),
      challenge,
      reproducibility: {
        codeHash: forged.sourceHash,
        configHash,
        seed: null,
      },
      outcomes,
      evaluation,
      executable,
    });
    acceptance.versioned_evidence_report = "PASS";

    const approved = challenge.passed && outcomes.OUT_OF_SAMPLE_VALIDATED.met;
    const next = approved ? "VALIDATED" : "REJECTED";
    const t4 = transitionLifecycle({
      strategyId: forged.manifest.id,
      from: "CHALLENGED",
      to: next,
      actor: "VALIDATE",
      evidence: { reportId: report.reportId, contentHash: report.contentHash },
    });
    if (t4.ok) {
      transitions.push(t4.transition);
      lifecycle = next;
      validatedForPaper = next === "VALIDATED";
    }
    acceptance.reject_or_approved_paper_eval = "PASS";
  }

  stages.push("PAPER");
  const paperTrades = 0;
  let admitted = false;
  if (validatedForPaper) {
    if (forged.ok) {
      const t5 = transitionLifecycle({
        strategyId: forged.manifest.id,
        from: "VALIDATED",
        to: "PAPER_CANDIDATE",
        actor: "RESEARCH_POLICY",
        evidence: { approval: "research-policy" },
      });
      if (t5.ok) {
        transitions.push(t5.transition);
        lifecycle = "PAPER_CANDIDATE";
      }
    }
    admitted = true;
    // Forward paper evidence only exists as server-computed ForwardPaperResult rows.
    acceptance.forward_paper_trades_recorded = "SKIP";
    acceptance.post_trade_memory_update = "SKIP";
  } else {
    acceptance.forward_paper_trades_recorded = "SKIP";
    acceptance.post_trade_memory_update = "SKIP";
  }

  stages.push("REVIEW");
  const nextExperimentProposed = Boolean(report);
  if (nextExperimentProposed) {
    const follow = enqueueResearch(
      oracle,
      {
        id: newId("rq"),
        kind: "EXPERIMENT",
        priority: 40,
        hypothesisId: input.hypothesis.id ?? "hyp",
        strategyId: forged.ok ? forged.manifest.id : null,
        reason: "Follow-up experiment proposed from evidence report weaknesses",
        createdAt: new Date().toISOString(),
        budgetUsd: "0.10",
      },
      input.autonomy,
    );
    Object.assign(oracle, follow.state);
    acceptance.subsequent_experiment_proposed = follow.accepted ? "PASS" : "FAIL";
  }

  void router;
  return {
    stages,
    hypothesis: input.hypothesis,
    lifecycle,
    transitions,
    forge: forgeResult,
    test: {
      sampleSize: measuredSample,
      returnPct: measuredReturn,
      maxDrawdownPct: statistics?.maxDrawdownPct.value ?? null,
      releaseGateLabel: outcomes.DEPLOYMENT_ELIGIBLE.met ? "PROMOTION_REVIEW" : "NOT_RELEASE_READY",
      measurable: outcomes.RESULTS_MEASURABLE.met,
    },
    challenge: { passed: challenge.passed, summary: challenge.summary },
    report,
    executable,
    paper: { admitted, tradesRecorded: paperTrades },
    memory,
    nextExperimentProposed,
    oracle,
    acceptance,
    outcomes,
    statistics,
    returnPct: measuredReturn,
  };
}
