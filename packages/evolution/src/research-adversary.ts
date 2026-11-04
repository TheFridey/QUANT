/**
 * GENESIS Phase 8 adversarial reviewer: a deterministic CHALLENGE-stage check over the TEST record. It runs before
 * the ASCEND-08 challenge review and the model reviewer, and any finding rejects the candidate with reason codes.
 * It never passes something the other reviewers reject; it only adds reasons to reject.
 *
 * Reason codes:
 * - LEAKAGE_AVAILABLE_AT: a bar used was available after the as-of time, the as-of time is after the measurement,
 *   or the point-in-time evidence is missing.
 * - INSUFFICIENT_SAMPLE: fewer bars than the validator floor, or fewer closed trades (full window or holdout) than
 *   the strategy's minimum sample.
 * - MISSING_COSTS: no positive per-side cost or no recorded cost basis.
 * - UNSTABLE_FOLDS: fewer than `MIN_MEASURED_FOLDS` walk-forward folds with trades, fewer than half of them
 *   net-positive, or the candidate does not survive double cost on a proxy cost basis.
 * - REUSED_DATA: no redundancy check recorded, or the holdout for this candidate was consumed by another run.
 */

export const MIN_MEASURED_FOLDS = 3;

export type AdversaryCode = "LEAKAGE_AVAILABLE_AT" | "INSUFFICIENT_SAMPLE" | "MISSING_COSTS" | "UNSTABLE_FOLDS" | "REUSED_DATA";

export type AdversaryFinding = { code: AdversaryCode; detail: string };

export type AdversaryReport = { passed: boolean; reasonCodes: AdversaryCode[]; findings: AdversaryFinding[] };

type Ctx = Record<string, unknown>;

const obj = (value: unknown): Ctx => (value && typeof value === "object" && !Array.isArray(value) ? (value as Ctx) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const time = (value: unknown): number | null => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

export function reviewResearchEvidence(input: {
  test: Ctx;
  minBars: number;
  minSampleTrades: number;
  /** True when a ResearchHoldoutAccess row for this candidate exists with a run other than this experiment. */
  holdoutConsumedElsewhere: boolean;
}): AdversaryReport {
  const findings: AdversaryFinding[] = [];
  const { test } = input;
  const dataset = obj(test.dataset);
  const cost = obj(test.cost);

  const asOf = time(dataset.asOf);
  const maxAvailableAt = time(dataset.maxAvailableAt);
  const measuredAt = time(test.measuredAt);
  if (asOf === null || maxAvailableAt === null || measuredAt === null) {
    findings.push({ code: "LEAKAGE_AVAILABLE_AT", detail: "Point-in-time evidence (asOf, maxAvailableAt, measuredAt) not recorded" });
  } else {
    if (maxAvailableAt > asOf) findings.push({ code: "LEAKAGE_AVAILABLE_AT", detail: `A bar available at ${String(dataset.maxAvailableAt)} is after as-of ${String(dataset.asOf)}` });
    if (asOf > measuredAt) findings.push({ code: "LEAKAGE_AVAILABLE_AT", detail: `As-of ${String(dataset.asOf)} is after the measurement at ${String(test.measuredAt)}` });
  }

  const bars = num(dataset.barCount) ?? 0;
  const trades = num(test.measuredSampleSize) ?? 0;
  const holdoutTrades = num(test.untouchedSampleSize) ?? 0;
  if (bars < input.minBars) findings.push({ code: "INSUFFICIENT_SAMPLE", detail: `${bars} bars < ${input.minBars}` });
  if (trades < input.minSampleTrades) findings.push({ code: "INSUFFICIENT_SAMPLE", detail: `${trades} closed trades < ${input.minSampleTrades}` });
  if (holdoutTrades < 1) findings.push({ code: "INSUFFICIENT_SAMPLE", detail: "No closed trade in the untouched holdout" });

  const bps = num(cost.bpsPerSide);
  if (bps === null || bps <= 0 || typeof cost.basis !== "string" || cost.basis.length === 0) {
    findings.push({ code: "MISSING_COSTS", detail: "No positive per-side cost with a recorded basis" });
  }

  const folds = Array.isArray(test.folds) ? test.folds.map(obj) : [];
  const measured = folds.filter((fold) => (num(fold.trades) ?? 0) > 0 && num(fold.netReturn) !== null);
  if (measured.length < MIN_MEASURED_FOLDS) {
    findings.push({ code: "UNSTABLE_FOLDS", detail: `${measured.length} walk-forward folds with trades < ${MIN_MEASURED_FOLDS}` });
  } else {
    const positive = measured.filter((fold) => (num(fold.netReturn) ?? 0) > 0).length;
    if (positive * 2 < measured.length) findings.push({ code: "UNSTABLE_FOLDS", detail: `Only ${positive}/${measured.length} folds net-positive` });
  }
  const doubleCost = num(test.fullNetReturnDoubleCost);
  if (cost.isProxy === true && doubleCost !== null && doubleCost <= 0) {
    findings.push({ code: "UNSTABLE_FOLDS", detail: `Net return at double cost is ${(doubleCost * 100).toFixed(2)}% on a proxy cost basis` });
  }

  const redundancy = obj(test.redundancy);
  if (!Array.isArray(redundancy.checked) || typeof obj(test.candidate).fingerprint !== "string") {
    findings.push({ code: "REUSED_DATA", detail: "No redundancy check or candidate identity recorded" });
  }
  if (input.holdoutConsumedElsewhere) findings.push({ code: "REUSED_DATA", detail: "This candidate's holdout was consumed by another run" });

  const reasonCodes = [...new Set(findings.map((finding) => finding.code))];
  return { passed: findings.length === 0, reasonCodes, findings };
}
