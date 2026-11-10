import { calibration } from "@odin/backtest/ml2";
import { computeLeaderboardRow, type LeaderboardInputRow } from "../genesis/shadow-leaderboard.js";
import { assessShadowHealth, DEFAULT_MONITOR_CONFIG } from "../genesis/shadow.js";

/**
 * OPERATION EVIDENCE: where a hypothesis stands (pure). Six states that must never be confused:
 *
 *  HISTORICAL_RESULT               a walk-forward result on past data (most end here, rejected, with a reason)
 *  PENDING_HOLDOUT                 passed every pre-holdout test; the holdout is unread
 *  HOLDOUT_EVALUATED               the holdout was read once (passed, failed, or consumed with the result lost)
 *  PROSPECTIVE_OBSERVATION         a frozen model is being scored on bars that did not exist when it was fitted
 *  SUFFICIENT_PROSPECTIVE_EVIDENCE the prospective sample meets the declared minimums below
 *  PAPER_EXECUTION_READINESS       never granted here: it needs the operator promotion process and, for
 *                                  non-crypto markets, protected execution changes
 *
 * None of these is an executable strategy. `executable` is always false.
 */
export const EVIDENCE_STAGES = ["HISTORICAL_RESULT", "PENDING_HOLDOUT", "HOLDOUT_EVALUATED", "PROSPECTIVE_OBSERVATION", "SUFFICIENT_PROSPECTIVE_EVIDENCE", "PAPER_EXECUTION_READINESS"] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

/** Declared minimums for "sufficient prospective evidence". Counts are of non-overlapping outcomes. */
export const PROSPECTIVE_MINIMUMS = { effectiveOutcomes: 30, effectiveSignals: 10, maxEce: DEFAULT_MONITOR_CONFIG.maxEce, maxBrierDecay: DEFAULT_MONITOR_CONFIG.maxBrierDecay } as const;

export type ProspectiveRow = LeaderboardInputRow & { costBpsApplied: number | null; estimatedCostBps: number; features: Record<string, number | null> | null };

export type ProspectiveEvidence = {
  evidence: "HYPOTHETICAL_SHADOW";
  predictions: number;
  abstained: number;
  open: number;
  awaitingOutcome: number;
  resolved: number;
  unavailable: number;
  /** Share of resolved outcomes whose horizon window overlaps the previous counted one. */
  overlapShare: number | null;
  /** Outcomes with non-overlapping horizon windows: the independent sample size. */
  effectiveOutcomes: number;
  effectiveSignals: number;
  signals: number;
  costs: { meanCostBpsApplied: number | null; estimatedCostBps: number | null };
  meanNetSignals: number | null;
  meanNetAll: number | null;
  /** Mean net of signals minus mean net of every resolved prediction, with a block-bootstrap interval. */
  netAdvantage: { estimate: number; lower: number; upper: number; blockLength: number } | null;
  uncertaintyNote: string | null;
  calibration: { brier: number; ece: number; baseRate: number } | null;
  drift: { referenceBrier: number | null; brierDecay: number | null; maxPsi: number | null; flags: string[] };
  integrityFailures: number;
  sufficient: boolean;
  missing: string[];
};

/** Prospective (shadow) evidence of one frozen model cohort. Missing measurements stay null, never zero. */
export function prospectiveEvidence(input: { rows: ProspectiveRow[]; entryThreshold: number; horizonBars: number; barMs: number; referenceBrier: number | null; featureNames: string[]; now: number }): ProspectiveEvidence {
  const board = computeLeaderboardRow({ rows: input.rows, entryThreshold: input.entryThreshold, horizonBars: input.horizonBars, now: input.now, graceMs: input.horizonBars * input.barMs });
  const ok = input.rows.filter((r) => r.hashOk);
  const resolved = ok
    .filter((r) => r.status === "PREDICTED" && r.outcome?.available && r.outcome.net !== null && r.outcome.positive !== null && r.probability !== null)
    .sort((a, b) => a.decisionTime - b.decisionTime);
  let effectiveOutcomes = 0;
  let effectiveSignals = 0;
  let lastEnd = Number.NEGATIVE_INFINITY;
  let lastSignalEnd = Number.NEGATIVE_INFINITY;
  for (const r of resolved) {
    if (r.decisionTime >= lastEnd) {
      effectiveOutcomes += 1;
      lastEnd = r.horizonEndsAt;
    }
    if (r.probability! >= input.entryThreshold && r.decisionTime >= lastSignalEnd) {
      effectiveSignals += 1;
      lastSignalEnd = r.horizonEndsAt;
    }
  }
  const costs = resolved.map((r) => r.costBpsApplied).filter((c): c is number => c !== null);
  const cal = resolved.length ? calibration(resolved.map((r) => r.probability!), resolved.map((r) => (r.outcome!.positive ? 1 : 0))) : null;
  const predicted = ok.filter((r) => r.status === "PREDICTED" && r.features);
  const window = DEFAULT_MONITOR_CONFIG.psiWindow;
  const health = assessShadowHealth({
    resolved: resolved.map((r) => ({ probability: r.probability!, positive: r.outcome!.positive! })),
    referenceBrier: input.referenceBrier,
    referenceFeatures: predicted.length >= 2 * window ? predicted.slice(0, window).map((r) => r.features!) : [],
    recentFeatures: predicted.length >= 2 * window ? predicted.slice(-window).map((r) => r.features!) : [],
    featureNames: input.featureNames,
    recentStatuses: ok.slice(-DEFAULT_MONITOR_CONFIG.window).map((r) => r.status),
  });
  const brierDecay = cal && input.referenceBrier !== null ? cal.brier - input.referenceBrier : null;
  const integrityFailures = input.rows.length - ok.length;
  const missing: string[] = [];
  if (effectiveOutcomes < PROSPECTIVE_MINIMUMS.effectiveOutcomes) missing.push(`${effectiveOutcomes} independent resolved outcomes (need ${PROSPECTIVE_MINIMUMS.effectiveOutcomes})`);
  if (effectiveSignals < PROSPECTIVE_MINIMUMS.effectiveSignals) missing.push(`${effectiveSignals} independent signals (need ${PROSPECTIVE_MINIMUMS.effectiveSignals})`);
  if (!board.netAdvantage) missing.push(`no confidence interval for the net advantage yet${board.netAdvantageNote ? ` (${board.netAdvantageNote})` : ""}`);
  else if (!(board.netAdvantage.lower > 0)) missing.push(`net advantage interval lower bound ${(board.netAdvantage.lower * 10_000).toFixed(1)} bps is not above 0`);
  if (!cal) missing.push("no calibration measurement yet");
  else if (cal.ece > PROSPECTIVE_MINIMUMS.maxEce) missing.push(`calibration error ${cal.ece.toFixed(3)} above ${PROSPECTIVE_MINIMUMS.maxEce}`);
  if (brierDecay !== null && brierDecay > PROSPECTIVE_MINIMUMS.maxBrierDecay) missing.push(`Brier score worse than walk-forward by ${brierDecay.toFixed(4)} (limit ${PROSPECTIVE_MINIMUMS.maxBrierDecay})`);
  if (health.reasons.length) missing.push(...health.reasons.map((r) => `drift or health flag: ${r}`));
  if (integrityFailures) missing.push(`${integrityFailures} stored prediction(s) failed their record hash`);
  return {
    evidence: "HYPOTHETICAL_SHADOW",
    predictions: board.predictions,
    abstained: board.abstained,
    open: board.open,
    awaitingOutcome: board.awaitingOutcome,
    resolved: board.resolved,
    unavailable: board.unavailable,
    overlapShare: resolved.length ? 1 - effectiveOutcomes / resolved.length : null,
    effectiveOutcomes,
    effectiveSignals,
    signals: board.signals,
    costs: { meanCostBpsApplied: costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null, estimatedCostBps: input.rows[0]?.estimatedCostBps ?? null },
    meanNetSignals: board.meanNetSignals,
    meanNetAll: board.meanNetAll,
    netAdvantage: board.netAdvantage && { estimate: board.netAdvantage.estimate, lower: board.netAdvantage.lower, upper: board.netAdvantage.upper, blockLength: board.netAdvantage.blockLength },
    uncertaintyNote: board.netAdvantageNote,
    calibration: cal && { brier: cal.brier, ece: cal.ece, baseRate: resolved.filter((r) => r.outcome!.positive).length / resolved.length },
    drift: { referenceBrier: input.referenceBrier, brierDecay, maxPsi: health.metrics.maxPsi, flags: health.reasons },
    integrityFailures,
    sufficient: missing.length === 0,
    missing,
  };
}

export type StageInput = {
  hypothesisKind: "STRATEGY" | "ML2";
  unitState: string;
  lastError: string | null;
  walkForward: { phase: string; verdict: string; walkForwardPassed: boolean; reasons: string[] } | null;
  holdout: { verdict: string; holdoutStatus: string; reasons: string[] } | null;
  holdoutAuthorised: boolean;
  model: { id: string; state: string; stateReason: string | null } | null;
  prospective: ProspectiveEvidence | null;
  /** Why the frozen result cannot be observed prospectively (null when it can). */
  shadowBlocker: string | null;
};

export type StageView = {
  stage: EvidenceStage | null;
  /** Short status within the stage. */
  status: string;
  why: string;
  missing: string[];
  nextSteps: string[];
  /** Always false: no state in this ladder is an executable strategy. */
  executable: false;
};

const PAPER_BLOCKERS = ["Paper execution is outside this workflow: it needs the operator promotion process and an approved strategy instance", "Research status never changes engine configuration, risk limits or strategy instances"];

export function evidenceStage(i: StageInput): StageView {
  const view = (stage: EvidenceStage | null, status: string, why: string, missing: string[], nextSteps: string[]): StageView => ({ stage, status, why, missing, nextSteps, executable: false });
  const wf = i.walkForward;
  if (!wf) {
    if (i.unitState === "PENDING" || i.unitState === "RUNNING") return view(null, i.unitState === "RUNNING" ? "RUNNING" : "QUEUED", "No result yet: the hypothesis has not finished running. Its outcome is unknown, not zero.", ["a walk-forward result"], ["Wait for the run to finish"]);
    return view(null, i.unitState, i.lastError ?? `The unit ended ${i.unitState} without a result. Its outcome is unknown, not zero.`, ["a walk-forward result"], ["Fix the cause and start an intentional rerun; this run keeps the failed attempt"]);
  }
  if (wf.phase === "DATA_REFUSAL") return view("HISTORICAL_RESULT", "DATA_REFUSED", wf.reasons[0] ?? "The dataset was refused before any trial ran.", ["a dataset that passes the integrity checks"], ["Repair or re-import the data, then declare a new campaign"]);
  if (!wf.walkForwardPassed) {
    return view("HISTORICAL_RESULT", wf.verdict, wf.reasons[0] ?? "Did not pass walk-forward.", ["a walk-forward pass after costs"], ["None on this data: the rejection stands. A different pre-declared hypothesis or genuinely new data is a new campaign"]);
  }
  const h = i.holdout;
  if (!h) {
    return view("PENDING_HOLDOUT", i.holdoutAuthorised ? "AUTHORISED_NOT_EVALUATED" : "WITHHELD", "Passed every pre-holdout test. This is not evidence of an edge until the holdout is read once.", ["the once-only holdout evaluation"], i.holdoutAuthorised ? ["Run the holdout evaluation before the authorisation expires"] : ["An operator authorises one holdout read for this exact result", "Then evaluate the holdout"]);
  }
  if (h.holdoutStatus === "CONSUMED_RESULT_LOST") return view("HOLDOUT_EVALUATED", "RESULT_LOST", h.reasons[0] ?? "The holdout was consumed but its result was not stored.", ["a holdout result (the consumed one cannot be recovered)"], ["Collect bars after the consumed period; this period is spent for this hypothesis family"]);
  const passedHoldout = h.verdict === "VALIDATED_CANDIDATE" || h.verdict === "CANDIDATE";
  if (!passedHoldout) return view("HOLDOUT_EVALUATED", "HOLDOUT_FAILED", h.reasons.at(-1) ?? `Holdout verdict ${h.verdict}.`, ["a holdout pass"], ["None on this data: the holdout was read once and failed"]);
  if (!i.model) {
    if (i.shadowBlocker) return view("HOLDOUT_EVALUATED", "HOLDOUT_PASSED_RESEARCH_ONLY", "Passed walk-forward and a once-read holdout on historical data. Research status only.", [`prospective observation: ${i.shadowBlocker}`, ...PAPER_BLOCKERS], ["No prospective route exists for this result yet"]);
    return view("HOLDOUT_EVALUATED", "HOLDOUT_PASSED_RESEARCH_ONLY", "Passed walk-forward and a once-read holdout on historical data. Research status only.", ["prospective observation of the frozen model", ...PAPER_BLOCKERS], ["Register the frozen artefact", "An operator moves it to SHADOW_CANDIDATE", "The shadow service must be enabled to score it"]);
  }
  if (i.model.state !== "SHADOW_CANDIDATE" && i.model.state !== "SHADOW_VALIDATED") {
    const ended = ["REJECTED", "FAILED", "RETIRED"].includes(i.model.state);
    if (ended) return view("PROSPECTIVE_OBSERVATION", `OBSERVATION_ENDED_${i.model.state}`, i.model.stateReason ?? `The model is ${i.model.state}.`, ["a model still under observation"], ["None for this model: its history is kept"]);
    if (i.model.state === "PAPER_CANDIDATE" || i.model.state === "PAPER_APPROVED") return view("SUFFICIENT_PROSPECTIVE_EVIDENCE", `MODEL_${i.model.state}`, "An operator labelled the model beyond shadow. That label grants no trading authority.", PAPER_BLOCKERS, ["Operator promotion process only"]);
    return view("HOLDOUT_EVALUATED", `MODEL_${i.model.state}`, "The frozen artefact is registered but not under observation.", ["prospective observation of the frozen model", ...PAPER_BLOCKERS], ["An operator moves the model to SHADOW_CANDIDATE"]);
  }
  const p = i.prospective;
  if (!p || !p.sufficient) {
    return view("PROSPECTIVE_OBSERVATION", p && p.predictions + p.abstained > 0 ? "COLLECTING" : "NO_PREDICTIONS_YET", "The frozen model is observed on new bars. No orders are created; outcomes are hypothetical.", [...(p?.missing ?? ["no shadow prediction has been recorded yet"]), ...PAPER_BLOCKERS], ["Keep observing until the declared minimums are met"]);
  }
  return view("SUFFICIENT_PROSPECTIVE_EVIDENCE", "MINIMUMS_MET", "Prospective outcomes meet the declared minimums. This is still not an executable strategy.", PAPER_BLOCKERS, ["Operator review; any paper use goes through the promotion process"]);
}
