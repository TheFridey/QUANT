import { createHash } from "node:crypto";

/**
 * Practical research lineage (§13 / D28):
 * hypothesis → dataset → experiment → report → approval → promotion → rollback
 * Immutable evidence hashes; approval must not reuse across changed code/params.
 */

export type LineageNodeKind =
  | "HYPOTHESIS"
  | "DATASET"
  | "EXPERIMENT"
  | "REPORT"
  | "APPROVAL"
  | "PROMOTION"
  | "ROLLBACK";

export type LineageHashes = {
  sourceHash: string;
  executableHash: string;
  configHash: string;
  datasetHash: string;
  reportHash: string;
  protocolHash: string;
  depsHash: string;
};

export type LineageNode = {
  id: string;
  kind: LineageNodeKind;
  at: string;
  hashes: Partial<LineageHashes>;
  parentId: string | null;
  /** Evaluation partitions — never copy aggregate into untouched-test fields. */
  evaluation: {
    aggregateReturnPct: string | null;
    untouchedTestReturnPct: string | null;
    untouchedSampleSize: number | null;
    unknown: boolean;
  };
  meta?: Record<string, unknown>;
};

export type LineageChain = {
  nodes: LineageNode[];
};

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildDistinctHashes(input: {
  source: unknown;
  executable: unknown;
  config: unknown;
  dataset: unknown;
  report: unknown;
  protocol: unknown;
  deps: unknown;
}): LineageHashes {
  return {
    sourceHash: hashPayload(input.source),
    executableHash: hashPayload(input.executable),
    configHash: hashPayload(input.config),
    datasetHash: hashPayload(input.dataset),
    reportHash: hashPayload(input.report),
    protocolHash: hashPayload(input.protocol),
    depsHash: hashPayload(input.deps),
  };
}

/** Honest partitions: untouched fields stay null/unknown unless explicitly measured. */
export function evaluationPartitions(input: {
  aggregateReturnPct: string | null;
  untouchedTestReturnPct?: string | null;
  untouchedSampleSize?: number | null;
  measuredUntouched: boolean;
}): LineageNode["evaluation"] {
  if (!input.measuredUntouched) {
    return {
      aggregateReturnPct: input.aggregateReturnPct,
      untouchedTestReturnPct: null,
      untouchedSampleSize: null,
      unknown: true,
    };
  }
  return {
    aggregateReturnPct: input.aggregateReturnPct,
    untouchedTestReturnPct: input.untouchedTestReturnPct ?? null,
    untouchedSampleSize: input.untouchedSampleSize ?? null,
    unknown: false,
  };
}

/** Approval is bound to exact hashes — changed code/params invalidate reuse. */
export function approvalStillValid(input: {
  approvedHashes: Pick<LineageHashes, "sourceHash" | "executableHash" | "configHash">;
  currentHashes: Pick<LineageHashes, "sourceHash" | "executableHash" | "configHash">;
}): boolean {
  return (
    input.approvedHashes.sourceHash === input.currentHashes.sourceHash &&
    input.approvedHashes.executableHash === input.currentHashes.executableHash &&
    input.approvedHashes.configHash === input.currentHashes.configHash
  );
}

export function appendLineageNode(chain: LineageChain, node: LineageNode): LineageChain {
  return { nodes: [...chain.nodes, node] };
}

export function findRollbackTarget(chain: LineageChain, promotionNodeId: string): LineageNode | null {
  const promotion = chain.nodes.find((n) => n.id === promotionNodeId && n.kind === "PROMOTION");
  if (!promotion?.parentId) return null;
  return chain.nodes.find((n) => n.id === promotion.parentId) ?? null;
}

/**
 * Server-side lineage gate for validated promotion (§19–§20).
 * Report hash is never treated as executable hash; unknown evaluation stays unknown.
 */
export function validateLineageForPromotion(input: {
  chain: LineageChain;
  reportId: string;
  sourceHash: string;
  artifactHash: string;
  configHash: string;
}): { ok: true } | { ok: false; reason: string } {
  const report = input.chain.nodes.find((n) => n.kind === "REPORT" && n.id === input.reportId);
  if (!report) {
    return { ok: false, reason: `Lineage missing durable REPORT node for ${input.reportId}` };
  }
  if (report.hashes.reportHash && report.hashes.executableHash && report.hashes.reportHash === report.hashes.executableHash) {
    return { ok: false, reason: "Lineage refuses report-hash-as-executable" };
  }
  if (report.evaluation.unknown && report.evaluation.untouchedTestReturnPct != null) {
    return { ok: false, reason: "Lineage forbids forged untouched metrics while unknown=true" };
  }
  const approval = [...input.chain.nodes].reverse().find((n) => n.kind === "APPROVAL");
  if (!approval) {
    return { ok: false, reason: "Validated promotion requires a durable APPROVAL lineage node" };
  }
  if (
    !approvalStillValid({
      approvedHashes: {
        sourceHash: approval.hashes.sourceHash ?? "",
        executableHash: approval.hashes.executableHash ?? "",
        configHash: approval.hashes.configHash ?? "",
      },
      currentHashes: {
        sourceHash: input.sourceHash,
        executableHash: input.artifactHash,
        configHash: input.configHash,
      },
    })
  ) {
    return { ok: false, reason: "Approval hashes no longer match source/executable/config" };
  }
  return { ok: true };
}
