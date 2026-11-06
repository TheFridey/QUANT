import { normalCdf, stdev } from "../stats.js";
import type { ResearchBar } from "./simulate.js";

/**
 * ASCEND-04 market-regime intelligence: a transparent, deterministic, *filtered* classifier.
 *
 * Point-in-time contract: the state at bar i is computed from bars[0..i] only (the decision bar is closed).
 * No smoothing ever revisits an earlier label, so `classifyRegimes(bars.slice(0, k))` reproduces the first k
 * states of `classifyRegimes(bars)` exactly (tested). An uncertain or under-sampled market stays UNKNOWN.
 *
 * Dimensions: trend (drift t-statistic of returns), volatility level (percentile of realised volatility in its
 * own expanding history) and direction, behaviour (variance ratio, Donchian breakout, CUSUM change points),
 * liquidity (always UNKNOWN: QUANT holds no point-in-time liquidity history; present-day reserves are not a
 * historical feature) and, when a benchmark series is supplied, the broader market.
 *
 * `confidence` values are heuristic margins to the nearest decision boundary, NOT calibrated probabilities.
 */

export const REGIME_MODEL_VERSION = "regime-det-1.1.0";

/**
 * Which bars a market is expected to print. CONTINUOUS (crypto) expects every interval; WEEKDAYS (US equities on
 * daily bars) expects Monday to Friday only, so weekends are not gaps. Exchange holidays still count as missing,
 * about 2 per 50 sessions, well inside `minCoverage`. 1.0.0 had no calendar: every daily equity bar was UNKNOWN.
 */
export type MarketCalendar = "CONTINUOUS" | "WEEKDAYS";

function expectedBars(fromT: number, toT: number, barMs: number, calendar: MarketCalendar): number {
  if (calendar === "CONTINUOUS" || barMs < 86_400_000) return Math.max(1, Math.round((toT - fromT) / barMs) + 1);
  let n = 0;
  // Daily equity bars open at New York midnight (04:00 or 05:00 UTC), so the UTC weekday is the session's weekday.
  for (let t = fromT; t <= toT + barMs / 2; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return Math.max(1, n);
}

export type TrendState = "STRONG_UP" | "WEAK_UP" | "RANGE" | "WEAK_DOWN" | "STRONG_DOWN" | "UNKNOWN";
export type VolatilityLevel = "COMPRESSED" | "NORMAL" | "ELEVATED" | "EXTREME" | "UNKNOWN";
export type VolatilityDirection = "EXPANDING" | "CONTRACTING" | "STABLE" | "UNKNOWN";
export type LiquidityState = "STABLE" | "IMPROVING" | "DETERIORATING" | "STRESSED" | "UNKNOWN";
export type MarketBehaviour = "TREND_CONTINUATION" | "MEAN_REVERTING" | "BREAKOUT" | "UNSTABLE" | "TRANSITIONING" | "INDETERMINATE";
export type BroadMarket = "RISK_ON" | "RISK_OFF" | "HIGH_CORRELATION" | "STRESS" | "UNKNOWN";

export type RegimeConfig = {
  /** Bars in the trend regression. */
  trendWindow: number;
  /** Bars in each realised-volatility estimate. */
  volWindow: number;
  /** Volatility estimates needed before a percentile is trusted. */
  volHistoryMin: number;
  /** Variance-ratio aggregation lag (bars). */
  vrLag: number;
  /** Donchian look-back for breakouts (bars). */
  breakoutWindow: number;
  /** |t| at or above which a trend is strong / weak. */
  strongT: number;
  weakT: number;
  /** Minimum share of expected bars present in the trend window; below it, trend and behaviour are UNKNOWN. */
  minCoverage: number;
  /** CUSUM threshold (in standard deviations) and allowance. */
  cusumH: number;
  cusumK: number;
};

/** Pre-declared windows by bar interval. Chosen before any regime was evaluated; not tuned on results. */
export function regimeConfigFor(barMs: number): RegimeConfig {
  const base = { strongT: 3, weakT: 1.5, minCoverage: 0.8, cusumH: 5, cusumK: 0.5 };
  if (barMs >= 86_400_000) return { ...base, trendWindow: 50, volWindow: 20, volHistoryMin: 120, vrLag: 5, breakoutWindow: 20 };
  if (barMs >= 3_600_000) return { ...base, trendWindow: 72, volWindow: 24, volHistoryMin: 240, vrLag: 6, breakoutWindow: 48 };
  return { ...base, trendWindow: 144, volWindow: 48, volHistoryMin: 480, vrLag: 12, breakoutWindow: 96 };
}

export type RegimeState = {
  t: number;
  /** When the state became knowable: the close of bar t. */
  availableAt: number;
  modelVersion: string;
  trend: { state: TrendState; tStat: number | null; confidence: number | null };
  volatility: { level: VolatilityLevel; direction: VolatilityDirection; realised: number | null; percentile: number | null };
  liquidity: { state: LiquidityState; reason: string };
  behaviour: { state: MarketBehaviour; varianceRatio: number | null; changePoint: boolean; barsSinceChange: number | null };
  broad: { state: BroadMarket; correlation: number | null };
  /** Share of expected bars present in the trend window (gaps lower it). */
  coverage: number;
  /** True when the classifier lacked history or coverage for this bar. */
  insufficient: boolean;
  explanation: string[];
};

export function inferBarMs(bars: readonly ResearchBar[]): number {
  const diffs = bars.slice(1).map((b, i) => b.t - bars[i]!.t).sort((a, b) => a - b);
  return diffs.length ? diffs[Math.floor(diffs.length / 2)]! : 3_600_000;
}

/**
 * Drift t-statistic of 1-bar log returns over the window: mean / (sd / sqrt(n)). Under a driftless random walk
 * it is ~N(0, 1). (A slope t-stat on log *levels* is a spurious regression on random walks: its |t| grows with
 * the window, so it would call most random walks STRONG trends. Found by test and replaced.)
 */
function trendStat(closes: number[]): number | null {
  const n = closes.length - 1;
  if (n < 10 || closes.some((c) => !(c > 0))) return null;
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const m = r.reduce((s, x) => s + x, 0) / n;
  const sd = stdev(r);
  if (sd === null || !(sd > 0)) return m === 0 ? 0 : Math.sign(m) * 1e6;
  return m / (sd / Math.sqrt(n));
}

function varianceRatio(logRets: number[], q: number): number | null {
  if (logRets.length < q * 4) return null;
  const v1 = stdev(logRets);
  const agg: number[] = [];
  for (let i = q; i <= logRets.length; i += 1) agg.push(logRets.slice(i - q, i).reduce((s, x) => s + x, 0));
  const vq = stdev(agg);
  if (v1 === null || vq === null || !(v1 > 0)) return null;
  return (vq * vq) / (q * v1 * v1);
}

function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const am = a.slice(-n);
  const bm = b.slice(-n);
  const ma = am.reduce((s, x) => s + x, 0) / n;
  const mb = bm.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (am[i]! - ma) * (bm[i]! - mb);
    va += (am[i]! - ma) ** 2;
    vb += (bm[i]! - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

function trendLabel(t: number | null, cfg: RegimeConfig): TrendState {
  if (t === null) return "UNKNOWN";
  if (t >= cfg.strongT) return "STRONG_UP";
  if (t >= cfg.weakT) return "WEAK_UP";
  if (t <= -cfg.strongT) return "STRONG_DOWN";
  if (t <= -cfg.weakT) return "WEAK_DOWN";
  return "RANGE";
}

const sign = (s: TrendState) => (s === "STRONG_UP" || s === "WEAK_UP" ? 1 : s === "STRONG_DOWN" || s === "WEAK_DOWN" ? -1 : s === "RANGE" ? 0 : null);

/**
 * Filtered regime history for every bar. `benchmark`, when given, must be bars of a broader-market series; a
 * benchmark bar is used only once its close (t + its interval) is at or before the decision bar's close.
 * `expectedBars`, when given, replaces the calendar's expected-bar count for coverage (e.g. a session calendar that
 * skips the FX weekend, so a Monday trend window is not counted as 40% missing). It reads bar times only.
 */
export function classifyRegimes(bars: readonly ResearchBar[], options: { config?: RegimeConfig; barMs?: number; benchmark?: readonly ResearchBar[]; calendar?: MarketCalendar; benchmarkCalendar?: MarketCalendar; expectedBars?: (fromT: number, toT: number, barMs: number) => number } = {}): RegimeState[] {
  const barMs = options.barMs ?? inferBarMs(bars);
  const cfg = options.config ?? regimeConfigFor(barMs);
  const out: RegimeState[] = [];
  const rv: Array<number | null> = [];
  const sortedRv: number[] = [];
  const logRet: number[] = [0];
  for (let i = 1; i < bars.length; i += 1) logRet.push(bars[i]!.close > 0 && bars[i - 1]!.close > 0 ? Math.log(bars[i]!.close / bars[i - 1]!.close) : 0);

  const bench = options.benchmark ?? null;
  const benchMs = bench ? inferBarMs(bench) : 0;
  const benchStates = bench ? classifyRegimes(bench, { barMs: benchMs, calendar: options.benchmarkCalendar }) : null;
  const calendar = options.calendar ?? "CONTINUOUS";
  let bj = -1;

  // Two-sided CUSUM on returns standardised by the trailing (pre-bar) volatility.
  let cusumPos = 0;
  let cusumNeg = 0;
  let lastChange: number | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const explanation: string[] = [];
    const from = Math.max(0, i + 1 - cfg.trendWindow);
    const expected = options.expectedBars ? options.expectedBars(bars[from]!.t, bar.t, barMs) : expectedBars(bars[from]!.t, bar.t, barMs, calendar);
    const coverage = Math.min(1, (i - from + 1) / expected);
    const enough = i + 1 >= cfg.trendWindow && coverage >= cfg.minCoverage;

    // Volatility: realised over volWindow, percentile within its own history up to and including i.
    let realised: number | null = null;
    if (i >= cfg.volWindow) realised = stdev(logRet.slice(i + 1 - cfg.volWindow, i + 1));
    rv.push(realised);
    let percentile: number | null = null;
    if (realised !== null) {
      let lo = 0;
      let hi = sortedRv.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedRv[mid]! < realised) lo = mid + 1;
        else hi = mid;
      }
      sortedRv.splice(lo, 0, realised);
      if (sortedRv.length >= cfg.volHistoryMin) percentile = lo / (sortedRv.length - 1 || 1);
    }
    const level: VolatilityLevel = percentile === null ? "UNKNOWN" : percentile < 0.2 ? "COMPRESSED" : percentile < 0.8 ? "NORMAL" : percentile < 0.95 ? "ELEVATED" : "EXTREME";
    const prior = i >= Math.floor(cfg.volWindow / 2) ? rv[i - Math.floor(cfg.volWindow / 2)] ?? null : null;
    const direction: VolatilityDirection = realised === null || prior === null || !(prior > 0) ? "UNKNOWN" : realised / prior > 1.25 ? "EXPANDING" : realised / prior < 0.8 ? "CONTRACTING" : "STABLE";

    // Change points: CUSUM of z = r_i / sigma_{i-1}, sigma from the window ending the bar before.
    let changePoint = false;
    const sigmaPrev = i >= 1 ? rv[i - 1] ?? null : null;
    if (sigmaPrev !== null && sigmaPrev > 0) {
      const z = logRet[i]! / sigmaPrev;
      cusumPos = Math.max(0, cusumPos + z - cfg.cusumK);
      cusumNeg = Math.max(0, cusumNeg - z - cfg.cusumK);
      if (cusumPos > cfg.cusumH || cusumNeg > cfg.cusumH) {
        changePoint = true;
        lastChange = i;
        cusumPos = 0;
        cusumNeg = 0;
      }
    }

    // Trend.
    const tStat = enough ? trendStat(bars.slice(from, i + 1).map((b) => b.close)) : null;
    const trend = trendLabel(tStat, cfg);
    let confidence: number | null = null;
    if (tStat !== null) {
      const boundaries = [cfg.strongT, cfg.weakT, -cfg.weakT, -cfg.strongT];
      const margin = Math.min(...boundaries.map((b) => Math.abs(tStat - b)));
      confidence = normalCdf(margin);
    }
    if (!enough) explanation.push(i + 1 < cfg.trendWindow ? `history ${i + 1} < ${cfg.trendWindow} bars` : `coverage ${(coverage * 100).toFixed(0)}% < ${cfg.minCoverage * 100}% (gaps)`);
    else explanation.push(`drift t=${tStat?.toFixed(2)} over ${cfg.trendWindow} bars`);
    if (percentile !== null) explanation.push(`realised vol at the ${(percentile * 100).toFixed(0)}th percentile of ${sortedRv.length} estimates`);

    // Behaviour.
    const vr = enough ? varianceRatio(logRet.slice(from + 1, i + 1), cfg.vrLag) : null;
    let behaviour: MarketBehaviour = "INDETERMINATE";
    const barsSinceChange = lastChange === null ? null : i - lastChange;
    if (enough) {
      const window = bars.slice(Math.max(0, i - cfg.breakoutWindow), i);
      const priorHigh = window.length === cfg.breakoutWindow ? Math.max(...window.map((b) => b.high)) : null;
      const priorLow = window.length === cfg.breakoutWindow ? Math.min(...window.map((b) => b.low)) : null;
      const earlier = out[i - Math.floor(cfg.volWindow / 2)];
      const flipped = earlier !== undefined && sign(earlier.trend.state) !== null && sign(trend) !== null && sign(earlier.trend.state) !== sign(trend) && sign(earlier.trend.state) !== 0 && sign(trend) !== 0;
      if (level === "EXTREME") behaviour = "UNSTABLE";
      else if (priorHigh !== null && priorLow !== null && (bar.close > priorHigh || bar.close < priorLow) && direction === "EXPANDING") behaviour = "BREAKOUT";
      else if (flipped || (barsSinceChange !== null && barsSinceChange < Math.floor(cfg.volWindow / 2))) behaviour = "TRANSITIONING";
      else if (vr !== null && vr > 1.15) behaviour = "TREND_CONTINUATION";
      else if (vr !== null && vr < 0.85) behaviour = "MEAN_REVERTING";
    }
    if (vr !== null) explanation.push(`variance ratio(${cfg.vrLag}) ${vr.toFixed(2)}`);
    if (changePoint) explanation.push("CUSUM change point at this bar");

    // Broader market, strictly from benchmark bars already closed.
    let broad: BroadMarket = "UNKNOWN";
    let corr: number | null = null;
    if (bench && benchStates) {
      const decisionClose = bar.t + barMs;
      while (bj + 1 < bench.length && bench[bj + 1]!.t + benchMs <= decisionClose) bj += 1;
      const bs = bj >= 0 ? benchStates[bj]! : null;
      if (bs && !bs.insufficient) {
        broad = bs.volatility.level === "EXTREME" ? "STRESS" : sign(bs.trend.state) === 1 ? "RISK_ON" : sign(bs.trend.state) === -1 ? "RISK_OFF" : "UNKNOWN";
        if (benchMs === barMs && bj >= cfg.trendWindow && i >= cfg.trendWindow) {
          const br = bench.slice(bj + 1 - cfg.trendWindow, bj + 1).map((b, k, arr) => (k === 0 ? 0 : Math.log(b.close / arr[k - 1]!.close))).slice(1);
          corr = correlation(logRet.slice(i + 2 - cfg.trendWindow, i + 1), br);
          if (corr !== null && corr > 0.8 && broad !== "STRESS") broad = "HIGH_CORRELATION";
        }
      }
    }

    out.push({
      t: bar.t,
      availableAt: bar.t + barMs,
      modelVersion: REGIME_MODEL_VERSION,
      trend: { state: trend, tStat, confidence },
      volatility: { level, direction, realised, percentile },
      liquidity: { state: "UNKNOWN", reason: "no point-in-time liquidity history is held" },
      behaviour: { state: behaviour, varianceRatio: vr, changePoint, barsSinceChange },
      broad: { state: broad, correlation: corr },
      coverage,
      insufficient: !enough || percentile === null,
      explanation,
    });
  }
  return out;
}

export type RegimeTransitionMatrix = { states: TrendState[]; counts: number[][]; total: number };

/** Empirical trend-state transition counts between consecutive bars (filtered labels only). */
export function trendTransitions(states: readonly RegimeState[]): RegimeTransitionMatrix {
  const labels: TrendState[] = ["STRONG_UP", "WEAK_UP", "RANGE", "WEAK_DOWN", "STRONG_DOWN", "UNKNOWN"];
  const counts = labels.map(() => labels.map(() => 0));
  for (let i = 1; i < states.length; i += 1) counts[labels.indexOf(states[i - 1]!.trend.state)]![labels.indexOf(states[i]!.trend.state)]! += 1;
  return { states: labels, counts, total: Math.max(0, states.length - 1) };
}
