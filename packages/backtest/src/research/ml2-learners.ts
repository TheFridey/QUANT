import { seededRng } from "../stats.js";
import type { NullPolicy } from "./feature-set.js";

/**
 * GENESIS Phase 4 learners and per-fold preprocessing. Pure, deterministic (seeded where random), no
 * dependencies; every artefact is plain JSON numbers.
 *
 * - `fitPreprocessor`: training-median imputation and standardisation, fitted on the rows it is given only.
 * - `fitRandomForest`: bagged depth-limited regression trees on {0, 1} targets (a probability forest). Rows are
 *   subsampled without replacement and features per split are drawn from a seeded PRNG.
 * - `fitPlattCalibrator` / `fitIsotonicCalibrator`: post-hoc calibration, to be fitted on an inner split the
 *   model itself never trained on.
 */

export type Preprocessor = { nullPolicy: NullPolicy; medians: number[]; mean: number[]; sd: number[]; rows: number };

function columnMedian(col: number[]): number {
  const s = col.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Fit imputation medians and the standardiser on `X` (training rows only). NaN marks a missing value. */
export function fitPreprocessor(X: readonly number[][], nullPolicy: NullPolicy): Preprocessor {
  const d = X[0]?.length ?? 0;
  const medians: number[] = [];
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < d; j += 1) {
    const col = X.map((r) => r[j]!);
    const med = columnMedian(col);
    medians.push(med);
    const filled = col.map((v) => (Number.isFinite(v) ? v : med));
    const m = filled.reduce((s, v) => s + v, 0) / Math.max(1, filled.length);
    const v = filled.length > 1 ? filled.reduce((s, x) => s + (x - m) ** 2, 0) / (filled.length - 1) : 0;
    mu.push(m);
    sd.push(v > 0 ? Math.sqrt(v) : 1);
  }
  return { nullPolicy, medians, mean: mu, sd, rows: X.length };
}

/** Impute (training medians) then standardise. */
export function transformRow(p: Preprocessor, x: readonly number[]): number[] {
  return x.map((v, j) => ((Number.isFinite(v) ? v : p.medians[j]!) - p.mean[j]!) / p.sd[j]!);
}

type Node = { f: number; th: number; l: number; r: number; v: number };
export type ForestArtefact = { family: "RANDOM_FOREST"; trees: Node[][]; params: ForestParams };
export type ForestParams = { trees: number; maxDepth: number; minLeaf: number; sampleFraction: number; featuresPerSplit: number; thresholds: number; seed: number };
export const DEFAULT_FOREST_PARAMS: ForestParams = { trees: 40, maxDepth: 3, minLeaf: 40, sampleFraction: 0.5, featuresPerSplit: 0, thresholds: 9, seed: 7 };

/** Probability forest on standardised rows `Z` and {0,1} targets `y`. `featuresPerSplit` 0 means ⌈√d⌉. */
export function fitRandomForest(Z: readonly number[][], y: readonly number[], params: Partial<ForestParams> = {}): ForestArtefact {
  const p: ForestParams = { ...DEFAULT_FOREST_PARAMS, ...params };
  if (!Number.isInteger(p.trees) || p.trees < 1 || !Number.isInteger(p.maxDepth) || p.maxDepth < 1 || p.maxDepth > 12 || !(p.minLeaf >= 1) || !(p.sampleFraction > 0 && p.sampleFraction <= 1)) {
    throw new Error(`invalid forest parameters ${JSON.stringify(p)}`);
  }
  const n = Z.length;
  const d = Z[0]?.length ?? 0;
  const k = p.featuresPerSplit > 0 ? Math.min(d, p.featuresPerSplit) : Math.max(1, Math.ceil(Math.sqrt(d)));
  const rng = seededRng(p.seed);
  const trees: Node[][] = [];
  const leafValue = (idx: number[]) => (idx.reduce((s, i) => s + y[i]!, 0) + 1) / (idx.length + 2);
  for (let t = 0; t < p.trees; t += 1) {
    // Subsample without replacement (partial Fisher–Yates).
    const perm = Array.from({ length: n }, (_, i) => i);
    const m = Math.max(1, Math.floor(n * p.sampleFraction));
    for (let i = 0; i < m; i += 1) {
      const j = i + Math.floor(rng() * (n - i));
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    }
    const nodes: Node[] = [];
    const grow = (idx: number[], depth: number): number => {
      const id = nodes.length;
      nodes.push({ f: -1, th: 0, l: -1, r: -1, v: leafValue(idx) });
      if (depth >= p.maxDepth || idx.length < 2 * p.minLeaf) return id;
      // Feature subset for this split.
      const feats = Array.from({ length: d }, (_, i) => i);
      for (let i = 0; i < k; i += 1) {
        const j = i + Math.floor(rng() * (d - i));
        [feats[i], feats[j]] = [feats[j]!, feats[i]!];
      }
      const total = idx.reduce((s, i) => s + y[i]!, 0);
      const parentSse = total - (total * total) / idx.length;
      let best: { f: number; th: number; gain: number } | null = null;
      for (const f of feats.slice(0, k)) {
        const col = idx.map((i) => Z[i]![f]!).sort((a, b) => a - b);
        const ths = [...new Set(Array.from({ length: p.thresholds }, (_, q) => col[Math.floor(((q + 1) / (p.thresholds + 1)) * (col.length - 1))]!))];
        for (const th of ths) {
          let nl = 0;
          let sl = 0;
          for (const i of idx) {
            if (Z[i]![f]! <= th) {
              nl += 1;
              sl += y[i]!;
            }
          }
          const nr = idx.length - nl;
          if (nl < p.minLeaf || nr < p.minLeaf) continue;
          const sr = total - sl;
          const sse = sl - (sl * sl) / nl + (sr - (sr * sr) / nr);
          const gain = parentSse - sse;
          if (gain > 1e-12 && (!best || gain > best.gain)) best = { f, th, gain };
        }
      }
      if (!best) return id;
      const left = idx.filter((i) => Z[i]![best!.f]! <= best!.th);
      const right = idx.filter((i) => Z[i]![best!.f]! > best!.th);
      const l = grow(left, depth + 1);
      const r = grow(right, depth + 1);
      nodes[id] = { f: best.f, th: best.th, l, r, v: nodes[id]!.v };
      return id;
    };
    grow(perm.slice(0, m).sort((a, b) => a - b), 0);
    trees.push(nodes);
  }
  return { family: "RANDOM_FOREST", trees, params: p };
}

export function predictForest(a: ForestArtefact, z: readonly number[]): number {
  let s = 0;
  for (const nodes of a.trees) {
    let id = 0;
    while (nodes[id]!.f >= 0) id = z[nodes[id]!.f]! <= nodes[id]!.th ? nodes[id]!.l : nodes[id]!.r;
    s += nodes[id]!.v;
  }
  return a.trees.length ? s / a.trees.length : 0.5;
}

export type Calibrator = { method: "NONE" } | { method: "PLATT"; a: number; b: number } | { method: "ISOTONIC"; x: number[]; y: number[] };

const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const sig = (z: number) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

/** Platt scaling: P = σ(a·logit(p) + b), fitted by Newton's method with Platt's smoothed targets. */
export function fitPlattCalibrator(p: readonly number[], y: readonly number[]): Calibrator {
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (!pos || !neg) return { method: "NONE" };
  const tPos = (pos + 1) / (pos + 2);
  const tNeg = 1 / (neg + 2);
  const t = y.map((v) => (v === 1 ? tPos : tNeg));
  const x = p.map(logit);
  const loss = (a: number, b: number) => {
    let s = 0;
    for (let i = 0; i < x.length; i += 1) {
      const q = clampP(sig(a * x[i]! + b));
      s -= t[i]! * Math.log(q) + (1 - t[i]!) * Math.log(1 - q);
    }
    return s;
  };
  let a = 1;
  let b = 0;
  let current = loss(a, b);
  for (let it = 0; it < 100; it += 1) {
    let g1 = 0;
    let g2 = 0;
    let h11 = 1e-9;
    let h22 = 1e-9;
    let h12 = 0;
    for (let i = 0; i < x.length; i += 1) {
      const q = sig(a * x[i]! + b);
      const e = q - t[i]!;
      const w = q * (1 - q);
      g1 += e * x[i]!;
      g2 += e;
      h11 += w * x[i]! * x[i]!;
      h22 += w;
      h12 += w * x[i]!;
    }
    const det = h11 * h22 - h12 * h12;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (h22 * g1 - h12 * g2) / det;
    const db = (h11 * g2 - h12 * g1) / det;
    // Damped Newton: halve the step until the loss does not increase.
    let step = 1;
    let next = loss(a - da, b - db);
    while (next > current && step > 1e-6) {
      step /= 2;
      next = loss(a - step * da, b - step * db);
    }
    if (next > current) break;
    a -= step * da;
    b -= step * db;
    const moved = step * (Math.abs(da) + Math.abs(db));
    current = next;
    if (moved < 1e-10) break;
  }
  return Number.isFinite(a) && Number.isFinite(b) ? { method: "PLATT", a, b } : { method: "NONE" };
}

/** Isotonic regression by pool-adjacent-violators; prediction is a step function of the raw score. */
export function fitIsotonicCalibrator(p: readonly number[], y: readonly number[]): Calibrator {
  if (p.length < 2) return { method: "NONE" };
  const order = p.map((v, i) => ({ v, y: y[i]! })).sort((a, b) => a.v - b.v);
  const blocks: Array<{ x: number; sum: number; n: number }> = [];
  for (const o of order) {
    blocks.push({ x: o.v, sum: o.y, n: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.n > blocks.at(-1)!.sum / blocks.at(-1)!.n) {
      const last = blocks.pop()!;
      const prev = blocks.at(-1)!;
      prev.sum += last.sum;
      prev.n += last.n;
      prev.x = last.x; // block keyed by its largest score
    }
  }
  // Shrink each block mean slightly towards 0.5 so a calibrated probability is never exactly 0 or 1.
  return { method: "ISOTONIC", x: blocks.map((b) => b.x), y: blocks.map((b) => (b.sum + 0.5) / (b.n + 1)) };
}

export function applyCalibrator(c: Calibrator, p: number): number {
  if (c.method === "NONE") return p;
  if (c.method === "PLATT") return sig(c.a * logit(p) + c.b);
  // First block whose upper score is ≥ p; beyond the last block, the last value.
  let lo = 0;
  let hi = c.x.length - 1;
  if (p > c.x[hi]!) return c.y[hi]!;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.x[mid]! >= p) hi = mid;
    else lo = mid + 1;
  }
  return c.y[lo]!;
}
