import { mean } from "./stats.js";

/**
 * ASCEND-06 §3.5 exit research. Replays alternative exit policies over the same recorded mid-price paths
 * and compares them with the fixed-percentage policy. Research-only: nothing here changes engine exits.
 *
 * Risk is never widened to improve results. Every policy is held to the fixed policy's dollar risk per
 * trade: a policy with a wider stop trades proportionally smaller (size × stop distance is constant), and
 * its stop is capped by `maxStopPct`. Gap-through stops fill at the observed mid, never at the trigger.
 */

export type ExitPolicy =
  | { kind: "FIXED"; stopPct: number; targetPct: number }
  | { kind: "VOL_SCALED"; stopSigmas: number; targetSigmas: number; maxStopPct: number }
  | { kind: "TIME_STOP"; stopPct: number; targetPct: number; maxSteps: number }
  | { kind: "TRAILING"; stopPct: number; trailPct: number; breakEvenAtPct: number | null };

export type ExitPath = {
  tradeId: string;
  /** Chronological mids from the entry observation (index 0) onward; no observations before entry. */
  mids: number[];
  /** σ of one-step returns, bps, measured strictly before entry (point-in-time). */
  preEntryStepVolBps: number | null;
  /** Round-trip cost in bps of notional at the fixed policy's size, and its sensitivity to size. */
  costBpsAtBaseSize: number;
  /** Fraction of cost that scales with size (impact); the rest is spread + fees. 0 for quoted markets. */
  impactShareOfCost: number;
};

export type ExitOutcome = {
  tradeId: string;
  exitStep: number;
  exitReason: "STOP" | "TARGET" | "TIME" | "TRAIL" | "END_OF_PATH";
  grossReturnPct: number;
  sizeMultiplier: number;
  /** Net P&L in units of the fixed policy's dollar risk (R multiples). */
  netR: number;
};

function stopFor(policy: ExitPolicy, path: ExitPath): { stopPct: number; targetPct: number } | null {
  switch (policy.kind) {
    case "FIXED":
    case "TIME_STOP":
      return { stopPct: policy.stopPct, targetPct: policy.targetPct };
    case "TRAILING":
      return { stopPct: policy.stopPct, targetPct: Number.POSITIVE_INFINITY };
    case "VOL_SCALED": {
      if (path.preEntryStepVolBps === null || path.preEntryStepVolBps <= 0) return null;
      const sigmaPct = path.preEntryStepVolBps / 100;
      return {
        stopPct: Math.min(policy.maxStopPct, policy.stopSigmas * sigmaPct),
        targetPct: policy.targetSigmas * sigmaPct,
      };
    }
  }
}

export function replayExit(policy: ExitPolicy, path: ExitPath, baseStopPct: number): ExitOutcome | null {
  const levels = stopFor(policy, path);
  if (!levels || path.mids.length < 2) return null;
  const entry = path.mids[0]!;
  // Constant dollar risk: size scales by baseStop / stop. Never larger than the base size.
  const sizeMultiplier = Math.min(1, baseStopPct / levels.stopPct);
  let stopLevel = entry * (1 - levels.stopPct / 100);
  const targetLevel = entry * (1 + levels.targetPct / 100);
  let peak = entry;
  let exitStep = path.mids.length - 1;
  let exitReason: ExitOutcome["exitReason"] = "END_OF_PATH";
  for (let i = 1; i < path.mids.length; i += 1) {
    const m = path.mids[i]!;
    if (m <= stopLevel) {
      exitStep = i;
      exitReason = policy.kind === "TRAILING" && stopLevel > entry * (1 - levels.stopPct / 100) ? "TRAIL" : "STOP";
      break;
    }
    if (m >= targetLevel) {
      exitStep = i;
      exitReason = "TARGET";
      break;
    }
    if (policy.kind === "TIME_STOP" && i >= policy.maxSteps) {
      exitStep = i;
      exitReason = "TIME";
      break;
    }
    if (policy.kind === "TRAILING") {
      peak = Math.max(peak, m);
      // The trailing stop only ever tightens; it never moves below the initial stop.
      stopLevel = Math.max(stopLevel, peak * (1 - policy.trailPct / 100));
      if (policy.breakEvenAtPct !== null && peak >= entry * (1 + policy.breakEvenAtPct / 100)) stopLevel = Math.max(stopLevel, entry);
    }
  }
  const grossReturnPct = (path.mids[exitStep]! / entry - 1) * 100;
  // Impact scales with size; spread and fees do not (in bps).
  const costBps = path.costBpsAtBaseSize * (1 - path.impactShareOfCost + path.impactShareOfCost * sizeMultiplier);
  const netPct = grossReturnPct - costBps / 100;
  return { tradeId: path.tradeId, exitStep, exitReason, grossReturnPct, sizeMultiplier, netR: (netPct * sizeMultiplier) / baseStopPct };
}

export type ExitPolicyComparison = {
  policy: ExitPolicy;
  n: number;
  skipped: number;
  meanNetR: number | null;
  /** Mean of (policy − fixed) on the trades both could evaluate. */
  meanNetRDeltaVsFixed: number | null;
  stopRate: number | null;
  meanExitStep: number | null;
};

export function compareExitPolicies(input: { fixed: Extract<ExitPolicy, { kind: "FIXED" }>; candidates: ExitPolicy[]; paths: ExitPath[] }): ExitPolicyComparison[] {
  const base = input.fixed.stopPct;
  const fixedOutcomes = new Map(input.paths.map((p) => [p.tradeId, replayExit(input.fixed, p, base)]));
  return [input.fixed, ...input.candidates].map((policy) => {
    const outcomes = input.paths.map((p) => replayExit(policy, p, base));
    const ok = outcomes.filter((o): o is ExitOutcome => o !== null);
    const deltas = ok
      .map((o) => {
        const f = fixedOutcomes.get(o.tradeId);
        return f ? o.netR - f.netR : null;
      })
      .filter((x): x is number => x !== null);
    return {
      policy,
      n: ok.length,
      skipped: outcomes.length - ok.length,
      meanNetR: mean(ok.map((o) => o.netR)),
      meanNetRDeltaVsFixed: mean(deltas),
      stopRate: ok.length ? ok.filter((o) => o.exitReason === "STOP").length / ok.length : null,
      meanExitStep: mean(ok.map((o) => o.exitStep)),
    };
  });
}
