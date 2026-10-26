import { z } from "zod";
import { MODEL_VERSIONS } from "./versions.js";
import {
  advisorySummarySchema,
  createModelProvider,
  type LlmResult,
  type ModelProvider,
} from "./llm.js";

export const oracleReviewSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    tone: z.enum(["neutral", "caution", "constructive"]),
    weaknesses: z.array(z.string().max(400)).max(12),
    suggestions: z.array(z.string().max(400)).max(12),
    losingPeriodNotes: z.array(z.string().max(400)).max(8),
    readiness: z.enum([
      "INSUFFICIENT_EVIDENCE",
      "NEEDS_MORE_OOS",
      "PAPER_CANDIDATE",
      "NOT_READY",
    ]),
    overfittingRisk: z.enum(["low", "medium", "high", "unknown"]),
  })
  .strict();

export type OracleReviewPayload = z.infer<typeof oracleReviewSchema>;

export type OracleExperimentInput = {
  runId: string;
  strategyName: string;
  sampleSize: number;
  oosSampleSize: number | null;
  returnPct: string | null;
  oosReturnPct: string | null;
  maxDrawdownPct: string | null;
  profitFactor: string | null;
  sampleGatePassed: boolean;
  releaseGateLabel: string;
  baselines: Array<{ name: string; returnPct: string | null }>;
  assumptions: string[];
  inactivePairCount: number;
  disappearedPairCount: number;
};

/**
 * ORACLE — seventh optional supervisory module.
 * Does NOT execute trades. Reviews experiments, flags overfitting, suggests parameter
 * experiments, explains losing periods, and recommends readiness for further paper
 * validation. Human approval required for all proposed changes.
 */
export async function runOracleReview(
  input: OracleExperimentInput,
  provider?: ModelProvider,
): Promise<{
  agent: "ORACLE";
  modelVersion: string;
  payload: OracleReviewPayload;
  llm: LlmResult<OracleReviewPayload>;
  approvalRequired: true;
  executesTrades: false;
}> {
  const model = provider ?? createModelProvider({});
  const deterministic = buildDeterministicReview(input);

  const llm = await model.completeJson(
    {
      model: "research-strong",
      purpose: "research",
      maxTokens: 800,
      timeoutMs: 10_000,
      messages: [
        {
          role: "system",
          content:
            "You are ORACLE for ODIN // QUANT. Advisory only. Never invent prices, fills, returns, or sample sizes. Never recommend real-money trading. Output JSON matching the schema. Prefer caution when evidence is thin.",
        },
        {
          role: "user",
          content: JSON.stringify({ facts: input, seedReview: deterministic }),
        },
      ],
    },
    oracleReviewSchema,
  );

  // Prefer schema-valid LLM output when available; otherwise deterministic review.
  // If LLM returns advisorySummary-shaped mock, fall back to deterministic.
  let payload = deterministic;
  if (llm.ok) {
    payload = llm.data;
  } else {
    // Mock provider may only speak advisorySummarySchema — map it safely without inventing metrics.
    const advisory = await model.completeJson(
      {
        model: "research-strong",
        purpose: "research",
        maxTokens: 400,
        timeoutMs: 8_000,
        messages: [
          {
            role: "system",
            content: "Advisory-only JSON. Never invent prices or returns.",
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      },
      advisorySummarySchema,
    );
    if (advisory.ok) {
      payload = {
        ...deterministic,
        summary: `${deterministic.summary} ${advisory.data.summary}`.slice(0, 4000),
        tone: advisory.data.tone,
        suggestions: [
          ...deterministic.suggestions,
          ...advisory.data.bullets.map((bullet) => `Advisory: ${bullet}`),
        ].slice(0, 12),
      };
    }
  }

  return {
    agent: "ORACLE",
    modelVersion: MODEL_VERSIONS.ORACLE,
    payload,
    llm: llm.ok
      ? llm
      : {
          ok: true,
          data: payload,
          provider: model.id,
          model: "oracle-deterministic",
          cached: false,
          latencyMs: 0,
        },
    approvalRequired: true,
    executesTrades: false,
  };
}

export function approveOracleSuggestions(input: {
  reviewId: string;
  approvedBy: string;
  approvedAt: string;
}): { status: "APPROVED"; promoted: false; realMoneyGraduation: false } {
  // Approval records human consent for further paper experiments only.
  void input;
  return { status: "APPROVED", promoted: false, realMoneyGraduation: false };
}

function buildDeterministicReview(input: OracleExperimentInput): OracleReviewPayload {
  const weaknesses: string[] = [];
  const suggestions: string[] = [];
  const losingPeriodNotes: string[] = [];

  if (!input.sampleGatePassed || input.sampleSize < 30) {
    weaknesses.push("Sample size below institutional research threshold.");
    suggestions.push("Collect more closed paper trades before parameter search.");
  }
  if (input.oosSampleSize === null || input.oosSampleSize < 30) {
    weaknesses.push("Out-of-sample evidence is missing or thin.");
    suggestions.push("Run walk-forward with an untouched test split.");
  }
  if (input.disappearedPairCount > 0 || input.inactivePairCount > 0) {
    weaknesses.push("Universe includes disappeared or inactive pairs — survivorship risk if ignored.");
    suggestions.push("Keep inactive/disappeared pairs in reports; do not drop them from the universe silently.");
  }
  if (input.returnPct !== null && input.oosReturnPct !== null) {
    const inSample = Number(input.returnPct);
    const oos = Number(input.oosReturnPct);
    if (Number.isFinite(inSample) && Number.isFinite(oos) && inSample > 0 && oos < inSample * 0.25) {
      weaknesses.push("Large in-sample vs OOS return gap — possible overfitting.");
      suggestions.push("Reduce parameter degrees of freedom; re-test with cost stress.");
    }
  }
  if (input.maxDrawdownPct !== null && Number(input.maxDrawdownPct) > 15) {
    losingPeriodNotes.push(`Observed max drawdown ${input.maxDrawdownPct}% — review stop and exposure caps.`);
  }
  if (weaknesses.length === 0) {
    weaknesses.push("No automated weakness flags; human review still required.");
  }
  suggestions.push("Any config change requires human approval and must not auto-apply to a RUNNING engine.");
  suggestions.push("There is no real-money venue — readiness means further paper validation only.");

  const readiness =
    !input.sampleGatePassed
      ? "INSUFFICIENT_EVIDENCE"
      : input.oosSampleSize === null || input.oosSampleSize < 30
        ? "NEEDS_MORE_OOS"
        : input.releaseGateLabel === "NOT_RELEASE_READY"
          ? "NOT_READY"
          : "PAPER_CANDIDATE";

  return {
    summary:
      "ORACLE advisory review of a paper backtest/experiment. Deterministic risk, sizing, and ledger remain authoritative. Do not treat a single profitable window as validation.",
    tone: readiness === "PAPER_CANDIDATE" ? "constructive" : "caution",
    weaknesses,
    suggestions,
    losingPeriodNotes,
    readiness,
    overfittingRisk:
      input.returnPct !== null && input.oosReturnPct !== null && Number(input.returnPct) > 0 && Number(input.oosReturnPct) < 0
        ? "high"
        : input.sampleSize < 30
          ? "unknown"
          : "medium",
  };
}
