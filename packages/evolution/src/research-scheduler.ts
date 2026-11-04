import type { Prisma } from "@odin/shared/db";
import { isTerminalExperimentState } from "./research-loop-states.js";

/**
 * GENESIS Phase 8 task selection for autonomous intake. Deterministic: the same inputs always give the same queue.
 *
 * Eligibility (checked first; skipped hypotheses are reported with the reason):
 * - ACTIVE_OR_IN_REVIEW: the hypothesis already has a non-terminal experiment (including REVIEW).
 * - OPERATOR_ABANDONED: an earlier experiment of the hypothesis was ABANDONED (an operator decision is not retried).
 * - NO_NEW_EVIDENCE: earlier experiments all ended (REJECTED or FAILED) and the dataset HYPOTHESISE would pin now
 *   (`choosePinnedDataset`: most bars, then lowest id, the order `pinResearchDataset` uses) has the same id and
 *   versionHash as one an earlier experiment was pinned to. A failed hypothesis is retried only on new data for that
 *   choice; another dataset of the hypothesis that would never be pinned is not new evidence.
 *
 * Score (integers; higher first):
 * - knowledgeGap = floor(400 / (1 + measured trials on the dataset it would pin)); 0 when it has no dataset.
 * - familyGap    = floor(200 / (1 + measured trials in its strategy family)).
 * - newData      = 300 when it was tried before and a dataset version changed since (the retry reason).
 * - untried      = 100 when it never had an experiment.
 * A hypothesis with no dataset scores 0 and is eligible only once (its experiment records DATASET_UNAVAILABLE).
 * Ties: earlier hypothesis createdAt first, then lower id.
 */

export type TaskCandidate = {
  hypothesisId: string;
  createdAt: string;
  family: string;
  datasets: Array<{ datasetId: string; versionHash: string; barCount: number }>;
  priorExperiments: Array<{ state: string; pinned: { datasetId: string; versionHash: string } | null }>;
};

export type TaskStats = { trialsByDataset: Record<string, number>; trialsByFamily: Record<string, number> };

export type ScoredTask = {
  hypothesisId: string;
  rank: number;
  score: number;
  components: { knowledgeGap: number; familyGap: number; newData: number; untried: number };
};

export type TaskSkip = { hypothesisId: string; reason: "ACTIVE_OR_IN_REVIEW" | "OPERATOR_ABANDONED" | "NO_NEW_EVIDENCE" };

export const TASK_SCORER_VERSION = "genesis-scorer-1";

/** The dataset HYPOTHESISE would pin: most bars, then lowest id (the same order as `pinResearchDataset`). */
export function choosePinnedDataset<T extends { datasetId: string; barCount: number }>(datasets: readonly T[]): T | null {
  return [...datasets].sort((a, b) => b.barCount - a.barCount || (a.datasetId < b.datasetId ? -1 : a.datasetId > b.datasetId ? 1 : 0))[0] ?? null;
}

export function familyOfMarket(market: string): string {
  return `FORGED_SANDBOX:${market}`;
}

export function scoreResearchTasks(candidates: readonly TaskCandidate[], stats: TaskStats): { ranked: ScoredTask[]; skipped: TaskSkip[] } {
  const skipped: TaskSkip[] = [];
  const scored: Array<Omit<ScoredTask, "rank"> & { createdAt: string }> = [];
  for (const candidate of candidates) {
    const prior = candidate.priorExperiments;
    if (prior.some((row) => !isTerminalExperimentState(row.state))) {
      skipped.push({ hypothesisId: candidate.hypothesisId, reason: "ACTIVE_OR_IN_REVIEW" });
      continue;
    }
    if (prior.some((row) => row.state === "ABANDONED")) {
      skipped.push({ hypothesisId: candidate.hypothesisId, reason: "OPERATOR_ABANDONED" });
      continue;
    }
    const tried = prior.length > 0;
    const pinned = new Set(prior.flatMap((row) => (row.pinned ? [`${row.pinned.datasetId}@${row.pinned.versionHash}`] : [])));
    const choice = choosePinnedDataset(candidate.datasets);
    const newEvidence = choice !== null && !pinned.has(`${choice.datasetId}@${choice.versionHash}`);
    if (tried && !newEvidence) {
      skipped.push({ hypothesisId: candidate.hypothesisId, reason: "NO_NEW_EVIDENCE" });
      continue;
    }
    const hasData = choice !== null;
    const fewestTrials = choice ? (stats.trialsByDataset[choice.datasetId] ?? 0) : 0;
    const components = {
      knowledgeGap: hasData ? Math.floor(400 / (1 + fewestTrials)) : 0,
      familyGap: hasData ? Math.floor(200 / (1 + (stats.trialsByFamily[candidate.family] ?? 0))) : 0,
      newData: hasData && tried && newEvidence ? 300 : 0,
      untried: hasData && !tried ? 100 : 0,
    };
    const score = components.knowledgeGap + components.familyGap + components.newData + components.untried;
    scored.push({ hypothesisId: candidate.hypothesisId, createdAt: candidate.createdAt, score, components });
  }
  scored.sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt) || (a.hypothesisId < b.hypothesisId ? -1 : a.hypothesisId > b.hypothesisId ? 1 : 0));
  return {
    ranked: scored.map(({ createdAt: _createdAt, ...row }, index) => {
      void _createdAt;
      return { ...row, rank: index + 1 };
    }),
    skipped,
  };
}

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The dataset an experiment was pinned to (HYPOTHESISE writes `context.dataset`), or null. */
export function pinnedOf(context: unknown): { datasetId: string; versionHash: string } | null {
  const dataset = obj(obj(context).dataset);
  return typeof dataset.datasetId === "string" && typeof dataset.versionHash === "string" ? { datasetId: dataset.datasetId, versionHash: dataset.versionHash } : null;
}

/** Reads what the scorer needs: up to `limit` OPEN hypotheses (oldest first), their experiments, datasets and trial counts. */
export async function gatherTaskCandidates(tx: Prisma.TransactionClient, limit = 100): Promise<{ candidates: TaskCandidate[]; stats: TaskStats }> {
  const open = await tx.hypothesis.findMany({
    where: { status: "OPEN" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, createdAt: true, market: true, instrumentIds: true },
  });
  const ids = open.map((row) => row.id);
  const instruments = [...new Set(open.flatMap((row) => row.instrumentIds))];
  const [experiments, datasets, measured] = await Promise.all([
    tx.researchExperiment.findMany({ where: { hypothesisId: { in: ids } }, select: { hypothesisId: true, state: true, context: true } }),
    tx.historicalDataset.findMany({
      where: { instrumentKey: { in: instruments }, versionHash: { not: null }, barCount: { gt: 0 } },
      orderBy: { id: "asc" },
      select: { id: true, instrumentKey: true, versionHash: true, barCount: true },
    }),
    // Measured experiments (TEST → CHALLENGE). The most recent 5 000 bound the read; older trials still count in
    // the programme totals recorded at VALIDATE.
    tx.researchExperimentEvent.findMany({
      where: { kind: "TRANSITION", fromState: "TEST", toState: "CHALLENGE" },
      orderBy: { createdAt: "desc" },
      take: 5_000,
      select: { evidence: true },
    }),
  ]);
  const stats: TaskStats = { trialsByDataset: {}, trialsByFamily: {} };
  for (const event of measured) {
    const evidence = obj(event.evidence);
    const datasetId = obj(evidence.dataset).datasetId;
    const family = obj(evidence.candidate).family;
    if (typeof datasetId === "string") stats.trialsByDataset[datasetId] = (stats.trialsByDataset[datasetId] ?? 0) + 1;
    if (typeof family === "string") stats.trialsByFamily[family] = (stats.trialsByFamily[family] ?? 0) + 1;
  }
  const candidates = open.map((row) => ({
    hypothesisId: row.id,
    createdAt: row.createdAt.toISOString(),
    family: familyOfMarket(row.market),
    datasets: datasets.filter((dataset) => row.instrumentIds.includes(dataset.instrumentKey)).map((dataset) => ({ datasetId: dataset.id, versionHash: dataset.versionHash!, barCount: dataset.barCount })),
    priorExperiments: experiments.filter((experiment) => experiment.hypothesisId === row.id).map((experiment) => ({ state: experiment.state, pinned: pinnedOf(experiment.context) })),
  }));
  return { candidates, stats };
}
