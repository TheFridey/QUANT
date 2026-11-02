/**
 * ASCEND-07 portfolio intelligence (research only).
 *
 * Nothing here is imported by order admission, sizing or the risk engine. An allocation computed here is
 * a research output and never overrides the deterministic trading-risk engine or its limits.
 *
 * Conventions shared with the rest of `research/`:
 * - Returns are simple per-bar returns as plain numbers (statistics, not ledger arithmetic).
 * - Series are aligned on common timestamps only. A timestamp missing from any series is dropped and
 *   counted; nothing is forward-filled or interpolated.
 * - Every estimate is null when the sample cannot support it (`MIN_OBSERVATIONS`).
 * - Point in time: any weight applied to bar i is computed from returns strictly before bar i.
 *
 * Methods:
 * - Correlation shrinkage: the scaled-identity estimator, with the data-driven intensity of Ledoit & Wolf,
 *   applied to standardised returns so each asset keeps its sample variance (`ledoitWolfCovariance`);
 *   the raw estimator is `ledoitWolfIdentity`. Source:
 *   "A well-conditioned estimator for large-dimensional covariance matrices" (J. Multivariate Analysis,
 *   2004). Implemented from the published estimator; the paper is queued in the research registry and
 *   has not been re-read in this programme, so it is cited for the formula only.
 * - Equal risk contribution by cyclical coordinate descent on y'Σy/2 − Σ b·ln y (Griveau-Billion,
 *   Richard & Roncalli, 2013). Same caveat: cited for the algorithm, verified here by tests
 *   (equal contributions; inverse volatility on a diagonal covariance).
 */

export const PORTFOLIO_MODEL_VERSION = "portfolio-1.1.0";
/** Minimum aligned observations for a covariance or correlation estimate. */
export const MIN_OBSERVATIONS = 30;

export type ReturnPoint = { t: number; r: number };
export type ReturnSeries = { id: string; market?: string; points: readonly ReturnPoint[] };

export type AlignedReturns = {
  ids: string[];
  markets: Array<string | null>;
  t: number[];
  /** returns[k][i] is asset i's return at t[k]. */
  returns: number[][];
  /** Timestamps present in at least one series but not all, so dropped. */
  droppedTimestamps: number;
  /** Non-finite returns found (each drops its timestamp). */
  invalidReturns: number;
};

/**
 * Close-to-close returns stamped at each bar's open time. A return is produced only when the previous bar
 * is the immediately preceding expected bar: one interval earlier on a CONTINUOUS calendar, or the previous
 * weekday for daily bars on a WEEKDAYS calendar. A gap yields no return; the move across it is never
 * attributed to one bar. Bars must be strictly increasing in time.
 */
export function closeToCloseReturns(
  bars: ReadonlyArray<{ t: number; close: number }>,
  barMs: number,
  calendar: "CONTINUOUS" | "WEEKDAYS" = "CONTINUOUS",
): { points: ReturnPoint[]; gaps: number } {
  const points: ReturnPoint[] = [];
  let gaps = 0;
  for (let k = 1; k < bars.length; k++) {
    const prev = bars[k - 1]!;
    const bar = bars[k]!;
    if (!(bar.t > prev.t)) throw new Error("closeToCloseReturns: bars must be strictly increasing in time");
    let expectedPrev = bar.t - barMs;
    if (calendar === "WEEKDAYS" && barMs >= 86_400_000 && new Date(bar.t).getUTCDay() === 1) expectedPrev = bar.t - 3 * 86_400_000;
    // Tolerate a one-hour DST shift in equity daily stamps (New York midnight is 04:00 or 05:00 UTC).
    const tolerance = calendar === "WEEKDAYS" && barMs >= 86_400_000 ? 3_600_000 : 0;
    if (Math.abs(prev.t - expectedPrev) > tolerance || !(prev.close > 0) || !(bar.close > 0)) {
      gaps += 1;
      continue;
    }
    points.push({ t: bar.t, r: bar.close / prev.close - 1 });
  }
  return { points, gaps };
}

/** Intersect series on timestamp. Duplicated timestamps within one series are refused, not merged. */
export function alignReturns(series: readonly ReturnSeries[]): AlignedReturns {
  if (series.length === 0) throw new Error("alignReturns: no series");
  const ids = series.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("alignReturns: duplicate series id");
  const maps = series.map((s) => {
    const m = new Map<number, number>();
    for (const p of s.points) {
      if (m.has(p.t)) throw new Error(`alignReturns: duplicate timestamp ${p.t} in ${s.id}`);
      m.set(p.t, p.r);
    }
    return m;
  });
  const all = new Set<number>();
  for (const m of maps) for (const t of m.keys()) all.add(t);
  const t: number[] = [];
  const returns: number[][] = [];
  let dropped = 0;
  let invalid = 0;
  for (const ts of [...all].sort((a, b) => a - b)) {
    const row: number[] = [];
    let ok = true;
    for (const m of maps) {
      const r = m.get(ts);
      if (r === undefined) {
        ok = false;
        break;
      }
      if (!Number.isFinite(r) || r <= -1) {
        invalid += 1;
        ok = false;
        break;
      }
      row.push(r);
    }
    if (ok) {
      t.push(ts);
      returns.push(row);
    } else {
      dropped += 1;
    }
  }
  return { ids, markets: series.map((s) => s.market ?? null), t, returns, droppedTimestamps: dropped, invalidReturns: invalid };
}

/** Sample covariance with divisor T−1 (or T when `population`). Null below `MIN_OBSERVATIONS`. */
export function covarianceMatrix(returns: readonly number[][], options: { population?: boolean; minObservations?: number } = {}): number[][] | null {
  const T = returns.length;
  if (T < (options.minObservations ?? MIN_OBSERVATIONS) || T < 2) return null;
  const N = returns[0]!.length;
  const means = Array.from({ length: N }, (_, i) => returns.reduce((s, row) => s + row[i]!, 0) / T);
  const div = options.population ? T : T - 1;
  const S = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (const row of returns) {
    for (let i = 0; i < N; i++) {
      const di = row[i]! - means[i]!;
      for (let j = i; j < N; j++) S[i]![j]! += di * (row[j]! - means[j]!);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      S[i]![j] = S[i]![j]! / div;
      S[j]![i] = S[i]![j]!;
    }
  }
  return S;
}

/** Correlation from a covariance. A zero-variance asset has undefined correlation (null entries). */
export function correlationFromCovariance(S: readonly number[][]): Array<Array<number | null>> {
  const sd = S.map((row, i) => Math.sqrt(Math.max(0, row[i]!)));
  return S.map((row, i) =>
    row.map((v, j) => {
      if (sd[i] === 0 || sd[j] === 0) return null;
      if (i === j) return 1;
      return Math.max(-1, Math.min(1, v / (sd[i]! * sd[j]!)));
    }),
  );
}

export function correlationMatrix(returns: readonly number[][], minObservations = MIN_OBSERVATIONS): Array<Array<number | null>> | null {
  const S = covarianceMatrix(returns, { minObservations });
  return S ? correlationFromCovariance(S) : null;
}

/** A sample variance at or below this is treated as zero (a frozen or constant series). */
export const ZERO_VARIANCE = 1e-20;

/**
 * The Ledoit–Wolf (2004) estimator itself: shrinkage toward m·I, m = tr(S)/N, on the population (1/T)
 * covariance. Returns the shrunk matrix and the intensity δ ∈ [0, 1] (1 = all target). Applied to raw
 * returns of assets with very different volatilities it distorts each asset's variance toward the average,
 * so research code uses `ledoitWolfCovariance` (correlation shrinkage) instead; this is exported for
 * reference tests.
 */
export function ledoitWolfIdentity(returns: readonly number[][], minObservations = MIN_OBSERVATIONS): { covariance: number[][]; shrinkage: number } | null {
  const S = covarianceMatrix(returns, { population: true, minObservations });
  if (!S) return null;
  const T = returns.length;
  const N = S.length;
  const means = Array.from({ length: N }, (_, i) => returns.reduce((s, row) => s + row[i]!, 0) / T);
  const m = S.reduce((s, row, i) => s + row[i]!, 0) / N;
  // Normalised Frobenius norm ‖A‖² = tr(AAᵀ)/N.
  let d2 = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d2 += (S[i]![j]! - (i === j ? m : 0)) ** 2;
  d2 /= N;
  let bBar2 = 0;
  for (const row of returns) {
    const x = row.map((v, i) => v - means[i]!);
    let norm = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) norm += (x[i]! * x[j]! - S[i]![j]!) ** 2;
    bBar2 += norm / N;
  }
  bBar2 /= T * T;
  if (d2 <= 0) return { covariance: S.map((row) => [...row]), shrinkage: 0 };
  const b2 = Math.min(bBar2, d2);
  const shrinkage = b2 / d2;
  const covariance = S.map((row, i) => row.map((v, j) => shrinkage * (i === j ? m : 0) + (1 - shrinkage) * v));
  return { covariance, shrinkage };
}

/**
 * Covariance with Ledoit–Wolf shrinkage applied to the correlation structure only: returns are
 * standardised by their sample (population) volatility, the 2004 estimator shrinks their correlation
 * matrix toward the identity, and the result is rescaled. Each asset keeps its own sample variance exactly,
 * so a low-volatility asset is not made to look riskier than it is (reviewer A, APEX).
 *
 * Returns null when any asset has (near-)zero sample variance: a frozen or constant feed must be refused,
 * not given the largest inverse-volatility weight.
 */
export function ledoitWolfCovariance(returns: readonly number[][], minObservations = MIN_OBSERVATIONS): { covariance: number[][]; shrinkage: number } | null {
  const S = covarianceMatrix(returns, { population: true, minObservations });
  if (!S) return null;
  if (S.some((row, i) => !(row[i]! > ZERO_VARIANCE))) return null;
  const sd = S.map((row, i) => Math.sqrt(row[i]!));
  const standardised = returns.map((row) => row.map((v, i) => v / sd[i]!));
  const shrunk = ledoitWolfIdentity(standardised, minObservations);
  if (!shrunk) return null;
  const covariance = shrunk.covariance.map((row, i) => row.map((v, j) => (i === j ? S[i]![i]! : v * sd[i]! * sd[j]!)));
  return { covariance, shrinkage: shrunk.shrinkage };
}

/**
 * Point-in-time rolling correlation: the value at k uses observations k−window+1 … k only.
 * Null until a full window exists, or when either side has zero variance in the window.
 */
export function rollingCorrelation(a: readonly number[], b: readonly number[], window: number): Array<number | null> {
  if (a.length !== b.length) throw new Error("rollingCorrelation: length mismatch");
  if (!Number.isInteger(window) || window < 3) throw new Error("rollingCorrelation: window must be an integer ≥ 3");
  const out: Array<number | null> = [];
  for (let k = 0; k < a.length; k++) {
    if (k + 1 < window) {
      out.push(null);
      continue;
    }
    const xs = a.slice(k - window + 1, k + 1);
    const ys = b.slice(k - window + 1, k + 1);
    const mx = xs.reduce((s, v) => s + v, 0) / window;
    const my = ys.reduce((s, v) => s + v, 0) / window;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < window; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
      syy += (ys[i]! - my) ** 2;
    }
    out.push(sxx === 0 || syy === 0 ? null : Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy))));
  }
  return out;
}

function matVec(S: readonly number[][], w: readonly number[]): number[] {
  return S.map((row) => row.reduce((s, v, j) => s + v * w[j]!, 0));
}

export function portfolioVariance(w: readonly number[], S: readonly number[][]): number {
  const Sw = matVec(S, w);
  return w.reduce((s, wi, i) => s + wi * Sw[i]!, 0);
}

/**
 * Euler risk decomposition: RC_i = w_i (Σw)_i / σ_p; the contributions sum to σ_p. Shares sum to 1.
 * Null when the portfolio has zero variance.
 */
export function riskContributions(w: readonly number[], S: readonly number[][]): { volatility: number; contributions: number[]; shares: number[] } | null {
  const variance = portfolioVariance(w, S);
  if (!(variance > 0)) return null;
  const sigma = Math.sqrt(variance);
  const Sw = matVec(S, w);
  const contributions = w.map((wi, i) => (wi * Sw[i]!) / sigma);
  return { volatility: sigma, contributions, shares: contributions.map((c) => c / sigma) };
}

/** Herfindahl index of absolute weights normalised to gross exposure, and its effective count 1/HHI. */
export function concentration(weights: readonly number[]): { hhi: number; effectiveN: number; maxShare: number } | null {
  const gross = weights.reduce((s, w) => s + Math.abs(w), 0);
  if (!(gross > 0)) return null;
  const shares = weights.map((w) => Math.abs(w) / gross);
  const hhi = shares.reduce((s, x) => s + x * x, 0);
  return { hhi, effectiveN: 1 / hhi, maxShare: Math.max(...shares) };
}

/** Gross exposure grouped by a label (market, asset class, venue). Unlabelled assets group as UNKNOWN. */
export function exposureBy(weights: readonly number[], labels: ReadonlyArray<string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  weights.forEach((w, i) => {
    const key = labels[i] ?? "UNKNOWN";
    out[key] = (out[key] ?? 0) + Math.abs(w);
  });
  return out;
}

/**
 * Overlap of two strategies' exposure: Jaccard index of the bars on which both hold the same instrument.
 * Null when neither is ever exposed.
 */
export function exposureOverlap(a: readonly boolean[], b: readonly boolean[]): number | null {
  if (a.length !== b.length) throw new Error("exposureOverlap: length mismatch");
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both += 1;
    if (a[i] || b[i]) either += 1;
  }
  return either === 0 ? null : both / either;
}

// ---------- Allocation baselines (long-only, fully invested unless volatility targeting scales down) ----------

export type AllocationRule = "EQUAL_WEIGHT" | "INVERSE_VOLATILITY" | "EQUAL_RISK_CONTRIBUTION";

export function equalWeight(n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("equalWeight: n must be ≥ 1");
  return new Array<number>(n).fill(1 / n);
}

/** Null when any asset has zero variance (inverse volatility is undefined). */
export function inverseVolatility(S: readonly number[][]): number[] | null {
  const inv = S.map((row, i) => (row[i]! > 0 ? 1 / Math.sqrt(row[i]!) : Number.NaN));
  if (inv.some((v) => !Number.isFinite(v))) return null;
  const total = inv.reduce((s, v) => s + v, 0);
  return inv.map((v) => v / total);
}

/**
 * Long-only equal risk contribution. Returns null when the covariance has a non-positive diagonal or the
 * iteration does not converge (the caller must not substitute another rule silently).
 */
export function equalRiskContribution(S: readonly number[][], options: { tolerance?: number; maxIterations?: number } = {}): { weights: number[]; iterations: number } | null {
  const N = S.length;
  if (S.some((row, i) => !(row[i]! > 0))) return null;
  const b = 1 / N;
  const tolerance = options.tolerance ?? 1e-12;
  const maxIterations = options.maxIterations ?? 10_000;
  const start = inverseVolatility(S);
  if (!start) return null;
  const y = [...start];
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let change = 0;
    for (let i = 0; i < N; i++) {
      let off = 0;
      for (let j = 0; j < N; j++) if (j !== i) off += S[i]![j]! * y[j]!;
      const sii = S[i]![i]!;
      const next = (-off + Math.sqrt(off * off + 4 * sii * b)) / (2 * sii);
      change = Math.max(change, Math.abs(next - y[i]!));
      y[i] = next;
    }
    if (change < tolerance) {
      const total = y.reduce((s, v) => s + v, 0);
      if (!(total > 0) || y.some((v) => !(v > 0))) return null;
      return { weights: y.map((v) => v / total), iterations: iteration };
    }
  }
  return null;
}

/**
 * Cap each weight at `maxWeight`, redistributing the excess pro rata to uncapped weights. Leaves the
 * remainder in cash when every asset is capped (never levers up to stay fully invested).
 */
export function capWeights(weights: readonly number[], maxWeight: number): number[] {
  if (!(maxWeight > 0 && maxWeight <= 1)) throw new Error("capWeights: maxWeight must be in (0, 1]");
  const w = [...weights];
  for (let pass = 0; pass < w.length; pass++) {
    const excess = w.reduce((s, v) => s + Math.max(0, v - maxWeight), 0);
    if (excess <= 1e-15) break;
    const free = w.map((v, i) => (v < maxWeight ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < w.length; i++) w[i] = Math.min(w[i]!, maxWeight);
    const freeTotal = free.reduce((s, i) => s + w[i]!, 0);
    if (free.length === 0 || freeTotal <= 0) break;
    for (const i of free) w[i] = w[i]! + (excess * w[i]!) / freeTotal;
  }
  return w.map((v) => Math.min(v, maxWeight));
}

/**
 * Scale a portfolio down so its estimated annualised volatility does not exceed `targetVol`.
 * The scale is capped at 1: volatility targeting here never adds leverage. The remainder is cash.
 */
export function volatilityTarget(weights: readonly number[], S: readonly number[][], targetVol: number, periodsPerYear: number): { weights: number[]; scale: number; estimatedVol: number } | null {
  const variance = portfolioVariance(weights, S);
  if (!(variance > 0) || !(targetVol > 0) || !(periodsPerYear > 0)) return null;
  const estimatedVol = Math.sqrt(variance * periodsPerYear);
  const scale = Math.min(1, targetVol / estimatedVol);
  return { weights: weights.map((w) => w * scale), scale, estimatedVol };
}

export function allocate(rule: AllocationRule, S: readonly number[][]): number[] | null {
  switch (rule) {
    case "EQUAL_WEIGHT":
      return equalWeight(S.length);
    case "INVERSE_VOLATILITY":
      return inverseVolatility(S);
    case "EQUAL_RISK_CONTRIBUTION":
      return equalRiskContribution(S)?.weights ?? null;
  }
}

// ---------- Tail risk and stress ----------

/** Historical VaR and expected shortfall (positive numbers are losses). Null below `MIN_OBSERVATIONS`. */
export function historicalTail(returns: readonly number[], level = 0.95): { var: number; expectedShortfall: number; observations: number } | null {
  if (!(level > 0 && level < 1)) throw new Error("historicalTail: level must be in (0, 1)");
  if (returns.some((r) => !Number.isFinite(r))) throw new Error("historicalTail: non-finite return");
  if (returns.length < MIN_OBSERVATIONS) return null;
  const sorted = [...returns].sort((x, y) => x - y);
  // The epsilon absorbs binary rounding: (1 − 0.9) · 100 is 9.999…, which must count 10 observations.
  const tailCount = Math.max(1, Math.floor((1 - level) * sorted.length + 1e-9));
  const tail = sorted.slice(0, tailCount);
  return {
    var: -sorted[tailCount - 1]!,
    expectedShortfall: -(tail.reduce((s, v) => s + v, 0) / tail.length),
    observations: returns.length,
  };
}

/**
 * Hypothetical covariance stress: volatilities × `volMultiplier`, and every off-diagonal correlation
 * raised to at least `correlationFloor` (a correlation spike). The result is a scenario, not a forecast.
 * Raising correlations element-wise does not guarantee a positive semi-definite matrix in general; with a
 * floor ≥ 0 and long-only weights the resulting portfolio variance is still a valid upper-stress figure.
 */
export function stressCovariance(S: readonly number[][], scenario: { volMultiplier: number; correlationFloor: number }): number[][] {
  if (!(scenario.volMultiplier > 0)) throw new Error("stressCovariance: volMultiplier must be > 0");
  if (!(scenario.correlationFloor >= -1 && scenario.correlationFloor <= 1)) throw new Error("stressCovariance: correlationFloor must be in [-1, 1]");
  const sd = S.map((row, i) => Math.sqrt(Math.max(0, row[i]!)) * scenario.volMultiplier);
  const C = correlationFromCovariance(S);
  return S.map((row, i) =>
    row.map((_, j) => {
      if (i === j) return sd[i]! * sd[i]!;
      const rho = C[i]![j];
      const stressed = rho === null || rho === undefined ?scenario.correlationFloor : Math.max(rho, scenario.correlationFloor);
      return stressed * sd[i]! * sd[j]!;
    }),
  );
}

export type ShockScenario = { name: string; description: string; shocksByMarket: Record<string, number> };

/**
 * Hypothetical instantaneous shocks keyed by warehouse cohort (`HistoricalDataset.cohort`: LIQUID_MAJOR,
 * ESTABLISHED_SOLANA, SPECULATIVE_SOLANA, INACTIVE, BROAD_ETF, MAJOR_FX). Labelled HYPOTHETICAL: the
 * magnitudes are scenario inputs chosen for stress testing, not estimates of likelihood. A scenario states
 * every cohort it covers, including 0% moves, so an omission is never mistaken for "no loss".
 */
export const HYPOTHETICAL_SHOCKS: readonly ShockScenario[] = [
  { name: "EQUITY_CRASH", description: "Broad equity −20%, crypto −30%, FX unchanged", shocksByMarket: { BROAD_ETF: -0.2, LIQUID_MAJOR: -0.3, ESTABLISHED_SOLANA: -0.3, SPECULATIVE_SOLANA: -0.3, INACTIVE: -0.3, MAJOR_FX: 0 } },
  { name: "CRYPTO_LIQUIDITY_COLLAPSE", description: "Liquid crypto −40%, established Solana −60%, long tail −80%; equity and FX unchanged", shocksByMarket: { LIQUID_MAJOR: -0.4, ESTABLISHED_SOLANA: -0.6, SPECULATIVE_SOLANA: -0.8, INACTIVE: -0.8, BROAD_ETF: 0, MAJOR_FX: 0 } },
  { name: "EVERYTHING_DOWN", description: "Every risky cohort −25%, FX −5% (correlation → 1)", shocksByMarket: { BROAD_ETF: -0.25, LIQUID_MAJOR: -0.25, ESTABLISHED_SOLANA: -0.25, SPECULATIVE_SOLANA: -0.25, INACTIVE: -0.25, MAJOR_FX: -0.05 } },
];

/**
 * Return of a long-only allocation under an instantaneous shock. When any asset with a non-zero weight
 * belongs to a market the scenario does not cover, the portfolio return is null (unknown, not 0%) and
 * the assets are listed in `unshockedAssets`.
 */
export function scenarioLoss(weights: readonly number[], markets: ReadonlyArray<string | null>, scenario: ShockScenario): { portfolioReturn: number | null; unshockedAssets: number[] } {
  let portfolioReturn = 0;
  const unshockedAssets: number[] = [];
  weights.forEach((w, i) => {
    const market = markets[i];
    const shock = market ? scenario.shocksByMarket[market] : undefined;
    if (shock === undefined) {
      if (w !== 0) unshockedAssets.push(i);
    } else {
      portfolioReturn += w * shock;
    }
  });
  return { portfolioReturn: unshockedAssets.length > 0 ? null : portfolioReturn, unshockedAssets };
}

// ---------- Point-in-time allocation backtest ----------

export type AllocationBacktestConfig = {
  /** Observations used to estimate the covariance at each rebalance (strictly before the rebalance bar). */
  lookback: number;
  /** Rebalance every N bars. */
  rebalanceEvery: number;
  /** Cost charged on one-way turnover at each rebalance, in bps of traded notional. */
  costBpsPerSide: number;
  /** Apply Ledoit–Wolf shrinkage to the estimate. */
  shrink: boolean;
  /** Optional annualised volatility target (scale-down only). */
  targetVol?: number;
  periodsPerYear: number;
  maxWeight?: number;
};

export type AllocationBacktest = {
  rule: AllocationRule;
  version: string;
  /** Per-bar portfolio returns net of rebalance costs, from the first successful rebalance onwards. */
  netReturns: number[];
  grossReturns: number[];
  /** Index (in the aligned rows) of netReturns[0]: the first successful rebalance, or −1 when there was none. */
  startIndex: number;
  rebalances: number;
  /** Target weights set at each rebalance bar (applied to that bar's return), for audit. */
  rebalanceWeights: Array<{ index: number; weights: number[] }>;
  /** Rebalances skipped because the rule was undefined on that window (the portfolio was held unchanged). */
  skippedRebalances: number;
  turnover: number;
  /** Sum of per-rebalance cost fractions (simple, for comparison with turnover × bps). */
  costSum: number;
  /** Compounded cost drag: 1 − Π(1 − cost_k). */
  costDrag: number;
  totalReturnNet: number;
  totalReturnGross: number;
  annualisedVolatility: number | null;
  maxDrawdown: number;
  /** Ratios are withheld below 100 invested bars, as elsewhere in research/. */
  sharpe: number | null;
  /** False when no rebalance succeeded or fewer than 100 bars were evaluated after the first one. */
  sufficient: boolean;
  evidence: "RESEARCH_ONLY";
};

function maxDrawdownOf(returns: readonly number[]): number {
  let e = 1;
  let peak = 1;
  let depth = 0;
  for (const r of returns) {
    e *= 1 + r;
    peak = Math.max(peak, e);
    depth = Math.max(depth, 1 - e / peak);
  }
  return depth;
}

/**
 * Historical, point-in-time evaluation of an allocation rule. Weights applied from bar k are estimated on
 * bars k−lookback … k−1. Between rebalances weights drift with returns; cash earns 0. This is descriptive
 * research: it never validates a rule on its own (that needs the ASCEND-03 walk-forward protocol).
 */
export function backtestAllocation(aligned: Pick<AlignedReturns, "returns">, rule: AllocationRule, config: AllocationBacktestConfig): AllocationBacktest {
  const X = aligned.returns;
  const N = X[0]?.length ?? 0;
  if (!Number.isInteger(config.lookback) || config.lookback < MIN_OBSERVATIONS) throw new Error(`backtestAllocation: lookback must be an integer ≥ ${MIN_OBSERVATIONS}`);
  if (!Number.isInteger(config.rebalanceEvery) || config.rebalanceEvery < 1) throw new Error("backtestAllocation: rebalanceEvery must be ≥ 1");
  if (!(config.costBpsPerSide >= 0)) throw new Error("backtestAllocation: cost must be ≥ 0");
  for (const row of X) {
    if (row.length !== N) throw new Error("backtestAllocation: ragged return rows");
    if (row.some((r) => !Number.isFinite(r) || r <= -1)) throw new Error("backtestAllocation: non-finite or ≤ −100% return");
  }
  let startIndex = -1;
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  let w: number[] = new Array<number>(N).fill(0);
  let rebalances = 0;
  let skipped = 0;
  let turnover = 0;
  let costSum = 0;
  let keep = 1;
  const rebalanceWeights: Array<{ index: number; weights: number[] }> = [];
  for (let k = config.lookback; k < X.length; k++) {
    let cost = 0;
    if ((k - config.lookback) % config.rebalanceEvery === 0) {
      const window = X.slice(k - config.lookback, k);
      const S = config.shrink ? ledoitWolfCovariance(window)?.covariance ?? null : covarianceMatrix(window);
      let target = S ? allocate(rule, S) : null;
      if (target && config.maxWeight !== undefined) target = capWeights(target, config.maxWeight);
      if (target && S && config.targetVol !== undefined) target = volatilityTarget(target, S, config.targetVol, config.periodsPerYear)?.weights ?? null;
      if (target) {
        const traded = target.reduce((s, v, i) => s + Math.abs(v - w[i]!), 0);
        cost = (traded * config.costBpsPerSide) / 10_000;
        turnover += traded;
        costSum += cost;
        keep *= 1 - cost;
        if (startIndex < 0) startIndex = k;
        w = target;
        rebalances += 1;
        rebalanceWeights.push({ index: k, weights: [...target] });
      } else {
        skipped += 1;
      }
    }
    // Before the first successful rebalance the book is all cash and is not evaluated.
    if (startIndex < 0) continue;
    const row = X[k]!;
    const gross = w.reduce((s, wi, i) => s + wi * row[i]!, 0);
    grossReturns.push(gross);
    netReturns.push((1 + gross) * (1 - cost) - 1);
    // Drift: each sleeve grows with its asset; cash (1 − Σw) is flat.
    const total = 1 + gross;
    if (total > 0) w = w.map((wi, i) => (wi * (1 + row[i]!)) / total);
  }
  const compound = (rs: readonly number[]) => rs.reduce((e, r) => e * (1 + r), 1) - 1;
  const n = netReturns.length;
  const mean = n > 0 ? netReturns.reduce((s, r) => s + r, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(netReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;
  const sufficient = rebalances > 0 && n >= 100;
  return {
    rule,
    version: PORTFOLIO_MODEL_VERSION,
    netReturns,
    grossReturns,
    startIndex,
    rebalances,
    rebalanceWeights,
    skippedRebalances: skipped,
    turnover,
    costSum,
    costDrag: 1 - keep,
    totalReturnNet: compound(netReturns),
    totalReturnGross: compound(grossReturns),
    annualisedVolatility: n > 1 ? sd * Math.sqrt(config.periodsPerYear) : null,
    maxDrawdown: maxDrawdownOf(netReturns),
    sharpe: sufficient && sd > 0 ? (mean / sd) * Math.sqrt(config.periodsPerYear) : null,
    sufficient,
    evidence: "RESEARCH_ONLY",
  };
}

// ---------- Report ----------

export type PortfolioReport = {
  version: string;
  ids: string[];
  observations: number;
  droppedTimestamps: number;
  invalidReturns: number;
  sufficient: boolean;
  correlation: Array<Array<number | null>> | null;
  shrinkage: number | null;
  /** Annualised volatility per asset from the shrunk covariance. */
  assetVolatility: number[] | null;
  allocations: Array<{
    rule: AllocationRule;
    weights: number[] | null;
    concentration: ReturnType<typeof concentration>;
    riskShares: number[] | null;
    annualisedVolatility: number | null;
    stressedVolatility: number | null;
    exposureByMarket: Record<string, number> | null;
    scenarios: Array<{ name: string; portfolioReturn: number | null; unshockedAssets: string[] }> | null;
  }>;
  limitations: string[];
  evidence: "RESEARCH_ONLY";
};

/** Descriptive portfolio analytics on aligned history. Every allocation here is a research output only. */
export function portfolioReport(series: readonly ReturnSeries[], options: { periodsPerYear: number; stress?: { volMultiplier: number; correlationFloor: number } }): PortfolioReport {
  const aligned = alignReturns(series);
  const lw = ledoitWolfCovariance(aligned.returns);
  const sufficient = lw !== null;
  const stress = options.stress ?? { volMultiplier: 2, correlationFloor: 0.8 };
  const S = lw?.covariance ?? null;
  const stressed = S ? stressCovariance(S, stress) : null;
  const limitations = [
    "Covariances are estimated from history and are unstable; the shrinkage estimate reduces, not removes, that error.",
    "Allocations are research outputs. They never size orders or override the trading-risk engine.",
    "Scenario shocks are hypothetical inputs, not probabilities.",
    "The allocations below are fitted on the whole sample and described on the same sample (in-sample); equal risk shares hold by construction, not as evidence. Out-of-sample behaviour is what backtestAllocation measures.",
  ];
  if (aligned.droppedTimestamps > 0) limitations.push(`${aligned.droppedTimestamps} timestamps were dropped (${aligned.invalidReturns} for non-finite or ≤ −100% returns, the rest missing from at least one series); nothing was filled.`);
  if (!sufficient) limitations.push(`No covariance or allocation is reported: fewer than ${MIN_OBSERVATIONS} aligned observations, or an asset has zero variance (a frozen or constant series).`);
  const rules: AllocationRule[] = ["EQUAL_WEIGHT", "INVERSE_VOLATILITY", "EQUAL_RISK_CONTRIBUTION"];
  return {
    version: PORTFOLIO_MODEL_VERSION,
    ids: aligned.ids,
    observations: aligned.returns.length,
    droppedTimestamps: aligned.droppedTimestamps,
    invalidReturns: aligned.invalidReturns,
    sufficient,
    correlation: correlationMatrix(aligned.returns),
    shrinkage: lw?.shrinkage ?? null,
    assetVolatility: S ? S.map((row, i) => Math.sqrt(row[i]! * options.periodsPerYear)) : null,
    allocations: rules.map((rule) => {
      const weights = S ? allocate(rule, S) : null;
      const rc = weights && S ? riskContributions(weights, S) : null;
      return {
        rule,
        weights,
        concentration: weights ? concentration(weights) : null,
        riskShares: rc?.shares ?? null,
        annualisedVolatility: rc ? rc.volatility * Math.sqrt(options.periodsPerYear) : null,
        stressedVolatility: weights && stressed ? Math.sqrt(portfolioVariance(weights, stressed) * options.periodsPerYear) : null,
        exposureByMarket: weights ? exposureBy(weights, aligned.markets) : null,
        scenarios: weights
          ? HYPOTHETICAL_SHOCKS.map((scenario) => {
              const loss = scenarioLoss(weights, aligned.markets, scenario);
              return { name: scenario.name, portfolioReturn: loss.portfolioReturn, unshockedAssets: loss.unshockedAssets.map((i) => aligned.ids[i]!) };
            })
          : null,
      };
    }),
    limitations,
    evidence: "RESEARCH_ONLY",
  };
}
