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
