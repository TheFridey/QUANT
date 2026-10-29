import { canonicalJson, sha256 } from "@odin/shared";

/**
 * Practical research lineage (§13 / D28):
 * hypothesis → dataset → experiment → report → approval → promotion → forward result → rollback
 * Immutable evidence hashes; approval must not reuse across changed code/params.
 */

export type LineageNodeKind =
  | "HYPOTHESIS"
  | "DATASET"
  | "EXPERIMENT"
  | "REPORT"
  | "APPROVAL"
  | "PROMOTION"
  | "FORWARD_RESULT"
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

/** Canonical (key-sorted) SHA-256 — identical to configHashOf for configs. */
export function hashPayload(value: unknown): string {
  return sha256(canonicalJson(value));
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

function ancestors(chain: LineageChain, node: LineageNode): LineageNode[] {
  const byId = new Map(chain.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([node.id]);
  const out: LineageNode[] = [];
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    out.push(parent);
    parentId = parent.parentId;
  }
  return out;
}

/**
 * Server-side lineage gate for validated promotion (§19–§20).
 * Every edge must exist: missing lineage never skips validation. The approval must be a
 * child of THIS report and carry this report's hash plus the promoted source/executable/config.
 */
export function validateLineageForPromotion(input: {
  chain: LineageChain;
  reportId: string;
  sourceHash: string;
  artifactHash: string;
  configHash: string;
  approvalId?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const report = input.chain.nodes.find((n) => n.kind === "REPORT" && n.id === input.reportId);
  if (!report) {
    return { ok: false, reason: `Lineage missing durable REPORT node for ${input.reportId}` };
  }
  if (!report.hashes.reportHash || !report.hashes.executableHash) {
    return { ok: false, reason: "Lineage REPORT node lacks distinct report and executable hashes" };
  }
  if (report.hashes.reportHash === report.hashes.executableHash) {
    return { ok: false, reason: "Lineage refuses report-hash-as-executable" };
  }
  if (report.evaluation.unknown && report.evaluation.untouchedTestReturnPct != null) {
    return { ok: false, reason: "Lineage forbids forged untouched metrics while unknown=true" };
  }
  if (
    report.hashes.sourceHash !== input.sourceHash ||
    report.hashes.executableHash !== input.artifactHash ||
    report.hashes.configHash !== input.configHash
  ) {
    return { ok: false, reason: "Report lineage evaluated a different source/executable/config than requested" };
  }
  const upstream = ancestors(input.chain, report);
  const experiment = upstream.find((n) => n.kind === "EXPERIMENT");
  const dataset = upstream.find((n) => n.kind === "DATASET");
  const hypothesis = upstream.find((n) => n.kind === "HYPOTHESIS");
  if (!experiment || !dataset || !hypothesis) {
    return {
      ok: false,
      reason: `Lineage is incomplete: report must descend from ${[
        !experiment && "EXPERIMENT",
        !dataset && "DATASET",
        !hypothesis && "HYPOTHESIS",
      ]
        .filter(Boolean)
        .join(", ")}`,
    };
  }
  if (hypothesis.meta?.persisted !== true) {
    return { ok: false, reason: `Hypothesis ${hypothesis.id} is not a persisted record` };
  }
  if (!dataset.hashes.datasetHash || dataset.hashes.datasetHash !== report.hashes.datasetHash) {
    return { ok: false, reason: "Dataset lineage hash does not match the report dataset hash" };
  }
  const approval = input.approvalId
    ? input.chain.nodes.find((n) => n.kind === "APPROVAL" && n.id === input.approvalId)
    : [...input.chain.nodes].reverse().find((n) => n.kind === "APPROVAL" && n.parentId === report.id);
  if (!approval) {
    return { ok: false, reason: "Validated promotion requires a durable APPROVAL lineage node for this report" };
  }
  if (approval.parentId !== report.id || approval.hashes.reportHash !== report.hashes.reportHash) {
    return { ok: false, reason: `Approval ${approval.id} belongs to a different report` };
  }
  if (approval.meta?.decision !== "APPROVED") {
    return { ok: false, reason: `Approval ${approval.id} is not an APPROVED decision` };
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
