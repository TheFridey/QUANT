import { chronologicalSplits } from "@odin/backtest";

export type TuningWindow = "train" | "validation" | "test";

/**
 * Walk-forward claim against the existing chronological 60/20/20 split.
 * Fitting on the untouched test window, or a second trial on the same dataset,
 * cannot be reported as out-of-sample confirmation.
 */
export function walkForwardClaim(input: {
  startAt: string;
  endAt: string;
  tunedOnWindow: TuningWindow;
  trialsOnDataset: number;
}): { outOfSample: boolean; testStart: string; testEnd: string; validationEnd: string; reason: string } {
  const split = chronologicalSplits(input.startAt, input.endAt);
  const base = { testStart: split.testStart, testEnd: split.testEnd, validationEnd: split.validationEnd };
  if (input.tunedOnWindow === "test") {
    return { ...base, outOfSample: false, reason: "Parameters were fit on the evaluation window" };
  }
  if (input.trialsOnDataset > 1) {
    return {
      ...base,
      outOfSample: false,
      reason: "Repeated testing on this dataset is recorded and is not a fresh confirmation",
    };
  }
  return { ...base, outOfSample: true, reason: "Untouched chronological test window" };
}
