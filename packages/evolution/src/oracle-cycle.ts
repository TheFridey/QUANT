import { z } from "zod";
import { chronologicalSplits } from "@odin/backtest";
import type { TradeMemoryRecord } from "@odin/shared";
import { forgeStrategyModule } from "./forge.js";
import { inspectSource } from "./static-gate.js";
import { ModelRouter, type UsageRecord } from "./router.js";
import {
  ORACLE_CAPABILITIES,
  admitOracleItem,
  emptyOracleQueue,
  noteOracleFailure,
  type OracleCapability,
  type OracleLimits,
  type OracleQueueSnapshot,
  DEFAULT_ORACLE_LIMITS,
} from "./oracle-research.js";
import { compareStrategies, detectDeterioration } from "./oracle-supervisor.js";
import type { LlmRequest } from "@odin/agent-core";
import type { StrategyBar, StrategySignal } from "./strategy-interface.js";

const observerSchema = z.object({ weaknesses: z.array(z.string().min(1)).max(8) }).strict();
const hypothesisSchema = z
  .object({
    title: z.string().min(3).max(160),
    falsifier: z.string().min(8).max(500),
    conditions: z.string().min(8).max(500),
  })
  .strict();
const sourceSchema = z.object({ source: z.string().min(20).max(8_000) }).strict();
const challengeSchema = z
  .object({
    verdict: z.enum(["PASS", "REJECT"]),
    findings: z.array(z.string()).max(12),
  })
  .strict();

export type OracleCycleStep = {
  capability: OracleCapability;
  status: "RECORDED" | "UNAVAILABLE" | "REJECTED" | "EXECUTED";
  detail: string;
  aiDiscovery: false;
  modelIdentifier: string | null;
  priority: number;
};

export type OracleCycleResult = {
  steps: OracleCycleStep[];
  actionCount: number;
  queue: OracleQueueSnapshot;
  engineeringSource: string | null;
  executedSourceHash: string | null;
  signals: StrategySignal[];
  signalsClaimed: boolean;
  experimentExecuted: boolean;
  candidateRejected: boolean;
  forgeEndpointId: string;
  challengeEndpointId: string;
  aiDiscoveryStored: boolean;
  routerUsage: UsageRecord[];
};

const PRIORITY: Record<OracleCapability, number> = {
  REVIEW_PERFORMANCE: 90,
  EXAMINE_TRADE_MEMORY: 70,
  RECURRING_CONDITIONS: 60,
  WEAKNESSES: 80,
  FALSIFIABLE_HYPOTHESIS: 75,
  REQUEST_CODE_GENERATION: 50,
  SCHEDULE_SANDBOXED_TEST: 55,
  COMPARE_BASELINES: 65,
  REVIEW_CHALLENGE: 85,
  REJECT_WEAK_CANDIDATE: 95,
  RECOMMEND_EXPERIMENT: 40,
  DETERIORATING_STRATEGY: 30,
  PERIODIC_SUMMARY: 20,
};

/**
 * One bounded research cycle. It performs the thirteen capabilities in order and stops.
 * It does not call itself and it does not schedule a further model loop.
 */
export async function runBoundedResearchCycle(input: {
  router: ModelRouter;
  performance: { returnPct: string | null; sampleSize: number; maxDrawdownPct: string | null };
  memory: TradeMemoryRecord[];
  baselines: Array<{ id: string; returnPct: string | null; sampleSize: number }>;
  hypothesisId: string | null;
  instrumentIds: string[];
  queue?: OracleQueueSnapshot;
  limits?: OracleLimits;
  bars?: StrategyBar[];
}): Promise<OracleCycleResult> {
  const limits = input.limits ?? DEFAULT_ORACLE_LIMITS;
  let queue = input.queue ?? emptyOracleQueue();
  const steps: OracleCycleStep[] = [];
  const separated = input.router.assertSeparatedReviewer();

  const performanceDetail =
    input.performance.returnPct === null
      ? `Performance return is unavailable (n=${input.performance.sampleSize})`
      : `Observed return ${input.performance.returnPct}% (n=${input.performance.sampleSize})`;
  steps.push(step("REVIEW_PERFORMANCE", "RECORDED", performanceDetail, null));

  const entryMemory = input.memory.filter((record) => !record.postExit && record.phase !== "AFTER");
  steps.push(
    step(
      "EXAMINE_TRADE_MEMORY",
      "RECORDED",
      `Entry-safe memory rows ${entryMemory.length}; post-exit rows excluded`,
      null,
    ),
  );

  const conditionCounts = new Map<string, number>();
  for (const record of entryMemory) {
    const condition = record.context.condition;
    if (typeof condition === "string" && condition.length > 0) {
      conditionCounts.set(condition, (conditionCounts.get(condition) ?? 0) + 1);
    }
  }
  const recurring = [...conditionCounts.entries()].filter(([, count]) => count >= 2);
  steps.push(
    step(
      "RECURRING_CONDITIONS",
      "RECORDED",
      recurring.length === 0 ? "No repeated entry condition" : `Repeated conditions: ${recurring.map(([name]) => name).join(", ")}`,
      null,
    ),
  );

  const observed = await callTier(input.router, "SENTINEL", "fast_observer", observerSchema, "List weaknesses from the supplied entry-safe notes.");
  const deterministicWeaknesses = [
    input.performance.returnPct === null ? "Return is unavailable" : null,
    input.performance.sampleSize < 30 ? "Sample is below 30" : null,
  ].filter((item): item is string => item !== null);
  steps.push(
    step(
      "WEAKNESSES",
      observed.ok ? "EXECUTED" : "UNAVAILABLE",
      observed.ok
        ? `Model weaknesses: ${observed.data.weaknesses.join(", ")}`
        : `Fast observer unavailable. Persisted weaknesses: ${deterministicWeaknesses.join("; ") || "none"}`,
      observed.ok ? observed.model : null,
    ),
  );

  const hypothesisCall = await callTier(
    input.router,
    "ORACLE",
    "deep_hypothesis",
    hypothesisSchema,
    "State one falsifiable hypothesis. Do not write strategy source.",
  );
  steps.push(
    step(
      "FALSIFIABLE_HYPOTHESIS",
      hypothesisCall.ok ? "EXECUTED" : "UNAVAILABLE",
      hypothesisCall.ok ? hypothesisCall.data.falsifier : "Deep research tier is unavailable. No hypothesis was substituted.",
      hypothesisCall.ok ? hypothesisCall.model : null,
    ),
  );

  const engineeringCall = await callTier(
    input.router,
    "FORGE",
    "engineering_source",
    sourceSchema,
    "Return strategy source for the hypothesis. Emit intents only.",
  );
  let engineeringSource: string | null = null;
  let executedSourceHash: string | null = null;
  let signals: StrategySignal[] = [];
  let signalsClaimed = false;
  let experimentExecuted = false;
  if (!engineeringCall.ok || !hypothesisCall.ok) {
    steps.push(
      step(
        "REQUEST_CODE_GENERATION",
        "UNAVAILABLE",
        "Engineering tier is unavailable or there is no hypothesis. No template source was executed.",
        engineeringCall.ok ? engineeringCall.model : null,
      ),
    );
  } else {
    engineeringSource = engineeringCall.data.source;
    const findings = inspectSource(engineeringSource);
    if (findings.length > 0) {
      queue = noteOracleFailure(queue, limits);
      steps.push(
        step(
          "REQUEST_CODE_GENERATION",
          "REJECTED",
          `Static source gate rejected the engineering source (${findings.map((finding) => finding.code).join(", ")})`,
          engineeringCall.model,
        ),
      );
    } else {
      const forged = await forgeStrategyModule({
        hypothesis: {
          id: input.hypothesisId ?? "hyp-cycle",
          title: hypothesisCall.data.title,
          market: "SPOT_CRYPTO_PAIR",
          instrumentIds: input.instrumentIds,
          conditions: hypothesisCall.data.conditions,
          claimedAdvantage: hypothesisCall.data.falsifier,
          entryRules: hypothesisCall.data.conditions,
          exitRules: "Exit stays outside this module and is a separate intent",
          riskRules: "Risk sizing and fills stay outside the generated module",
          rationale: hypothesisCall.data.falsifier,
          successCriteria: hypothesisCall.data.falsifier,
          failureModes: hypothesisCall.data.falsifier,
          status: "FORGING",
        },
        source: engineeringSource,
        modelIdentifier: engineeringCall.model,
        bars: input.bars,
      });
      if (forged.ok && forged.signalsClaimed && forged.sourceHash) {
        executedSourceHash = forged.sourceHash;
        signals = forged.signals;
        signalsClaimed = true;
        experimentExecuted = true;
        steps.push(
          step(
            "REQUEST_CODE_GENERATION",
            "EXECUTED",
            `Engineering source accepted for isolated execution (${forged.sourceHash})`,
            engineeringCall.model,
          ),
        );
      } else {
        queue = noteOracleFailure(queue, limits);
        steps.push(
          step(
            "REQUEST_CODE_GENERATION",
            "REJECTED",
            forged.ok ? "Execution did not claim signals" : forged.error,
            engineeringCall.model,
          ),
        );
        if (!forged.ok) {
          executedSourceHash = null;
          signals = [];
          signalsClaimed = false;
          experimentExecuted = false;
        }
      }
    }
  }

  steps.push(
    step(
      "SCHEDULE_SANDBOXED_TEST",
      experimentExecuted ? "EXECUTED" : "REJECTED",
      experimentExecuted
        ? `Isolated run claimed signals for source hash ${executedSourceHash}`
        : "Sandbox was not given a substitute source and did not claim signals",
      null,
    ),
  );

  const bars = input.bars ?? [];
  const split =
    bars.length >= 2
      ? chronologicalSplits(bars[0]!.receivedAt, bars[bars.length - 1]!.receivedAt)
      : null;
  const ranking = compareStrategies([
    ...input.baselines,
    { id: "candidate", returnPct: input.performance.returnPct, sampleSize: input.performance.sampleSize },
  ]);
  steps.push(
    step(
      "COMPARE_BASELINES",
      "RECORDED",
      `${split ? `Untouched window ${split.testStart} to ${split.testEnd}. ` : ""}${ranking.ranking.map((row) => `${row.rank}:${row.id}:${row.note}`).join(" | ")}`,
      null,
    ),
  );

  const challengeCall = await callTier(
    input.router,
    "CHALLENGE",
    "challenge_review",
    challengeSchema,
    "Challenge the candidate. Return PASS or REJECT.",
  );
  steps.push(
    step(
      "REVIEW_CHALLENGE",
      challengeCall.ok ? "EXECUTED" : "UNAVAILABLE",
      challengeCall.ok ? `Challenge ${challengeCall.data.verdict}` : "Independent challenge tier is unavailable",
      challengeCall.ok ? challengeCall.model : null,
    ),
  );

  const candidateRejected =
    !experimentExecuted ||
    !challengeCall.ok ||
    challengeCall.data.verdict === "REJECT" ||
    input.performance.returnPct === null ||
    input.performance.sampleSize < 30;
  steps.push(
    step(
      "REJECT_WEAK_CANDIDATE",
      candidateRejected ? "REJECTED" : "RECORDED",
      candidateRejected
        ? "Candidate stays rejected: unavailable challenge, null return, small sample, or no isolated execution"
        : "Candidate passed the cycle gates and still requires an operator promotion",
      null,
    ),
  );

  const recommendation = admitOracleItem(
    queue,
    {
      id: `rq-${input.hypothesisId ?? "cycle"}`,
      capability: "RECOMMEND_EXPERIMENT",
      priority: PRIORITY.RECOMMEND_EXPERIMENT,
      hypothesisId: input.hypothesisId,
      strategyId: null,
      reason: "Next experiment needs an untouched window before any promotion review",
      createdAt: "2026-10-28T20:15:00.000Z",
      budgetUsd: "0.1000",
      retries: 0,
      provenance: "DETERMINISTIC_SUPERVISOR",
      modelIdentifier: null,
    },
    limits,
  );
  queue = recommendation.snapshot;
  steps.push(
    step(
      "RECOMMEND_EXPERIMENT",
      recommendation.accepted ? "RECORDED" : "REJECTED",
      recommendation.reason,
      null,
    ),
  );

  const deterioration = detectDeterioration({
    recentReturnPct: input.performance.returnPct,
    maxDrawdownPct: input.performance.maxDrawdownPct,
    sampleSize: input.performance.sampleSize,
  });
  steps.push(
    step(
      "DETERIORATING_STRATEGY",
      "RECORDED",
      deterioration.notes.join(" "),
      null,
    ),
  );

  steps.push(
    step(
      "PERIODIC_SUMMARY",
      "RECORDED",
      `Cycle summary for ${input.hypothesisId ?? "no hypothesis"}. Return ${input.performance.returnPct === null ? "unavailable" : input.performance.returnPct}. Entry-safe memory ${entryMemory.length}. Actions ${steps.length + 1}.`,
      null,
    ),
  );

  if (steps.length !== ORACLE_CAPABILITIES.length || steps.some((row, index) => row.capability !== ORACLE_CAPABILITIES[index])) {
    throw new Error("ORACLE cycle action list drifted");
  }

  return {
    steps,
    actionCount: steps.length,
    queue,
    engineeringSource: experimentExecuted ? engineeringSource : engineeringCall.ok && hypothesisCall.ok ? engineeringSource : null,
    executedSourceHash,
    signals,
    signalsClaimed,
    experimentExecuted,
    candidateRejected,
    forgeEndpointId: separated.forgeEndpointId,
    challengeEndpointId: separated.challengeEndpointId,
    aiDiscoveryStored: queue.items.some((item) => item.aiDiscovery),
    routerUsage: [...input.router.usage],
  };
}

function step(
  capability: OracleCapability,
  status: OracleCycleStep["status"],
  detail: string,
  modelIdentifier: string | null,
): OracleCycleStep {
  return {
    capability,
    status,
    detail,
    aiDiscovery: false,
    modelIdentifier,
    priority: PRIORITY[capability],
  };
}

async function callTier<T>(
  router: ModelRouter,
  agent: string,
  purpose: LlmRequest["purpose"],
  schema: z.ZodType<T>,
  prompt: string,
): Promise<{ ok: true; data: T; model: string } | { ok: false }> {
  const result = await router.completeJson(
    agent,
    {
      purpose,
      maxTokens: 400,
      timeoutMs: 2_000,
      messages: [{ role: "user", content: prompt }],
    },
    schema,
  );
  if (!result.ok) return { ok: false };
  return { ok: true, data: result.data, model: result.model };
}
