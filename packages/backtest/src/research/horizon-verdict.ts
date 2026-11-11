import type { Ml2Verdict } from "./ml2.js";
import type { Verdict } from "./validate.js";

/**
 * Overall HORIZON verdict from per-hypothesis results (pure; research status only).
 *
 * A hypothesis is "pending holdout" only when every pre-holdout test passed AND its holdout is still unread.
 * A holdout that was already consumed is not pending: no further look is available, so the hypothesis needs new
 * bars. A hypothesis that failed costs, risk, overfit or minimum-sample rules never reaches its holdout and can
 * never make a study CANDIDATE_PENDING_HOLDOUT, whatever the holdout policy of the run.
 */

export type HorizonVerdict = "CANDIDATE" | "CANDIDATE_PENDING_HOLDOUT" | "NO_SKILL" | "INSUFFICIENT_EVIDENCE" | "REJECTED_DATA";

/**
 * NOT_REACHED: a pre-holdout test failed, so the holdout was never in question.
 * WITHHELD: every pre-holdout test passed; the run could not (or was not authorised to) read the holdout.
 * ALREADY_CONSUMED: every pre-holdout test passed but an earlier run read this holdout; it is not read again.
 * EVALUATED: read once, through a recording gate, in this run.
 */
export type HoldoutStatus = "NOT_REACHED" | "WITHHELD" | "ALREADY_CONSUMED" | "EVALUATED";

export type VerdictStrategyInput = {
  id: string;
  verdict: Verdict;
  walkForwardPassed: boolean;
  holdoutStatus: HoldoutStatus;
  /** Out-of-sample bars and trades; null when validation did not run. */
  oos: { bars: number; trades: number } | null;
};

export type VerdictMlInput = { horizonBars: number; refused: string } | { horizonBars: number; verdict: Ml2Verdict; holdoutStatus: HoldoutStatus };

export function strategyHoldoutStatus(input: { walkForwardPassed: boolean; holdoutEvaluated: boolean; gatePresent: boolean }): HoldoutStatus {
  if (input.holdoutEvaluated) return "EVALUATED";
  if (!input.walkForwardPassed) return "NOT_REACHED";
  return input.gatePresent ? "ALREADY_CONSUMED" : "WITHHELD";
}

/** ML 2.0 reports why a holdout was not evaluated as text; these are the two texts it writes after a pass. */
export function mlHoldoutStatus(holdout: { evaluated: boolean; reason?: string }): HoldoutStatus {
  if (holdout.evaluated) return "EVALUATED";
  const reason = holdout.reason ?? "";
  if (/^walk-forward passed; holdout withheld/.test(reason)) return "WITHHELD";
  if (/already consumed/.test(reason)) return "ALREADY_CONSUMED";
  return "NOT_REACHED";
}

export function composeHorizonVerdict(input: {
  strategies: readonly VerdictStrategyInput[];
  ml: readonly VerdictMlInput[];
  lateBars: number;
  bars: number;
  minBars: number;
  minOosTrades: number;
  programmeTrials: number;
}): { verdict: HorizonVerdict; reasons: string[]; pending: string[]; consumed: string[] } {
  const { strategies, ml } = input;
  const mlRan = ml.filter((m): m is Extract<VerdictMlInput, { verdict: Ml2Verdict }> => "verdict" in m);
  const reasons: string[] = [];

  const candidates = [...strategies.filter((s) => s.verdict === "VALIDATED_CANDIDATE").map((s) => s.id), ...mlRan.filter((m) => m.verdict === "CANDIDATE").map((m) => `ml2:h${m.horizonBars}`)];
  // The market's minimum-sample rule applies before a hypothesis may be called pending, not only after a holdout.
  const meetsSample = (s: VerdictStrategyInput) => s.oos !== null && s.oos.trades >= input.minOosTrades;
  const pending = [
    ...strategies.filter((s) => s.walkForwardPassed && s.holdoutStatus === "WITHHELD" && meetsSample(s)).map((s) => s.id),
    ...mlRan.filter((m) => m.holdoutStatus === "WITHHELD").map((m) => `ml2:h${m.horizonBars}`),
  ];
  const consumed = [
    ...strategies.filter((s) => s.walkForwardPassed && s.holdoutStatus === "ALREADY_CONSUMED").map((s) => s.id),
    ...mlRan.filter((m) => m.holdoutStatus === "ALREADY_CONSUMED").map((m) => `ml2:h${m.horizonBars}`),
  ];
  const underSampled = strategies.filter((s) => s.walkForwardPassed && s.holdoutStatus === "WITHHELD" && !meetsSample(s)).map((s) => s.id);
  const failedHoldout = [
    ...strategies.filter((s) => s.walkForwardPassed && s.holdoutStatus === "EVALUATED" && s.verdict !== "VALIDATED_CANDIDATE").map((s) => s.id),
    ...mlRan.filter((m) => m.holdoutStatus === "EVALUATED" && m.verdict !== "CANDIDATE").map((m) => `ml2:h${m.horizonBars}`),
  ];
  const ranStrategies = strategies.filter((s) => s.oos !== null && s.oos.bars > 0);
  const ranMl = mlRan.filter((m) => m.verdict !== "INSUFFICIENT_EVIDENCE");

  let verdict: HorizonVerdict;
  if (input.lateBars > 0 && mlRan.length === 0) {
    verdict = "REJECTED_DATA";
    reasons.push(`${input.lateBars} bar(s) arrived after their close and ML 2.0 did not run`);
  } else if (candidates.length > 0) {
    verdict = "CANDIDATE";
    reasons.push("At least one hypothesis passed walk-forward and a once-evaluated, recorded holdout. Research status only: never paper or live without operator approval");
  } else if (pending.length > 0) {
    verdict = "CANDIDATE_PENDING_HOLDOUT";
    reasons.push(`Walk-forward passed for ${pending.join(", ")}; the holdout was withheld, so this is not evidence of an edge yet`);
  } else if (consumed.length > 0) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`Walk-forward passed for ${consumed.join(", ")}, but the holdout was already consumed by an earlier run and is not read again; only bars after that holdout can confirm it`);
  } else if (underSampled.length > 0) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`Walk-forward passed for ${underSampled.join(", ")} with fewer than the market minimum of ${input.minOosTrades} out-of-sample trades`);
  } else if (failedHoldout.length > 0) {
    verdict = "NO_SKILL";
    reasons.push(`${failedHoldout.join(", ")} passed walk-forward but failed the once-read holdout; no hypothesis is a candidate after ${input.programmeTrials} programme trials`);
  } else if (ranStrategies.length > 0 || ranMl.length > 0) {
    verdict = "NO_SKILL";
    reasons.push(`No hypothesis survived walk-forward after costs and ${input.programmeTrials} programme trials`);
  } else {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`Not enough data for any test (${input.bars} bars; market minimum ${input.minBars})`);
  }
  return { verdict, reasons, pending, consumed };
}
