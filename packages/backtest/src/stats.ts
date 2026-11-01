/**
 * Small, dependency-free statistics used by the ASCEND research modules. Plain `number` maths: these are
 * research estimates, never ledger values. Every function refuses (returns null) rather than inventing a
 * figure when the sample cannot support it.
 */

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation (n − 1). Null below two observations. */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("normalQuantile requires 0 < p < 1");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const dd = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((dd[0]! * q + dd[1]!) * q + dd[2]!) * q + dd[3]!) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 via erf; |error| < 1.5e-7.
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Student-t quantile via the Cornish–Fisher expansion of the normal quantile. Accurate to ~1e-3 for df ≥ 3. */
export function studentTQuantile(p: number, df: number): number {
  if (df < 1) throw new Error("studentTQuantile requires df >= 1");
  const z = normalQuantile(p);
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
  );
}

export type MeanInterval = { n: number; mean: number; stdev: number; lower: number; upper: number; confidence: number };

/** Two-sided t interval for the mean. Null below `minN` (default 2). */
export function meanConfidenceInterval(xs: number[], confidence = 0.95, minN = 2): MeanInterval | null {
  if (xs.length < Math.max(2, minN)) return null;
  const m = mean(xs) as number;
  const s = stdev(xs) as number;
  const t = studentTQuantile(1 - (1 - confidence) / 2, xs.length - 1);
  const half = (t * s) / Math.sqrt(xs.length);
  return { n: xs.length, mean: m, stdev: s, lower: m - half, upper: m + half, confidence };
}

/** One-sided lower confidence bound for the mean. Null below `minN`. */
export function meanLowerBound(xs: number[], confidence = 0.9, minN = 2): number | null {
  if (xs.length < Math.max(2, minN)) return null;
  const m = mean(xs) as number;
  const s = stdev(xs) as number;
  return m - (studentTQuantile(confidence, xs.length - 1) * s) / Math.sqrt(xs.length);
}

/** Deterministic seeded PRNG (mulberry32) so every resample is reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval of a statistic. Deterministic for a given seed. */
export function bootstrapInterval(
  xs: number[],
  statistic: (sample: number[]) => number,
  options: { resamples?: number; confidence?: number; seed?: number } = {},
): { lower: number; upper: number; resamples: number } | null {
  if (xs.length < 2) return null;
  const resamples = options.resamples ?? 2000;
  const confidence = options.confidence ?? 0.95;
  const rng = seededRng(options.seed ?? 1);
  const stats: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample = Array.from({ length: xs.length }, () => xs[Math.floor(rng() * xs.length)]!);
    stats.push(statistic(sample));
  }
  return {
    lower: quantile(stats, (1 - confidence) / 2) as number,
    upper: quantile(stats, 1 - (1 - confidence) / 2) as number,
    resamples,
  };
}

export function skewness(xs: number[]): number | null {
  const s = stdev(xs);
  if (s === null || s === 0 || xs.length < 3) return null;
  const m = mean(xs) as number;
  return xs.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / xs.length;
}

/** Non-excess (Pearson) kurtosis; 3 for a normal distribution. */
export function kurtosis(xs: number[]): number | null {
  const s = stdev(xs);
  if (s === null || s === 0 || xs.length < 4) return null;
  const m = mean(xs) as number;
  return xs.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / xs.length;
}
