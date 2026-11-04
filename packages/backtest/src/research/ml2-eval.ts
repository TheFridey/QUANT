import { quantile, seededRng } from "../stats.js";

/**
 * GENESIS Phase 4 cross-validation and dependence-aware uncertainty.
 *
 * Splits: walk-forward (expanding or rolling) over rows sorted by decision bar. Training is past-only. A
 * training row is purged when its label window [index, endIndex] reaches the test window, and embargoed when
 * its decision bar lies within `embargoBars` after the end (last label bar) of ANY earlier test window, so a
 * row whose look-back straddles a test window never trains a later fold. The pipeline sets the embargo to
 * max(horizon, lookback).
 *
 * Bootstrap: moving-block or stationary (Politis–Romano) resampling of time-ordered observations. Labels that
 * overlap are serially dependent, so an iid bootstrap would understate uncertainty; the block length must be
 * at least the label horizon (`minBlockLength`), and shorter blocks are refused.
 */

export type SplitRow = { index: number; endIndex: number };
export type WalkForwardScheme = "EXPANDING" | "ROLLING";
export type PurgedWalkForwardConfig = { scheme: WalkForwardScheme; folds: number; embargoBars: number; rollingTrainRows?: number | null };
export type PurgedFold = {
  fold: number;
  /** Positions into the row array. */
  train: number[];
  test: number[];
  purged: number;
  embargoed: number;
  /** Decision bar of the first test row. */
  testStartIndex: number;
  /** Last bar read by any test label. */
  testEndIndex: number;
};

function assertSorted(rows: readonly SplitRow[]) {
  for (let i = 1; i < rows.length; i += 1) if (!(rows[i]!.index > rows[i - 1]!.index)) throw new Error("split rows must be strictly increasing by decision index");
}

/** Walk-forward folds with purging and embargo. Segment 0 only trains; segments 1..folds are test windows. */
export function purgedWalkForwardSplits(rows: readonly SplitRow[], cfg: PurgedWalkForwardConfig): PurgedFold[] {
  assertSorted(rows);
  if (!Number.isInteger(cfg.folds) || cfg.folds < 1) throw new Error("folds must be a positive integer");
  if (!(cfg.embargoBars >= 0)) throw new Error("embargoBars must be non-negative");
  const n = rows.length;
  const segment = Math.floor(n / (cfg.folds + 1));
  if (segment < 1) return [];
  const out: PurgedFold[] = [];
  const priorWindows: Array<{ end: number }> = [];
  for (let k = 1; k <= cfg.folds; k += 1) {
    const start = segment * k;
    const stop = k === cfg.folds ? n : segment * (k + 1);
    const test = Array.from({ length: stop - start }, (_, i) => start + i);
    const testStartIndex = rows[start]!.index;
    const testEndIndex = Math.max(...test.map((p) => rows[p]!.endIndex));
    let candidates = Array.from({ length: start }, (_, i) => i);
    if (cfg.scheme === "ROLLING" && cfg.rollingTrainRows) candidates = candidates.slice(Math.max(0, candidates.length - cfg.rollingTrainRows));
    let purged = 0;
    let embargoed = 0;
    const train: number[] = [];
    for (const p of candidates) {
      const r = rows[p]!;
      if (r.endIndex >= testStartIndex) {
        purged += 1;
        continue;
      }
      if (priorWindows.some((w) => r.index > w.end && r.index <= w.end + cfg.embargoBars)) {
        embargoed += 1;
        continue;
      }
      train.push(p);
    }
    out.push({ fold: k, train, test, purged, embargoed, testStartIndex, testEndIndex });
    priorWindows.push({ end: testEndIndex });
  }
  return out;
}

/** Splits training positions (time order) into an inner fit part and a later calibration part, purged between them. */
export function innerCalibrationSplit(rows: readonly SplitRow[], train: readonly number[], calFraction: number): { fit: number[]; cal: number[]; purged: number } {
  const calCount = Math.floor(train.length * calFraction);
  const cal = train.slice(train.length - calCount);
  const firstCal = cal.length ? rows[cal[0]!]!.index : Number.POSITIVE_INFINITY;
  const head = train.slice(0, train.length - calCount);
  const fit = head.filter((p) => rows[p]!.endIndex < firstCal);
  return { fit, cal, purged: head.length - fit.length };
}

export type BlockBootstrapScheme = "MOVING" | "STATIONARY";
export type BlockBootstrapOptions = { blockLength: number; resamples?: number; seed?: number; scheme?: BlockBootstrapScheme; confidence?: number; minBlockLength?: number };

/** One block-bootstrap resample of positions 0..n-1. */
export function blockBootstrapSample(n: number, blockLength: number, scheme: BlockBootstrapScheme, rng: () => number): number[] {
  const L = Math.max(1, Math.min(n, Math.floor(blockLength)));
  const out: number[] = [];
  if (scheme === "MOVING") {
    while (out.length < n) {
      const s = Math.floor(rng() * (n - L + 1));
      for (let k = 0; k < L && out.length < n; k += 1) out.push(s + k);
    }
    return out;
  }
  // Stationary bootstrap: geometric block lengths with mean L, circular wrap.
  let pos = Math.floor(rng() * n);
  while (out.length < n) {
    out.push(pos);
    pos = rng() < 1 / L ? Math.floor(rng() * n) : (pos + 1) % n;
  }
  return out;
}

export type BootstrapInterval = { lower: number; upper: number; estimate: number; resamples: number; valid: number; blockLength: number; scheme: BlockBootstrapScheme };

/**
 * Percentile interval of `statistic` (a function of resampled positions; null skips the resample). Refuses a
 * block shorter than `minBlockLength` (set it to the label horizon).
 */
export function blockBootstrapInterval(n: number, statistic: (positions: number[]) => number | null, options: BlockBootstrapOptions): BootstrapInterval | null {
  const minBlock = options.minBlockLength ?? 1;
  if (options.blockLength < minBlock) throw new Error(`block length ${options.blockLength} < required minimum ${minBlock} (label horizon): an iid-like bootstrap on overlapping labels is refused`);
  if (n < 2 || options.blockLength > n) return null;
  const scheme = options.scheme ?? "STATIONARY";
  const resamples = options.resamples ?? 1000;
  const confidence = options.confidence ?? 0.95;
  const rng = seededRng(options.seed ?? 1);
  const estimate = statistic(Array.from({ length: n }, (_, i) => i));
  if (estimate === null || !Number.isFinite(estimate)) return null;
  const stats: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const v = statistic(blockBootstrapSample(n, options.blockLength, scheme, rng));
    if (v !== null && Number.isFinite(v)) stats.push(v);
  }
  if (stats.length < resamples / 2) return null;
  return { lower: quantile(stats, (1 - confidence) / 2)!, upper: quantile(stats, 1 - (1 - confidence) / 2)!, estimate, resamples, valid: stats.length, blockLength: options.blockLength, scheme };
}

/** Mann–Whitney AUC with mid-ranks; null without both classes. */
export function aucScore(p: readonly number[], y: readonly number[]): number | null {
  const n = p.length;
  let pos = 0;
  for (const v of y) pos += v === 1 ? 1 : 0;
  const neg = n - pos;
  if (!pos || !neg) return null;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a]! - p[b]!);
  let rankSum = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && p[order[j + 1]!] === p[order[i]!]) j += 1;
    const mid = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (y[order[k]!] === 1) rankSum += mid;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Per-trade Sharpe (mean / sd), not annualised. Null below 2 trades or zero dispersion. */
export function tradeSharpe(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return v > 0 ? m / Math.sqrt(v) : null;
}

/** Per-trade Sortino (mean / downside deviation about 0). */
export function tradeSortino(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const dd = Math.sqrt(xs.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / xs.length);
  return dd > 0 ? m / dd : null;
}

/** Share of positives among the top `fraction` of scores (ties broken by position, deterministic). */
export function topFractionPrecision(p: readonly number[], y: readonly number[], fraction: number): number | null {
  const k = Math.floor(p.length * fraction);
  if (k < 1) return null;
  const order = Array.from({ length: p.length }, (_, i) => i).sort((a, b) => p[b]! - p[a]! || a - b);
  return order.slice(0, k).reduce((s, i) => s + y[i]!, 0) / k;
}
