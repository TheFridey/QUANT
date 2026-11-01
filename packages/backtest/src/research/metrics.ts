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
 * (non-excess) kurtosis γ4. Null when the variance term is not positive or the sample is too small.
 */
export function probabilisticSharpe(input: { sharpe: number; benchmark: number; n: number; skew: number; kurtosis: number }): number | null {
  const { sharpe: sr, benchmark, n, skew, kurtosis: k } = input;
  if (n < MIN_BARS) return null;
  const denom = 1 - skew * sr + ((k - 1) / 4) * sr * sr;
  if (!(denom > 0)) return null;
  return normalCdf(((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}

/** Expected maximum per-bar Sharpe across N independent trials whose Sharpe estimates have variance `v`. */
export function expectedMaxSharpe(trials: number, variance: number): number {
  if (trials < 2 || !(variance > 0)) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / trials) + EULER_GAMMA * normalQuantile(1 - 1 / (trials * Math.E)));
}

/**
 * Deflated Sharpe Ratio: PSR against the Sharpe expected from the best of `trialSharpes.length` trials.
 * `trialSharpes` are per-bar Sharpes of every configuration tried, failures included.
 */
export function deflatedSharpe(input: { sharpe: number; n: number; skew: number; kurtosis: number; trialSharpes: number[] }): { dsr: number | null; benchmark: number; trials: number } {
  const finite = input.trialSharpes.filter((x) => Number.isFinite(x));
  const v = finite.length >= 2 ? (stdev(finite) as number) ** 2 : 0;
  const benchmark = expectedMaxSharpe(finite.length, v);
  return { dsr: probabilisticSharpe({ sharpe: input.sharpe, benchmark, n: input.n, skew: input.skew, kurtosis: input.kurtosis }), benchmark, trials: finite.length };
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
