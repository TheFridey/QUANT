import { createHash } from "node:crypto";
import type { PrismaClient } from "@odin/shared/db";
import { hashEvidence } from "./lifecycle.js";

/**
 * GENESIS Phase 8 redundancy guard, run before TEST spends anything (no sandbox run, no approval request):
 *
 * - DUPLICATE_EXPERIMENT: another experiment already measured the same candidate fingerprint (strategy family +
 *   canonical source + parameter hash) on the same dataset version.
 * - RENAMED_CANDIDATE: the same canonical source was already measured on this instrument and interval under a
 *   different strategy name. Identity is the canonical source, never the name.
 * - HOLDOUT_REUSED: a `ResearchHoldoutAccess` row already exists for this candidate (name-independent key) or for
 *   its strategy name, on this dataset or any sibling dataset of the same instrument and interval (the
 *   SINGULARITY-00 holdout policy), or the same hypothesis already measured this dataset version under any source. The unique key (strategy × version × dataset) backs the exact case in the DB.
 */

export const CANDIDATE_IDENTITY_VERSION = "canonical-v1";
/** `ResearchHoldoutAccess.strategyVersion` for loop candidates: the key is the canonical source, not a version label. */
export const LOOP_HOLDOUT_STRATEGY_VERSION = CANDIDATE_IDENTITY_VERSION;

export type RedundancyCode = "DUPLICATE_EXPERIMENT" | "RENAMED_CANDIDATE" | "HOLDOUT_REUSED";

/**
 * Source with comments removed and whitespace runs collapsed, string and template literals kept verbatim, so a
 * reformatted or re-commented copy of the same code has the same identity. A gap is kept only between two word
 * characters, so rare spacing-significant code (`a - -b` vs `a--b`) can share an identity: that errs towards
 * refusing a candidate, never towards a fresh look at a holdout.
 */
export function canonicalStrategySource(source: string): string {
  let out = "";
  let pending = false;
  // A dropped gap survives only between two word characters (where it separates tokens).
  const emit = (text: string) => {
    if (pending && /[A-Za-z0-9_$]$/.test(out) && /^[A-Za-z0-9_$]/.test(text)) out += " ";
    pending = false;
    out += text;
  };
  let index = 0;
  const n = source.length;
  while (index < n) {
    const ch = source[index]!;
    const next = source[index + 1];
    if (ch === "/" && next === "/") {
      while (index < n && source[index] !== "\n") index += 1;
      pending = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < n && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      pending = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let literal = ch;
      index += 1;
      while (index < n) {
        const c = source[index]!;
        literal += c;
        index += 1;
        if (c === "\\" && index < n) {
          literal += source[index]!;
          index += 1;
          continue;
        }
        if (c === ch) break;
      }
      emit(literal);
      continue;
    }
    if (/\s/.test(ch)) {
      while (index < n && /\s/.test(source[index]!)) index += 1;
      pending = true;
      continue;
    }
    emit(ch);
    index += 1;
  }
  return out.trim();
}

export type CandidateIdentity = {
  version: string;
  family: string;
  canonicalSourceHash: string;
  paramHash: string;
  fingerprint: string;
  /** Name-independent `ResearchHoldoutAccess.strategyId` for this candidate. */
  holdoutStrategyId: string;
  /** The forged (name-derived) strategy id, kept for the renamed check and the audit trail. */
  strategyId: string;
};

export function candidateIdentity(input: { source: string; family: string; params: Record<string, unknown>; strategyId: string }): CandidateIdentity {
  const canonicalSourceHash = createHash("sha256").update(canonicalStrategySource(input.source)).digest("hex");
  const paramHash = hashEvidence(input.params);
  const fingerprint = hashEvidence({ version: CANDIDATE_IDENTITY_VERSION, family: input.family, canonicalSourceHash, paramHash });
  return {
    version: CANDIDATE_IDENTITY_VERSION,
    family: input.family,
    canonicalSourceHash,
    paramHash,
    fingerprint,
    holdoutStrategyId: `rlc_${canonicalSourceHash.slice(0, 40)}`,
    strategyId: input.strategyId,
  };
}

export type RedundancyReader = Pick<PrismaClient, "researchExperimentEvent" | "researchHoldoutAccess" | "historicalDataset">;

export type RedundancyDecision =
  | { ok: true; evidence: Record<string, unknown> }
  | { ok: false; code: RedundancyCode; detail: string; evidence: Record<string, unknown> };

/** Measured experiments are the TEST -> CHALLENGE transitions; their evidence carries `candidate` and `dataset`. */
const MEASURED = { kind: "TRANSITION", fromState: "TEST", toState: "CHALLENGE" } as const;

export async function checkRedundancy(
  reader: RedundancyReader,
  input: {
    experimentId: string;
    hypothesisId: string;
    identity: CandidateIdentity;
    dataset: { datasetId: string; versionHash: string; instrumentKey: string; interval: string };
  },
): Promise<RedundancyDecision> {
  const { identity, dataset } = input;
  const base = { fingerprint: identity.fingerprint, canonicalSourceHash: identity.canonicalSourceHash, datasetId: dataset.datasetId, versionHash: dataset.versionHash };
  const duplicate = await reader.researchExperimentEvent.findFirst({
    where: {
      ...MEASURED,
      experimentId: { not: input.experimentId },
      AND: [
        { evidence: { path: ["candidate", "fingerprint"], equals: identity.fingerprint } },
        { evidence: { path: ["dataset", "datasetId"], equals: dataset.datasetId } },
        { evidence: { path: ["dataset", "versionHash"], equals: dataset.versionHash } },
      ],
    },
    select: { experimentId: true, createdAt: true },
  });
  if (duplicate) {
    return { ok: false, code: "DUPLICATE_EXPERIMENT", detail: `Experiment ${duplicate.experimentId} already measured this candidate on dataset version ${dataset.versionHash.slice(0, 12)}`, evidence: { ...base, priorExperimentId: duplicate.experimentId } };
  }
  const sameSource = await reader.researchExperimentEvent.findMany({
    where: {
      ...MEASURED,
      experimentId: { not: input.experimentId },
      AND: [
        { evidence: { path: ["candidate", "canonicalSourceHash"], equals: identity.canonicalSourceHash } },
        { evidence: { path: ["dataset", "instrumentKey"], equals: dataset.instrumentKey } },
        { evidence: { path: ["dataset", "interval"], equals: dataset.interval } },
      ],
    },
    select: { experimentId: true, evidence: true },
    take: 20,
  });
  const renamed = sameSource.find((event) => {
    const candidate = (event.evidence as Record<string, unknown> | null)?.candidate as Record<string, unknown> | undefined;
    return typeof candidate?.strategyId === "string" && candidate.strategyId !== identity.strategyId;
  });
  if (renamed) {
    const prior = ((renamed.evidence as Record<string, unknown>).candidate as Record<string, unknown>).strategyId;
    return { ok: false, code: "RENAMED_CANDIDATE", detail: `Same canonical source was measured on ${dataset.instrumentKey}/${dataset.interval} as ${String(prior)} (experiment ${renamed.experimentId})`, evidence: { ...base, priorExperimentId: renamed.experimentId, priorStrategyId: prior, strategyId: identity.strategyId } };
  }
  // One holdout look per hypothesis × dataset version: a model writes new source on every retry, so a fresh
  // canonical hash must not buy the same hypothesis another look at the same bars.
  const sameHypothesis = await reader.researchExperimentEvent.findFirst({
    where: {
      ...MEASURED,
      experimentId: { not: input.experimentId },
      experiment: { hypothesisId: input.hypothesisId },
      AND: [
        { evidence: { path: ["dataset", "datasetId"], equals: dataset.datasetId } },
        { evidence: { path: ["dataset", "versionHash"], equals: dataset.versionHash } },
      ],
    },
    select: { experimentId: true },
  });
  if (sameHypothesis) {
    return { ok: false, code: "HOLDOUT_REUSED", detail: `Hypothesis ${input.hypothesisId} already looked at the holdout of dataset version ${dataset.versionHash.slice(0, 12)} (experiment ${sameHypothesis.experimentId})`, evidence: { ...base, scope: "HYPOTHESIS_DATASET_VERSION", priorExperimentId: sameHypothesis.experimentId } };
  }
  const siblings = await reader.historicalDataset.findMany({ where: { instrumentKey: dataset.instrumentKey, interval: dataset.interval }, select: { id: true } });
  const siblingIds = [...new Set([dataset.datasetId, ...siblings.map((row) => row.id)])];
  const holdout = await reader.researchHoldoutAccess.findFirst({
    where: { datasetId: { in: siblingIds }, strategyId: { in: [identity.holdoutStrategyId, identity.strategyId] } },
    select: { id: true, strategyId: true, strategyVersion: true, datasetId: true, runId: true },
  });
  if (holdout) {
    return { ok: false, code: "HOLDOUT_REUSED", detail: `Holdout on ${dataset.instrumentKey}/${dataset.interval} already consumed by ${holdout.strategyId}@${holdout.strategyVersion} (run ${holdout.runId})`, evidence: { ...base, holdoutAccessId: holdout.id, holdoutDatasetId: holdout.datasetId, holdoutRunId: holdout.runId } };
  }
  return { ok: true, evidence: { ...base, checked: ["DUPLICATE_EXPERIMENT", "RENAMED_CANDIDATE", "HOLDOUT_REUSED"], siblingDatasets: siblingIds.length } };
}
