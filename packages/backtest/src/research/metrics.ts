import { kurtosis, mean, normalCdf, normalQuantile, quantile, skewness, stdev } from "../stats.js";
import type { SimResult, SimTrade } from "./simulate.js";

/**
 * ASCEND-03 performance statistics. Every ratio is null when the sample cannot support it; nothing is
 * reported from fewer than `MIN_BARS` returns or `MIN_TRADES` trades. Sharpe-family ratios are computed per
 * bar and annualised with the caller's `periodsPerYear`.
 *
 * PSR and DSR follow the published definitions (Bailey & López de Prado, "The Sharpe Ratio Efficient
 * Frontier", 2012; "The Deflated Sharpe Ratio", 2014): PSR uses the non-annualised Sharpe with skew and
 * kurtosis corrections; DSR evaluates PSR against the expected maximum Sharpe of N independent trials.
 * PBO is the combinatorially symmetric cross-validation estimate (Bailey, Borwein, López de Prado & Zhu).
 */

export const MIN_BARS = 100;
export const MIN_TRADES = 30;
const EULER_GAMMA = 0.5772156649015329;

export type PerformanceStats = {
  bars: number;
  trades: number;
  totalReturn: number;
  annualisedReturn: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdown: number;
  /** Longest stretch below a previous equity peak, in bars. */
  maxDrawdownBars: number;
  expectedShortfall95: number | null;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  meanTradeBars: number | null;
  exposure: number;
  turnover: number;
  /** Per-bar Sharpe, skew and kurtosis used by PSR/DSR. */
  perBar: { sharpe: number | null; skew: number | null; kurtosis: number | null };
  sufficient: { bars: boolean; trades: boolean };
};

export function equityCurve(returns: number[]): number[] {
  const out: number[] = [];
  let e = 1;
  for (const r of returns) {
    e *= 1 + r;
    out.push(e);
  }
  return out;
}

export function maxDrawdown(returns: number[]): { depth: number; bars: number } {
  let peak = 1;
  let e = 1;
  let depth = 0;
  let under = 0;
  let longest = 0;
  for (const r of returns) {
    e *= 1 + r;
    if (e >= peak) {
      peak = e;
      under = 0;
    } else {
      under += 1;
      longest = Math.max(longest, under);
      depth = Math.max(depth, 1 - e / peak);
    }
  }
  return { depth, bars: longest };
}

export function perBarSharpe(returns: number[]): number | null {
  const s = stdev(returns);
  const m = mean(returns);
  if (s === null || m === null || s === 0) return null;
  return m / s;
}

export function performanceStats(sim: Pick<SimResult, "barReturns" | "trades" | "exposure" | "turnover">, periodsPerYear: number): PerformanceStats {
  const r = sim.barReturns;
  const trades: SimTrade[] = sim.trades;
  const enoughBars = r.length >= MIN_BARS;
  const enoughTrades = trades.length >= MIN_TRADES;
  const total = equityCurve(r).at(-1) ?? 1;
  const dd = maxDrawdown(r);
  const sr = perBarSharpe(r);
  const downside = r.filter((x) => x < 0);
  const downDev = downside.length >= 2 ? Math.sqrt(r.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / r.length) : null;
  const annRet = enoughBars ? total ** (periodsPerYear / r.length) - 1 : null;
  const wins = trades.filter((t) => t.netReturn > 0);
  const losses = trades.filter((t) => t.netReturn <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netReturn, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netReturn, 0);
  const tail = quantile(r, 0.05);
  const tailRows = tail === null ? [] : r.filter((x) => x <= tail);
  return {
    bars: r.length,
    trades: trades.length,
    totalReturn: total - 1,
    annualisedReturn: annRet,
    sharpe: enoughBars && sr !== null ? sr * Math.sqrt(periodsPerYear) : null,
    sortino: enoughBars && downDev ? ((mean(r) as number) / downDev) * Math.sqrt(periodsPerYear) : null,
    calmar: annRet !== null && dd.depth > 0 ? annRet / dd.depth : null,
    maxDrawdown: dd.depth,
    maxDrawdownBars: dd.bars,
    expectedShortfall95: enoughBars && tailRows.length ? (mean(tailRows) as number) : null,
    winRate: enoughTrades ? wins.length / trades.length : null,
    profitFactor: enoughTrades && grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: enoughTrades ? (mean(trades.map((t) => t.netReturn)) as number) : null,
    meanTradeBars: trades.length ? (mean(trades.map((t) => t.bars)) as number) : null,
    exposure: sim.exposure,
    turnover: sim.turnover,
    perBar: { sharpe: sr, skew: skewness(r), kurtosis: kurtosis(r) },
    sufficient: { bars: enoughBars, trades: enoughTrades },
  };
}

/**
 * Probabilistic Sharpe Ratio: P(true per-bar Sharpe > benchmark) given n returns with skew γ3 and
 * (non-excess) kurtosis γ4. Null when any input or the result is not finite, the sample is too small, the
 * moments are impossible (γ4 < 1 + γ3²), or the variance term is not positive. Never NaN: a NaN compared with
 * a gate threshold (`NaN < 0.95` is false) would pass the gate.
 */
export function probabilisticSharpe(input: { sharpe: number; benchmark: number; n: number; skew: number; kurtosis: number }): number | null {
  const { sharpe: sr, benchmark, n, skew, kurtosis: k } = input;
  if (![sr, benchmark, n, skew, k].every(Number.isFinite)) return null;
  if (n < MIN_BARS) return null;
  if (k < 1 + skew * skew - 1e-9) return null;
  const denom = 1 - skew * sr + ((k - 1) / 4) * sr * sr;
  if (!(denom > 0)) return null;
  const p = normalCdf(((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom));
  return Number.isFinite(p) ? p : null;
}

/** Expected maximum per-bar Sharpe across N independent trials whose Sharpe estimates have variance `v`. */
export function expectedMaxSharpe(trials: number, variance: number): number {
  if (trials < 2 || !(variance > 0)) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / trials) + EULER_GAMMA * normalQuantile(1 - 1 / (trials * Math.E)));
}

/**
 * OPERATION INTEGRITY F04: DSR protocol identity. Results stored without `protocol` were produced by the
 * original implementation ("dsr-1"), in which zero cross-trial dispersion gave a zero benchmark whatever the
 * trial count. They keep that identity and are not recomputed (docs/integrity/F04-STATISTICAL-REVIEW.md).
 */
export const DSR_PROTOCOL_VERSION = "dsr-2.0.0" as const;
/** Trial counts above this make 1 − 1/N indistinguishable from 1 in floating point; refused, not clamped. */
export const DSR_MAX_TRIALS = 1e15;

export type DsrReason =
  | "DSR_NONFINITE_INPUT"
  | "DSR_SAMPLE_TOO_SMALL"
  | "DSR_INVALID_MOMENTS"
  | "DSR_VARIANCE_NONPOSITIVE"
  | "DSR_INVALID_TRIAL_COUNT"
  | "DSR_DISPERSION_UNESTIMABLE"
  | "DSR_NONFINITE_OUTPUT";

export type DeflatedSharpe = {
  dsr: number | null;
  /** Expected maximum Sharpe under the null; null when the DSR is not computable. */
  benchmark: number | null;
  trials: number;
  /** Variance of the trial Sharpes actually used, and where it came from. */
  variance: number | null;
  varianceSource: "CROSS_TRIAL" | "SAMPLING_FLOOR" | "NONE" | null;
  reason: DsrReason | null;
  protocol: typeof DSR_PROTOCOL_VERSION;
};

/**
 * Deflated Sharpe Ratio (protocol dsr-2.0.0): PSR against the Sharpe expected from the best of N trials.
 *
 *  - N = max(finite trial Sharpes, `trialCount`): programme-wide selection counts every trial ever run. It is
 *    used in full; no effective-trials reduction is applied (no reliable estimate of correlation exists for a
 *    handful of learners, and the full N with the floor below is an upper bound on the expected maximum of
 *    correlated trials with equal marginal variance, by Slepian's inequality).
 *  - N ≤ 1: no selection happened; DSR = PSR against 0.
 *  - N ≥ 2: the dispersion of the trial Sharpes must be estimable from at least two finite trial Sharpes, else
 *    the result is insufficient (failures silently dropped would make N and V unverifiable).
 *  - Variance V = max(cross-trial variance, sampling floor), the floor being the variance of the tested Sharpe
 *    estimator under the null, max(1, 1 − γ3·SR + (γ4 − 1)/4·SR²) / (n − 1) (Mertens 2002; Bailey & López de
 *    Prado 2012), with the tested Sharpe's own n. The cross-trial variance of ESTIMATED Sharpes already contains
 *    this noise, so the maximum (not the sum) is used: no double counting. Identical or highly correlated trials
 *    therefore no longer collapse the benchmark to zero.
 *  - Any invalid input returns dsr null with an explicit reason. Every consumer treats null as failing its gate.
 */
export function deflatedSharpe(input: { sharpe: number; n: number; skew: number; kurtosis: number; trialSharpes: number[]; trialCount?: number }): DeflatedSharpe {
  const refuse = (reason: DsrReason, trials = 0): DeflatedSharpe => ({ dsr: null, benchmark: null, trials, variance: null, varianceSource: null, reason, protocol: DSR_PROTOCOL_VERSION });
  const { sharpe: sr, n, skew, kurtosis: k } = input;
  if (![sr, n, skew, k].every(Number.isFinite)) return refuse("DSR_NONFINITE_INPUT");
  if (input.trialCount !== undefined && !(Number.isFinite(input.trialCount) && input.trialCount >= 0)) return refuse("DSR_INVALID_TRIAL_COUNT");
  const finite = input.trialSharpes.filter((x) => Number.isFinite(x));
  const trials = Math.max(1, finite.length, Math.floor(input.trialCount ?? 0));
  if (trials > DSR_MAX_TRIALS) return refuse("DSR_INVALID_TRIAL_COUNT", trials);
  if (n < MIN_BARS) return refuse("DSR_SAMPLE_TOO_SMALL", trials);
  if (k < 1 + skew * skew - 1e-9) return refuse("DSR_INVALID_MOMENTS", trials);
  const denom = 1 - skew * sr + ((k - 1) / 4) * sr * sr;
  if (!(denom > 0)) return refuse("DSR_VARIANCE_NONPOSITIVE", trials);
  let variance = 0;
  let varianceSource: DeflatedSharpe["varianceSource"] = "NONE";
  if (trials >= 2) {
    if (finite.length < 2) return refuse("DSR_DISPERSION_UNESTIMABLE", trials);
    const cross = (stdev(finite) as number) ** 2;
    const floor = Math.max(1, denom) / (n - 1);
    variance = Number.isFinite(cross) && cross > floor ? cross : floor;
    varianceSource = variance === floor ? "SAMPLING_FLOOR" : "CROSS_TRIAL";
  }
  const benchmark = expectedMaxSharpe(trials, variance);
  if (!Number.isFinite(benchmark)) return refuse("DSR_NONFINITE_OUTPUT", trials);
  const dsr = probabilisticSharpe({ sharpe: sr, benchmark, n, skew, kurtosis: k });
  if (dsr === null) return refuse("DSR_NONFINITE_OUTPUT", trials);
  return { dsr, benchmark, trials, variance, varianceSource, reason: null, protocol: DSR_PROTOCOL_VERSION };
}

/** Gate helper: true only for a finite DSR at or above the threshold. Null, NaN and undefined all fail. */
export function dsrPasses(dsr: number | null | undefined, threshold: number): boolean {
  return typeof dsr === "number" && Number.isFinite(dsr) && dsr >= threshold;
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      acc.push(i);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/**
 * Probability of Backtest Overfitting by CSCV. `matrix[trial][t]` are aligned per-bar returns of each
 * configuration. The series is cut into `blocks` (even) contiguous blocks; every half/half split is an
 * in-sample/out-of-sample pair. PBO = share of splits where the in-sample winner ranks at or below the
 * out-of-sample median. Null with fewer than two trials or too few bars per block.
 */
export function probabilityOfBacktestOverfitting(matrix: number[][], blocks = 10): { pbo: number | null; splits: number } {
  if (matrix.length < 2 || blocks % 2 !== 0) return { pbo: null, splits: 0 };
  const T = Math.min(...matrix.map((row) => row.length));
  const size = Math.floor(T / blocks);
  if (size < 10) return { pbo: null, splits: 0 };
  const blockOf = (b: number) => Array.from({ length: size }, (_, i) => b * size + i);
  const score = (row: number[], idx: number[]) => {
    const xs = idx.map((i) => row[i]!);
    return perBarSharpe(xs) ?? Number.NEGATIVE_INFINITY;
  };
  let overfit = 0;
  const splits = combinations(blocks, blocks / 2);
  for (const inBlocks of splits) {
    const outBlocks = Array.from({ length: blocks }, (_, b) => b).filter((b) => !inBlocks.includes(b));
    const inIdx = inBlocks.flatMap(blockOf);
    const outIdx = outBlocks.flatMap(blockOf);
    const inScores = matrix.map((row) => score(row, inIdx));
    const best = inScores.indexOf(Math.max(...inScores));
    const outScores = matrix.map((row) => score(row, outIdx));
    const bestOut = outScores[best]!;
    // Relative rank of the IS winner out of sample, in (0, 1).
    const rank = outScores.filter((s) => s < bestOut).length + 0.5 * (outScores.filter((s) => s === bestOut).length - 1) + 1;
    const omega = rank / (matrix.length + 1);
    if (Math.log(omega / (1 - omega)) <= 0) overfit += 1;
  }
  return { pbo: overfit / splits.length, splits: splits.length };
}
