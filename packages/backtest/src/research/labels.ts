import { createHash } from "node:crypto";
import { inferBarMs } from "./regime.js";
import type { ResearchBar } from "./simulate.js";

/**
 * GENESIS Phase 4 (ML Engine 2.0) executable labels. Research only: nothing here sizes or submits an order.
 *
 * A decision is taken at the close of bar i. The trade it describes is one QUANT could actually have made:
 * entry at the OPEN of bar i+1 (never the decision close), exit at the CLOSE of bar i+horizon unless a stop
 * or target is touched first. When one bar's range touches both, the stop is assumed first (conservative).
 * A bar that opens through the stop exits at its open (a gap is not filled at the stop price); a target is
 * never filled better than the target price. Costs (fee + spread/slippage, bps per side) are paid on both
 * sides. Every label records `endIndex`, the last bar it reads (always i+horizon: forward volatility and the
 * excursions read the whole horizon even when the trade exits early), so cross-validation can purge it.
 * Labels whose window crosses a gap in the bar grid are null rather than silently spanning a longer period.
 */

export const LABELS_VERSION = "labels-2.0.0";

export type LabelTarget = "NET_RETURN" | "NET_POSITIVE" | "FORWARD_VOL" | "MAE" | "MFE" | "TARGET_BEFORE_STOP";

export type LabelSpec = {
  /** Holding period in bars (≥ 1). */
  horizon: number;
  feeBpsPerSide: number;
  /** Spread + slippage estimate, bps per side. */
  slippageBpsPerSide: number;
  /** Stop distance below entry as a fraction (0.02 = 2%); null for none. */
  stopPct?: number | null;
  /** Target distance above entry as a fraction; null for none. */
  targetPct?: number | null;
};

export type TradeLabel = {
  index: number;
  /** Close of the decision bar (epoch ms): the time the decision is taken. */
  decisionTime: number;
  entryIndex: number;
  entryPrice: number;
  exitIndex: number;
  exitPrice: number;
  exitReason: "HORIZON" | "STOP" | "TARGET";
  /** Last bar index this label reads (purging boundary). */
  endIndex: number;
  /** Close of `endIndex` (epoch ms): when the label is fully known. */
  knownAt: number;
  grossReturn: number;
  /** Net of costs at 1× the spec's per-side cost. */
  netReturn: number;
  positive: 0 | 1;
  /** Sample sd of 1-bar log close returns over bars i+1..i+horizon (null when horizon < 2). */
  forwardVol: number | null;
  /** Worst low over the horizon relative to entry (≤ 0). */
  mae: number;
  /** Best high over the horizon relative to entry (≥ 0). */
  mfe: number;
  /** 1 when the target was hit before the stop; 0 on stop or timeout; null without both a stop and a target. */
  targetBeforeStop: 0 | 1 | null;
};

export function costPerSideFraction(spec: Pick<LabelSpec, "feeBpsPerSide" | "slippageBpsPerSide">, multiplier = 1): number {
  return ((spec.feeBpsPerSide + spec.slippageBpsPerSide) * multiplier) / 10_000;
}

/** Net return of a gross round trip when each side pays `costPerSide` (a fraction). */
export function netOfCost(grossReturn: number, costPerSide: number): number {
  return ((1 + grossReturn) * (1 - costPerSide)) / (1 + costPerSide) - 1;
}

export function labelSpecHash(spec: LabelSpec): string {
  const canonical = { version: LABELS_VERSION, horizon: spec.horizon, feeBpsPerSide: spec.feeBpsPerSide, slippageBpsPerSide: spec.slippageBpsPerSide, stopPct: spec.stopPct ?? null, targetPct: spec.targetPct ?? null };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validateSpec(spec: LabelSpec) {
  if (!Number.isInteger(spec.horizon) || spec.horizon < 1) throw new Error("label horizon must be a positive integer");
  if (!(spec.feeBpsPerSide >= 0) || !(spec.slippageBpsPerSide >= 0)) throw new Error("label costs must be non-negative");
  if (spec.stopPct != null && !(spec.stopPct > 0 && spec.stopPct < 1)) throw new Error("stopPct must be in (0, 1)");
  if (spec.targetPct != null && !(spec.targetPct > 0)) throw new Error("targetPct must be positive");
}

/** All labels for every decision bar; null where the window runs past the data or crosses a gap. */
export function buildTradeLabels(bars: readonly ResearchBar[], spec: LabelSpec, options: { barMs?: number } = {}): Array<TradeLabel | null> {
  validateSpec(spec);
  const barMs = options.barMs ?? inferBarMs(bars);
  const c = costPerSideFraction(spec);
  const h = spec.horizon;
  // contiguousTo[k] = last index reachable from bar k without a gap in the bar grid.
  const contiguousTo: number[] = new Array<number>(bars.length).fill(0);
  for (let k = bars.length - 1; k >= 0; k -= 1) {
    contiguousTo[k] = k + 1 < bars.length && bars[k + 1]!.t - bars[k]!.t === barMs ? contiguousTo[k + 1]! : k;
  }
  return bars.map((bar, i) => {
    const end = i + h;
    if (end >= bars.length || contiguousTo[i]! < end) return null;
    const entryIndex = i + 1;
    const entry = bars[entryIndex]!.open;
    if (!(entry > 0)) return null;
    const stop = spec.stopPct != null ? entry * (1 - spec.stopPct) : null;
    const target = spec.targetPct != null ? entry * (1 + spec.targetPct) : null;
    let exitIndex = end;
    let exitPrice = bars[end]!.close;
    let exitReason: TradeLabel["exitReason"] = "HORIZON";
    for (let k = entryIndex; k <= end; k += 1) {
      const b = bars[k]!;
      if (stop !== null && k > entryIndex && b.open <= stop) {
        exitIndex = k;
        exitPrice = b.open;
        exitReason = "STOP";
        break;
      }
      if (stop !== null && b.low <= stop) {
        // Conservative: when the same bar also reaches the target, the stop is assumed to come first.
        exitIndex = k;
        exitPrice = stop;
        exitReason = "STOP";
        break;
      }
      if (target !== null && b.high >= target) {
        exitIndex = k;
        exitPrice = target;
        exitReason = "TARGET";
        break;
      }
    }
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const rets: number[] = [];
    for (let k = entryIndex; k <= end; k += 1) {
      lo = Math.min(lo, bars[k]!.low);
      hi = Math.max(hi, bars[k]!.high);
      const prev = bars[k - 1]!.close;
      if (prev > 0 && bars[k]!.close > 0) rets.push(Math.log(bars[k]!.close / prev));
    }
    let forwardVol: number | null = null;
    if (rets.length >= 2) {
      const m = rets.reduce((s, r) => s + r, 0) / rets.length;
      forwardVol = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1));
    }
    const grossReturn = exitPrice / entry - 1;
    const netReturn = netOfCost(grossReturn, c);
    return {
      index: i,
      decisionTime: bar.t + barMs,
      entryIndex,
      entryPrice: entry,
      exitIndex,
      exitPrice,
      exitReason,
      endIndex: end,
      knownAt: bars[end]!.t + barMs,
      grossReturn,
      netReturn,
      positive: netReturn > 0 ? 1 : 0,
      forwardVol,
      mae: Math.min(0, lo / entry - 1),
      mfe: Math.max(0, hi / entry - 1),
      targetBeforeStop: stop !== null && target !== null ? (exitReason === "TARGET" ? 1 : 0) : null,
    };
  });
}

/** The value of one target for a label (null when that target is undefined for the spec). */
export function labelValue(label: TradeLabel, target: LabelTarget): number | null {
  switch (target) {
    case "NET_RETURN":
      return label.netReturn;
    case "NET_POSITIVE":
      return label.positive;
    case "FORWARD_VOL":
      return label.forwardVol;
    case "MAE":
      return label.mae;
    case "MFE":
      return label.mfe;
    case "TARGET_BEFORE_STOP":
      return label.targetBeforeStop;
  }
}
