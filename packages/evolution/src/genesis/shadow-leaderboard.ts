import { blockBootstrapInterval, calibration } from "@odin/backtest/ml2";
import type { PrismaClient } from "@odin/shared/db";
import type { ModelState } from "./model-lifecycle.js";
import { modelStates } from "./model-registry.js";
import { parseShadowSpec, predictionRecordHash, type PredictionRecord } from "./shadow.js";

/**
 * GENESIS shadow leaderboard (read only). Evidence per model from hypothetical shadow outcomes only; never
 * from paper fills. "Net advantage" is the mean realised net return of the model's signals (p ≥ threshold)
 * minus the mean of every resolved prediction (the always-enter control on the same bars), with a
 * block-bootstrap CI whose block is at least the label horizon.
 */
export type LeaderboardInputRow = {
  decisionTime: number;
  horizonEndsAt: number;
  status: "PREDICTED" | "ABSTAINED";
  probability: number | null;
  abstainReasons: string[];
  hashOk: boolean;
  outcome: null | { available: boolean; net: number | null; positive: boolean | null };
};

export type LeaderboardRow = {
  predictions: number;
  abstained: number;
  coverage: number | null;
  resolved: number;
  unavailable: number;
  awaitingOutcome: number;
  overdue: number;
  open: number;
  calibration: { brier: number; ece: number; logLoss: number; baseRate: number; meanProbability: number; reliability: Array<{ lo: number; hi: number; n: number; meanP: number; observed: number }> } | null;
  signals: number;
  meanNetSignals: number | null;
  meanNetAll: number | null;
  netAdvantage: { estimate: number; lower: number; upper: number; blockLength: number; resamples: number; valid: number } | null;
  netAdvantageNote: string | null;
  failureReasons: Record<string, number>;
};

export const LEADERBOARD_MIN_RESOLVED = 30;
export const LEADERBOARD_MIN_SIGNALS = 10;

export function computeLeaderboardRow(input: { rows: LeaderboardInputRow[]; entryThreshold: number; horizonBars: number; now: number; graceMs: number; resamples?: number; seed?: number }): LeaderboardRow {
  const failureReasons: Record<string, number> = {};
  const bump = (k: string) => (failureReasons[k] = (failureReasons[k] ?? 0) + 1);
  const rows = input.rows.filter((r) => {
    if (!r.hashOk) bump("RECORD_HASH_MISMATCH");
    return r.hashOk;
  });
  const predicted = rows.filter((r) => r.status === "PREDICTED");
  const abstained = rows.filter((r) => r.status === "ABSTAINED");
  for (const r of abstained) for (const reason of r.abstainReasons) bump(reason.split(":")[0]!.trim() || "ABSTAINED");
  const resolved = predicted
    .filter((r) => r.outcome?.available && r.outcome.net !== null && r.outcome.positive !== null && r.probability !== null)
    .sort((a, b) => a.decisionTime - b.decisionTime);
  const unavailable = predicted.filter((r) => r.outcome && !r.outcome.available).length;
  if (unavailable) failureReasons.NO_HYPOTHETICAL_FILL = unavailable;
  const noOutcome = predicted.filter((r) => !r.outcome);
  const awaiting = noOutcome.filter((r) => r.horizonEndsAt <= input.now);
  const overdue = awaiting.filter((r) => r.horizonEndsAt + input.graceMs < input.now).length;
  if (overdue) failureReasons.OVERDUE_OUTCOME = overdue;

  const p = resolved.map((r) => r.probability!);
  const y = resolved.map((r) => (r.outcome!.positive ? 1 : 0));
  const net = resolved.map((r) => r.outcome!.net!);
  const cal = resolved.length ? calibration(p, y) : null;
  const selected = resolved.map((r) => r.probability! >= input.entryThreshold);
  const signals = selected.filter(Boolean).length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const meanNetSignals = mean(net.filter((_, i) => selected[i]));
  const meanNetAll = mean(net);

  let netAdvantage: LeaderboardRow["netAdvantage"] = null;
  let note: string | null = null;
  const blockLength = Math.max(1, input.horizonBars);
  if (resolved.length < LEADERBOARD_MIN_RESOLVED) note = `INSUFFICIENT_EVIDENCE: ${resolved.length} resolved outcomes (< ${LEADERBOARD_MIN_RESOLVED})`;
  else if (signals < LEADERBOARD_MIN_SIGNALS) note = `INSUFFICIENT_EVIDENCE: ${signals} signals (< ${LEADERBOARD_MIN_SIGNALS})`;
  else if (blockLength > resolved.length) note = "INSUFFICIENT_EVIDENCE: fewer outcomes than one bootstrap block";
  else {
    const statistic = (positions: number[]) => {
      let sAll = 0;
      let sSel = 0;
      let nSel = 0;
      for (const i of positions) {
        sAll += net[i]!;
        if (selected[i]) {
          sSel += net[i]!;
          nSel += 1;
        }
      }
      return nSel ? sSel / nSel - sAll / positions.length : null;
    };
    const ci = blockBootstrapInterval(resolved.length, statistic, { blockLength, minBlockLength: input.horizonBars, resamples: input.resamples ?? 1000, seed: input.seed ?? 1, scheme: "STATIONARY", confidence: 0.95 });
    if (ci) netAdvantage = { estimate: ci.estimate, lower: ci.lower, upper: ci.upper, blockLength: ci.blockLength, resamples: ci.resamples, valid: ci.valid };
    else note = "INSUFFICIENT_EVIDENCE: bootstrap did not produce an interval";
  }

  return {
    predictions: predicted.length,
    abstained: abstained.length,
    coverage: rows.length ? predicted.length / rows.length : null,
    resolved: resolved.length,
    unavailable,
    awaitingOutcome: awaiting.length,
    overdue,
    open: noOutcome.length - awaiting.length,
    calibration: cal && { brier: cal.brier, ece: cal.ece, logLoss: cal.logLoss, baseRate: mean(y)!, meanProbability: mean(p)!, reliability: cal.reliability },
    signals,
    meanNetSignals,
    meanNetAll,
    netAdvantage,
    netAdvantageNote: note,
    failureReasons,
  };
}

export type ShadowLeaderboardEntry = LeaderboardRow & {
  modelVersionId: string;
  family: string;
  version: string;
  state: ModelState | "UNKNOWN";
  stateReason: string | null;
  evidence: "HYPOTHETICAL_SHADOW";
};

/** Leaderboard over every model with shadow rows (or `modelIds`), newest `limitPerModel` rows per model. */
export async function shadowLeaderboard(prisma: PrismaClient, input: { now?: Date; modelIds?: string[]; limitPerModel?: number } = {}): Promise<ShadowLeaderboardEntry[]> {
  const now = (input.now ?? new Date()).getTime();
  const limit = Math.min(Math.max(1, input.limitPerModel ?? 5_000), 20_000);
  const ids =
    input.modelIds ??
    (await prisma.modelVersion.findMany({ where: { predictions: { some: {} } }, select: { id: true } })).map((m) => m.id);
  if (!ids.length) return [];
  const [models, states] = await Promise.all([prisma.modelVersion.findMany({ where: { id: { in: ids } } }), modelStates(prisma, ids)]);
  const out: ShadowLeaderboardEntry[] = [];
  for (const model of models) {
    const rows = await prisma.shadowPrediction.findMany({ where: { modelVersionId: model.id }, include: { outcome: true }, orderBy: { decisionTime: "desc" }, take: limit });
    let threshold = 0.55;
    try {
      threshold = parseShadowSpec(model).entryThreshold;
    } catch {
      // A model without a shadow spec has no rows; keep the default for display.
    }
    const horizonBars = rows[0]?.horizonBars ?? (model.labelDefinition as { horizon?: number }).horizon ?? 1;
    const barMs = rows[0]?.barMs ?? 0;
    const row = computeLeaderboardRow({
      rows: rows.map((r) => ({
        decisionTime: r.decisionTime.getTime(),
        horizonEndsAt: r.horizonEndsAt.getTime(),
        status: r.status as "PREDICTED" | "ABSTAINED",
        probability: r.probability,
        abstainReasons: r.abstainReasons,
        hashOk: predictionRecordHash({ ...r, status: r.status as PredictionRecord["status"], features: r.features as Record<string, number | null> }) === r.recordHash,
        outcome: r.outcome && { available: r.outcome.hypotheticalFillAvailable, net: r.outcome.realisedNetReturn, positive: r.outcome.positive },
      })),
      entryThreshold: threshold,
      horizonBars,
      now,
      graceMs: horizonBars * barMs,
    });
    const head = states.get(model.id);
    const last = head ? await prisma.modelLifecycleEvent.findUnique({ where: { modelVersionId_seq: { modelVersionId: model.id, seq: head.seq } }, select: { reason: true } }) : null;
    if (head && (head.state === "REJECTED" || head.state === "FAILED")) row.failureReasons[`${head.state}: ${last?.reason.split(":")[0] ?? ""}`.trim()] = 1;
    out.push({ ...row, modelVersionId: model.id, family: model.family, version: model.version, state: head?.state ?? "UNKNOWN", stateReason: last?.reason ?? null, evidence: "HYPOTHETICAL_SHADOW" });
  }
  return out.sort((a, b) => (b.netAdvantage?.lower ?? Number.NEGATIVE_INFINITY) - (a.netAdvantage?.lower ?? Number.NEGATIVE_INFINITY));
}
