import { d } from "@odin/shared";
import { z } from "zod";
import { evaluationPartitions, type LineageChain, type LineageNode } from "./lineage.js";

/**
 * Honest evaluation provenance (Stage 27). Every field is what was actually measured or
 * recorded; unknown stays null and makes the report INCOMPLETE rather than optimistic.
 */

export const PROMOTION_MIN_SAMPLE_FLOOR = 30;

export const EVALUATION_PROTOCOLS = {
  PIPELINE_SANDBOX_V1: { id: "PIPELINE_SANDBOX", version: "1" },
  BACKTEST_CHRONO_60_20_20_V1: { id: "BACKTEST_CHRONO_60_20_20", version: "1" },
} as const;

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);

export const evaluationPartitionSchema = z
  .object({
    name: z.enum(["FULL", "TRAIN", "VALIDATION", "TEST"]),
    startAt: z.string().nullable(),
    endAt: z.string().nullable(),
    measured: z.boolean(),
    sampleSize: z.number().int().nullable(),
    returnPct: z.string().nullable(),
    maxDrawdownPct: z.string().nullable(),
  })
  .strict();

export const reportEvaluationSchema = z
  .object({
    protocol: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
    config: z.record(z.string(), z.unknown()),
    configHash: hex64,
    dataset: z
      .object({
        id: z.string().min(1),
        hash: z.string().min(8),
        basis: z.string().min(1),
        startAt: z.string().nullable(),
        endAt: z.string().nullable(),
        observationCount: z.number().int().nonnegative(),
      })
      .strict(),
    partitions: z.array(evaluationPartitionSchema),
    /** Policy threshold at evaluation time; never lowered to the observed sample. */
    minSampleSize: z.number().int().positive(),
    tuning: z
      .object({
        parameterTrials: z.number().int().nullable(),
        tunedOnEvaluationSample: z.boolean().nullable(),
        basis: z.string().min(1),
        history: z.array(z.object({ ref: z.string(), at: z.string().nullable(), detail: z.string() }).strict()),
      })
      .strict(),
    costs: z
      .object({
        feeBps: z.string().nullable(),
        slippageModel: z.string().nullable(),
        latencyMs: z.number().int().nullable(),
      })
      .strict(),
    forwardPaper: z
      .object({
        status: z.enum(["NONE", "RECORDED"]),
        resultIds: z.array(z.string()),
        closedTradeCount: z.number().int().nonnegative(),
        returnPct: z.string().nullable(),
      })
      .strict(),
    provenance: z.enum(["COMPLETE", "INCOMPLETE"]),
    missing: z.array(z.string()),
  })
  .strict();

export type ReportEvaluation = z.infer<typeof reportEvaluationSchema>;
export type EvaluationPartition = z.infer<typeof evaluationPartitionSchema>;

export const reportExecutableSchema = z
  .object({
    kind: z.enum(["BUILTIN_MODULE", "COMPILED_SANDBOX"]),
    moduleRef: z.string().nullable(),
    moduleVersion: z.string().min(1),
    sourceHash: hex64,
    artifactHash: hex64,
    runtimeLoadable: z.boolean(),
  })
  .strict();

export type ReportExecutable = z.infer<typeof reportExecutableSchema>;

/** Missing provenance items for an evaluation draft. Absent forward paper is a gate, not missing provenance. */
export function missingProvenance(
  evaluation: Omit<ReportEvaluation, "provenance" | "missing">,
  executable: ReportExecutable | null | undefined,
): string[] {
  const missing: string[] = [];
  const part = (name: EvaluationPartition["name"]) => evaluation.partitions.find((p) => p.name === name);
  const full = part("FULL");
  const test = part("TEST");
  if (!full?.measured) missing.push("FULL_PARTITION_UNMEASURED");
  if (!test) missing.push("TEST_PARTITION_ABSENT");
  else if (!test.measured || test.startAt === null || test.endAt === null) missing.push("TEST_PARTITION_UNMEASURED");
  if (evaluation.tuning.tunedOnEvaluationSample === null) missing.push("TUNING_HISTORY_UNKNOWN");
  if (evaluation.dataset.observationCount === 0 || evaluation.dataset.startAt === null) missing.push("DATASET_EMPTY");
  if (evaluation.costs.feeBps === null) missing.push("FEE_ASSUMPTION_UNKNOWN");
  if (!executable) missing.push("EXECUTABLE_IDENTITY_ABSENT");
  return missing;
}

export function finaliseEvaluation(
  draft: Omit<ReportEvaluation, "provenance" | "missing">,
  executable: ReportExecutable | null | undefined,
): ReportEvaluation {
  const missing = missingProvenance(draft, executable);
  return { ...draft, provenance: missing.length === 0 ? "COMPLETE" : "INCOMPLETE", missing };
}

export function partitionOf(evaluation: ReportEvaluation, name: EvaluationPartition["name"]): EvaluationPartition | null {
  return evaluation.partitions.find((p) => p.name === name) ?? null;
}

export type ForwardFill = {
  orderId: string;
  pairAddress: string;
  side: string;
  qty: string;
  priceUsd: string;
  feeUsd: string;
  at: string;
};

/**
 * FIFO round-trip PnL from fills of one promoted identity inside its window. Sells that close
 * positions opened before the window are excluded (counted in unmatchedSellQty), never guessed.
 */
export function forwardPaperFromFills(input: { fills: ForwardFill[]; startingBalanceUsd: string }): {
  orderCount: number;
  closedPnls: string[];
  netPnlUsd: string | null;
  returnPct: string | null;
  unmatchedSellQty: string;
} {
  const lots = new Map<string, Array<{ qty: ReturnType<typeof d>; unitCost: ReturnType<typeof d> }>>();
  const closedPnls: string[] = [];
  let unmatched = d("0");
  const ordered = [...input.fills].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const fill of ordered) {
    const qty = d(fill.qty);
    if (qty.lte(0)) continue;
    const queue = lots.get(fill.pairAddress) ?? [];
    if (fill.side === "BUY") {
      queue.push({ qty, unitCost: d(fill.priceUsd).plus(d(fill.feeUsd).div(qty)) });
      lots.set(fill.pairAddress, queue);
      continue;
    }
    let remaining = qty;
    let pnl = d("0");
    let matchedQty = d("0");
    while (remaining.gt(0) && queue.length > 0) {
      const lot = queue[0]!;
      const take = lot.qty.lt(remaining) ? lot.qty : remaining;
      pnl = pnl.plus(d(fill.priceUsd).minus(lot.unitCost).mul(take));
      matchedQty = matchedQty.plus(take);
      lot.qty = lot.qty.minus(take);
      remaining = remaining.minus(take);
      if (lot.qty.lte(0)) queue.shift();
    }
    unmatched = unmatched.plus(remaining);
    if (matchedQty.gt(0)) {
      pnl = pnl.minus(d(fill.feeUsd).mul(matchedQty).div(qty));
      closedPnls.push(pnl.toFixed(8));
    }
  }
  const net = closedPnls.length === 0 ? null : closedPnls.reduce((sum, value) => sum.plus(d(value)), d("0"));
  const balance = d(input.startingBalanceUsd);
  return {
    orderCount: new Set(input.fills.map((fill) => fill.orderId)).size,
    closedPnls,
    netPnlUsd: net?.toFixed(8) ?? null,
    returnPct: net && balance.gt(0) ? net.div(balance).mul(100).toFixed(4) : null,
    unmatchedSellQty: unmatched.toFixed(8),
  };
}

export type LineageSources = {
  hypothesis: { id: string; persisted: boolean; at: string | null };
  report: {
    id: string;
    contentHash: string;
    createdAt: string;
    evaluation: ReportEvaluation | null;
    executable: ReportExecutable | null;
    codeHash: string;
    configHash: string;
  };
  approvals: Array<{
    id: string;
    reportId: string;
    reportContentHash: string;
    sourceHash: string;
    artifactHash: string;
    configHash: string;
    decision: string;
    reviewer: string;
    at: string;
  }>;
  promotions?: Array<{
    id: string;
    mode: string;
    reportId: string | null;
    approvalId: string | null;
    sourceHash: string;
    artifactHash: string;
    configHash: string;
    rollbackOfId: string | null;
    previousPromotionId: string | null;
    at: string;
  }>;
  forwardResults?: Array<{ id: string; promotionId: string; closedTradeCount: number; returnPct: string | null; at: string }>;
};

/**
 * Lineage graph rebuilt from persisted rows only (never from client payloads):
 * HYPOTHESIS → DATASET → EXPERIMENT → REPORT → APPROVAL → PROMOTION → FORWARD_RESULT / ROLLBACK.
 */
export function buildPersistedLineage(sources: LineageSources): LineageChain {
  const unknown = evaluationPartitions({ aggregateReturnPct: null, measuredUntouched: false });
  const nodes: LineageNode[] = [];
  const evaluation = sources.report.evaluation;
  const executable = sources.report.executable;
  nodes.push({
    id: sources.hypothesis.id,
    kind: "HYPOTHESIS",
    at: sources.hypothesis.at ?? sources.report.createdAt,
    parentId: null,
    hashes: {},
    evaluation: unknown,
    meta: { persisted: sources.hypothesis.persisted },
  });
  const datasetId = `dataset:${sources.report.id}`;
  nodes.push({
    id: datasetId,
    kind: "DATASET",
    at: sources.report.createdAt,
    parentId: sources.hypothesis.id,
    hashes: evaluation ? { datasetHash: evaluation.dataset.hash } : {},
    evaluation: unknown,
    meta: evaluation ? { datasetId: evaluation.dataset.id, basis: evaluation.dataset.basis } : { missing: true },
  });
  const experimentId = `experiment:${sources.report.id}`;
  const experimentHashes = {
    sourceHash: sources.report.codeHash,
    ...(executable ? { executableHash: executable.artifactHash } : {}),
    configHash: sources.report.configHash,
    ...(evaluation ? { datasetHash: evaluation.dataset.hash } : {}),
  };
  nodes.push({
    id: experimentId,
    kind: "EXPERIMENT",
    at: sources.report.createdAt,
    parentId: datasetId,
    hashes: experimentHashes,
    evaluation: unknown,
    meta: evaluation ? { protocol: evaluation.protocol } : { missing: true },
  });
  const test = evaluation ? partitionOf(evaluation, "TEST") : null;
  const full = evaluation ? partitionOf(evaluation, "FULL") : null;
  nodes.push({
    id: sources.report.id,
    kind: "REPORT",
    at: sources.report.createdAt,
    parentId: experimentId,
    hashes: { ...experimentHashes, reportHash: sources.report.contentHash },
    evaluation: evaluationPartitions({
      aggregateReturnPct: full?.returnPct ?? null,
      measuredUntouched: Boolean(test?.measured),
      untouchedTestReturnPct: test?.returnPct ?? null,
      untouchedSampleSize: test?.sampleSize ?? null,
    }),
    meta: { provenance: evaluation?.provenance ?? "LEGACY_INCOMPLETE" },
  });
  for (const approval of sources.approvals) {
    nodes.push({
      id: approval.id,
      kind: "APPROVAL",
      at: approval.at,
      parentId: approval.reportId,
      hashes: {
        sourceHash: approval.sourceHash,
        executableHash: approval.artifactHash,
        configHash: approval.configHash,
        reportHash: approval.reportContentHash,
      },
      evaluation: unknown,
      meta: { decision: approval.decision, reviewer: approval.reviewer },
    });
  }
  for (const promotion of sources.promotions ?? []) {
    nodes.push({
      id: promotion.id,
      kind: promotion.mode === "ROLLBACK" ? "ROLLBACK" : "PROMOTION",
      at: promotion.at,
      parentId: promotion.rollbackOfId ?? promotion.approvalId ?? promotion.previousPromotionId,
      hashes: {
        sourceHash: promotion.sourceHash,
        executableHash: promotion.artifactHash,
        configHash: promotion.configHash,
      },
      evaluation: unknown,
      meta: { mode: promotion.mode, reportId: promotion.reportId },
    });
  }
  for (const result of sources.forwardResults ?? []) {
    nodes.push({
      id: result.id,
      kind: "FORWARD_RESULT",
      at: result.at,
      parentId: result.promotionId,
      hashes: {},
      evaluation: unknown,
      meta: { closedTradeCount: result.closedTradeCount, returnPct: result.returnPct },
    });
  }
  return { nodes };
}
