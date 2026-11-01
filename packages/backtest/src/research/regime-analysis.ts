import { mean } from "../stats.js";
import { perBarSharpe } from "./metrics.js";
import type { RegimeState } from "./regime.js";
import type { ResearchBar, SimResult } from "./simulate.js";
import type { StrategySpec } from "./strategies.js";

/**
 * ASCEND-04 strategy-by-regime research. Two tools:
 *
 * - `performanceByRegime` splits a simulated return series by the regime known at each *decision* bar.
 *   Descriptive only: it shows where returns came from, and is in-sample by construction.
 * - `regimeGatedSpec` turns "only hold this strategy in regimes R" into a new strategy hypothesis, so it goes
 *   through the full walk-forward protocol (its own trials, DSR, PBO, holdout rules) instead of being
 *   asserted from the descriptive split. The gate reads only the filtered state at the decision bar.
 */

export type RegimeKey = (state: RegimeState) => string;

export const trendKey: RegimeKey = (s) => s.trend.state;
export const volatilityKey: RegimeKey = (s) => s.volatility.level;
export const behaviourKey: RegimeKey = (s) => s.behaviour.state;

/** `activeBars`: bars with a non-zero return, which includes the exit bar of a position closed in this regime. */
export type RegimeBucket = { regime: string; bars: number; activeBars: number; meanReturn: number | null; perBarSharpe: number | null; totalReturn: number };

export function performanceByRegime(input: { sim: SimResult; bars: readonly ResearchBar[]; states: readonly RegimeState[]; key: RegimeKey }): RegimeBucket[] {
  const indexOf = new Map(input.bars.map((b, i) => [b.t, i]));
  const buckets = new Map<string, { returns: number[]; active: number }>();
  input.sim.barTimes.forEach((fillT, k) => {
    const fillIndex = indexOf.get(fillT);
    // The return on bar k was decided at the bar before its fill bar.
    const state = fillIndex !== undefined && fillIndex > 0 ? input.states[fillIndex - 1] : undefined;
    const label = state ? input.key(state) : "UNKNOWN";
    const bucket = buckets.get(label) ?? { returns: [], active: 0 };
    const r = input.sim.barReturns[k]!;
    bucket.returns.push(r);
    if (input.sim.grossBarReturns[k] !== 0 || r !== 0) bucket.active += 1;
    buckets.set(label, bucket);
  });
  return [...buckets.entries()]
    .map(([regime, b]) => ({
      regime,
      bars: b.returns.length,
      activeBars: b.active,
      meanReturn: mean(b.returns),
      perBarSharpe: perBarSharpe(b.returns),
      totalReturn: b.returns.reduce((acc, r) => acc * (1 + r), 1) - 1,
    }))
    .sort((a, b) => a.regime.localeCompare(b.regime));
}

export type RegimeGate = { name: string; description: string; allows: (state: RegimeState) => boolean };

/** Pre-declared gates, one per ASCEND-04 hypothesis. Not fitted to any result. */
export const REGIME_GATES: Record<string, RegimeGate> = {
  trendOnly: {
    name: "trend_only",
    description: "Hold only while the filtered trend is WEAK_UP or STRONG_UP",
    allows: (s) => s.trend.state === "WEAK_UP" || s.trend.state === "STRONG_UP",
  },
  rangeOnly: {
    name: "range_only",
    description: "Hold only while the filtered trend is RANGE and volatility is not ELEVATED/EXTREME",
    allows: (s) => s.trend.state === "RANGE" && (s.volatility.level === "COMPRESSED" || s.volatility.level === "NORMAL"),
  },
  notUnstable: {
    name: "not_unstable",
    description: "Stand aside when volatility is EXTREME or behaviour is UNSTABLE/TRANSITIONING",
    allows: (s) => s.volatility.level !== "EXTREME" && s.behaviour.state !== "UNSTABLE" && s.behaviour.state !== "TRANSITIONING",
  },
};

/** The ASCEND-04 hypotheses: which gate each base strategy is tested under. */
export const REGIME_HYPOTHESES: Array<{ baseId: string; gate: keyof typeof REGIME_GATES; hypothesis: string }> = [
  { baseId: "tsmom", gate: "trendOnly", hypothesis: "Time-series momentum earns its edge in persistent trends; gating out other regimes reduces cost drag" },
  { baseId: "ma_trend", gate: "trendOnly", hypothesis: "MA trend-following works only once a statistically visible trend exists" },
  { baseId: "zscore_reversion", gate: "rangeOnly", hypothesis: "Z-score reversion works in calm ranges and fails in trends" },
  { baseId: "bollinger_reversion", gate: "rangeOnly", hypothesis: "Bollinger reversion works in calm ranges and fails in trends" },
  { baseId: "tsmom", gate: "notUnstable", hypothesis: "Standing aside in extreme or transitioning markets lowers drawdown without losing net return" },
];

/**
 * A gated copy of `base`: holds only when the base wants to and the gate allows the state at the decision bar.
 * `statesByTime` must come from `classifyRegimes` on the same bars (filtered, so point-in-time).
 */
export function regimeGatedSpec(base: StrategySpec, gate: RegimeGate, statesByTime: ReadonlyMap<number, RegimeState>): StrategySpec {
  if (!base.supported || !base.build) throw new Error(`${base.id} is not a buildable strategy`);
  const build = base.build;
  return {
    ...base,
    id: `${base.id}__${gate.name}`,
    version: `${base.version}+regime-1.0.0`,
    family: "REGIME_CONDITIONED",
    hypothesis: `${base.hypothesis}; gated: ${gate.description}`,
    build: (params) => {
      const inner = build(params);
      return {
        id: `${inner.id}__${gate.name}`,
        lookback: inner.lookback,
        decide: (ctx) => {
          const want = inner.decide(ctx);
          const state = statesByTime.get(ctx.bars.at(-1)!.t);
          return want === 1 && state !== undefined && gate.allows(state) ? 1 : 0;
        },
      };
    },
  };
}
