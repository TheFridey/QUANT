import { createHash } from "node:crypto";
import { mean, normalCdf, stdev } from "../stats.js";
import { FEATURE_NAMES, featureSetHash, type FeatureRow, type Label } from "./features.js";

/**
 * ASCEND-05 baseline predictive models and their honest evaluation.
 *
 * Models (deterministic, no RNG, no external dependency): historical base rate, L2 logistic regression, and
 * gradient-boosted decision stumps. Artefacts are plain JSON numbers (no code, no unsafe deserialisation).
 *
 * Protocol: the last `holdoutFraction` of samples is reserved and never evaluated here. The rest is split into
 * expanding walk-forward folds. Training samples whose label window reaches the test window are purged, plus
 * an embargo; standardisation is fitted on each fold's training rows only. All reported metrics are on the
 * concatenated test folds. A model only has skill if it beats the base rate out of sample, and only has
 * economic value if acting on it beats both entering every time and holding cash, after costs.
 */

export const ML_PROTOCOL_VERSION = "ml-wf-1.0.0";

export type ModelFamily = "BASE_RATE" | "LOGISTIC_L2" | "BOOSTED_STUMPS";

type Standardiser = { mean: number[]; sd: number[] };
export type ModelArtefact =
  | { family: "BASE_RATE"; featureSet: string; p: number }
  | { family: "LOGISTIC_L2"; featureSet: string; features: string[]; standardiser: Standardiser; weights: number[]; bias: number; lambda: number }
  | { family: "BOOSTED_STUMPS"; featureSet: string; features: string[]; standardiser: Standardiser; base: number; rate: number; stumps: Array<{ feature: number; threshold: number; left: number; right: number }> };

export function artefactHash(a: ModelArtefact): string {
  return createHash("sha256").update(JSON.stringify(a)).digest("hex").slice(0, 24);
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

function fitStandardiser(rows: number[][]): Standardiser {
  const d = rows[0]?.length ?? 0;
  const m: number[] = [];
  const s: number[] = [];
  for (let j = 0; j < d; j += 1) {
    const col = rows.map((r) => r[j]!);
    m.push(mean(col) ?? 0);
    const sd = stdev(col) ?? 0;
    s.push(sd > 0 ? sd : 1);
  }
  return { mean: m, sd: s };
}

const apply = (st: Standardiser, x: number[]) => x.map((v, j) => (v - st.mean[j]!) / st.sd[j]!);

export function fitBaseRate(y: number[]): ModelArtefact {
  return { family: "BASE_RATE", featureSet: featureSetHash(), p: mean(y) ?? 0.5 };
}

export function fitLogistic(X: number[][], y: number[], features: string[] = FEATURE_NAMES, lambda = 0.01, iterations = 400, rate = 0.2): ModelArtefact {
  const standardiser = fitStandardiser(X);
  const Z = X.map((x) => apply(standardiser, x));
  const d = Z[0]?.length ?? 0;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  const n = Z.length;
  for (let it = 0; it < iterations; it += 1) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i += 1) {
      const z = Z[i]!;
      let s = b;
      for (let j = 0; j < d; j += 1) s += w[j]! * z[j]!;
      const e = sigmoid(s) - y[i]!;
      gb += e;
      for (let j = 0; j < d; j += 1) gw[j]! += e * z[j]!;
    }
    for (let j = 0; j < d; j += 1) w[j] = w[j]! - rate * (gw[j]! / n + lambda * w[j]!);
    b -= rate * (gb / n);
  }
  return { family: "LOGISTIC_L2", featureSet: featureSetHash(), features, standardiser, weights: w, bias: b, lambda };
}

export function fitBoostedStumps(X: number[][], y: number[], features: string[] = FEATURE_NAMES, rounds = 60, rate = 0.1, candidates = 9): ModelArtefact {
  const standardiser = fitStandardiser(X);
  const Z = X.map((x) => apply(standardiser, x));
  const n = Z.length;
  const d = Z[0]?.length ?? 0;
  const p0 = Math.min(0.99, Math.max(0.01, mean(y) ?? 0.5));
  const base = Math.log(p0 / (1 - p0));
  const F = new Array<number>(n).fill(base);
  // Candidate thresholds: training-set quantiles of each standardised feature.
  const thresholds: number[][] = [];
  for (let j = 0; j < d; j += 1) {
    const col = Z.map((z) => z[j]!).sort((a, b) => a - b);
    thresholds.push([...new Set(Array.from({ length: candidates }, (_, k) => col[Math.floor(((k + 1) / (candidates + 1)) * (col.length - 1))]!))]);
  }
  const stumps: Array<{ feature: number; threshold: number; left: number; right: number }> = [];
  for (let r = 0; r < rounds; r += 1) {
    const g = F.map((f, i) => y[i]! - sigmoid(f));
    const hess = F.map((f) => {
      const p = sigmoid(f);
      return Math.max(1e-6, p * (1 - p));
    });
    let best: { feature: number; threshold: number; left: number; right: number; gain: number } | null = null;
    for (let j = 0; j < d; j += 1) {
      for (const th of thresholds[j]!) {
        let gl = 0;
        let hl = 0;
        let gr = 0;
        let hr = 0;
        for (let i = 0; i < n; i += 1) {
          if (Z[i]![j]! <= th) {
            gl += g[i]!;
            hl += hess[i]!;
          } else {
            gr += g[i]!;
            hr += hess[i]!;
          }
        }
        const gain = (gl * gl) / (hl + 1) + (gr * gr) / (hr + 1);
        if (!best || gain > best.gain) best = { feature: j, threshold: th, left: gl / (hl + 1), right: gr / (hr + 1), gain };
      }
    }
    if (!best) break;
    stumps.push({ feature: best.feature, threshold: best.threshold, left: best.left, right: best.right });
    for (let i = 0; i < n; i += 1) F[i]! += rate * (Z[i]![best.feature]! <= best.threshold ? best.left : best.right);
  }
  return { family: "BOOSTED_STUMPS", featureSet: featureSetHash(), features, standardiser, base, rate, stumps };
}

export function predict(a: ModelArtefact, x: number[]): number {
  if (a.family === "BASE_RATE") return a.p;
  const z = apply(a.standardiser, x);
  if (a.family === "LOGISTIC_L2") return sigmoid(a.bias + a.weights.reduce((s, w, j) => s + w * z[j]!, 0));
  let f = a.base;
  for (const s of a.stumps) f += a.rate * (z[s.feature]! <= s.threshold ? s.left : s.right);
  return sigmoid(f);
}

export type Calibration = { brier: number; logLoss: number; ece: number; auc: number | null; reliability: Array<{ lo: number; hi: number; n: number; meanP: number; observed: number }> };

export function calibration(p: number[], y: number[], bins = 10): Calibration {
  const n = p.length;
  const eps = 1e-12;
  const brier = p.reduce((s, pi, i) => s + (pi - y[i]!) ** 2, 0) / Math.max(1, n);
  const logLoss = -p.reduce((s, pi, i) => s + (y[i]! ? Math.log(Math.max(eps, pi)) : Math.log(Math.max(eps, 1 - pi))), 0) / Math.max(1, n);
  const reliability: Calibration["reliability"] = [];
  let ece = 0;
  for (let b = 0; b < bins; b += 1) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = p.map((_, i) => i).filter((i) => p[i]! >= lo && (b === bins - 1 ? p[i]! <= hi : p[i]! < hi));
    if (!idx.length) continue;
    const meanP = idx.reduce((s, i) => s + p[i]!, 0) / idx.length;
    const observed = idx.reduce((s, i) => s + y[i]!, 0) / idx.length;
    reliability.push({ lo, hi, n: idx.length, meanP, observed });
    ece += (idx.length / n) * Math.abs(meanP - observed);
  }
  // AUC by Mann–Whitney with mid-ranks.
  const pos = y.filter((v) => v === 1).length;
  const neg = n - pos;
  let auc: number | null = null;
  if (pos > 0 && neg > 0) {
    const order = p.map((v, i) => ({ v, y: y[i]! })).sort((a, b) => a.v - b.v);
    let rankSum = 0;
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j += 1;
      const mid = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) if (order[k]!.y === 1) rankSum += mid;
      i = j + 1;
    }
    auc = (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
  }
  return { brier, logLoss, ece, auc, reliability };
}

/** Population stability index of `actual` against `expected` deciles (feature drift). */
export function psi(expected: number[], actual: number[], bins = 10): number | null {
  if (expected.length < bins * 5 || actual.length < bins) return null;
  const sorted = [...expected].sort((a, b) => a - b);
  const edges = Array.from({ length: bins - 1 }, (_, k) => sorted[Math.floor(((k + 1) / bins) * sorted.length)]!);
  const share = (xs: number[]) => {
    const counts = new Array<number>(bins).fill(0);
    for (const x of xs) {
      let b = 0;
      while (b < edges.length && x > edges[b]!) b += 1;
      counts[b]! += 1;
    }
    return counts.map((c) => Math.max(1e-4, c / xs.length));
  };
  const e = share(expected);
  const a = share(actual);
  return a.reduce((s, ai, k) => s + (ai - e[k]!) * Math.log(ai / e[k]!), 0);
}

export type MlConfig = {
  folds: number;
  holdoutFraction: number;
  /** Extra bars purged after the label horizon. */
  embargoBars: number;
  /** Rows with more missing features than this share are excluded (never imputed into a forecast). */
  maxMissingShare: number;
  /** Pre-declared entry threshold on P(net-positive). */
  entryThreshold: number;
  /** Abstain when the two learned models disagree by more than this. */
  maxDisagreement: number;
  /** Abstain when any standardised feature exceeds this |z| (out of training distribution). */
  maxAbsZ: number;
};

export const DEFAULT_ML_CONFIG: MlConfig = { folds: 4, holdoutFraction: 0.2, embargoBars: 0, maxMissingShare: 0, entryThreshold: 0.55, maxDisagreement: 0.15, maxAbsZ: 5 };

export type MlVerdict = "NO_SKILL" | "INSUFFICIENT_EVIDENCE" | "SKILL_NOT_ECONOMIC" | "SHADOW_ELIGIBLE";

export type FoldSummary = { fold: number; trainRows: number; purged: number; testRows: number; lastTrainLabelEndIndex: number; firstTestIndex: number; trainStartT: number; trainEndT: number; testStartT: number; testEndT: number; artefactHashes: Record<ModelFamily, string> };

export type MlReport = {
  protocol: string;
  featureSet: string;
  horizon: number;
  costBpsPerSide: number;
  config: MlConfig;
  rows: { total: number; usable: number; excludedMissing: number; holdoutReserved: number };
  folds: FoldSummary[];
  oos: Record<ModelFamily, Calibration> | null;
  brierSkill: { logistic: number | null; boosted: number | null };
  /** One-sided p-value that AUC > 0.5 (Hanley–McNeil, effective n deflated by the label overlap). */
  aucPValue: { logistic: number | null; boosted: number | null };
  drift: Array<{ feature: string; psi: number | null }>;
  decisions: {
    signals: number;
    abstained: { disagreement: number; outOfDistribution: number };
    /** Mean net forward return per signal (overlapping horizons: per-signal expectancy, not a portfolio return). */
    selectedMean: number | null;
    selectedSe: number | null;
    alwaysEnterMean: number | null;
  };
  verdict: MlVerdict;
  reasons: string[];
  finalArtefacts: Record<ModelFamily, { hash: string; artefact: ModelArtefact }> | null;
};

/**
 * Walk-forward evaluation of all three model families on one feature/label set. Holdout rows are counted but
 * never evaluated. `labels[i]` aligns with `features[i]`.
 */
export function evaluateModels(input: { features: readonly FeatureRow[]; labels: ReadonlyArray<Label | null>; horizon: number; costBpsPerSide: number; config?: MlConfig }): MlReport {
  const cfg = input.config ?? DEFAULT_ML_CONFIG;
  const reasons: string[] = [];
  const rows: Array<{ i: number; t: number; end: number; x: number[]; y: number; ret: number }> = [];
  let excludedMissing = 0;
  let total = 0;
  for (const f of input.features) {
    const label = input.labels[f.index];
    if (!label) continue;
    total += 1;
    const raw = FEATURE_NAMES.map((name) => f.values[name] ?? null);
    rows.push({ i: f.index, t: f.t, end: label.endIndex, x: raw.map((v) => (v === null || !Number.isFinite(v) ? Number.NaN : v)), y: label.positive, ret: label.netReturn });
  }
  // Columns missing in every row are structural (not applicable to this interval); drop them.
  const keep = FEATURE_NAMES.map((_, j) => rows.some((r) => Number.isFinite(r.x[j]!)));
  const usableRows = rows
    .map((r) => ({ ...r, x: r.x.filter((_, j) => keep[j]) }))
    .filter((r) => {
      const missing = r.x.filter((v) => !Number.isFinite(v)).length / Math.max(1, r.x.length);
      if (missing > cfg.maxMissingShare) {
        excludedMissing += 1;
        return false;
      }
      return true;
    });
  const featureNames = FEATURE_NAMES.filter((_, j) => keep[j]);
  const holdoutStart = Math.floor(usableRows.length * (1 - cfg.holdoutFraction));
  const firstHoldoutBar = usableRows[holdoutStart]?.i ?? Number.POSITIVE_INFINITY;
  // A pre-holdout label may not read a holdout bar.
  const pre = usableRows.slice(0, holdoutStart).filter((r) => r.end < firstHoldoutBar);
  const segment = Math.floor(pre.length / (cfg.folds + 1));
  const base: Omit<MlReport, "folds" | "oos" | "brierSkill" | "aucPValue" | "drift" | "decisions" | "verdict" | "reasons" | "finalArtefacts"> = {
    protocol: ML_PROTOCOL_VERSION,
    featureSet: featureSetHash(),
    horizon: input.horizon,
    costBpsPerSide: input.costBpsPerSide,
    config: cfg,
    rows: { total, usable: usableRows.length, excludedMissing, holdoutReserved: usableRows.length - holdoutStart },
  };
  const effectiveTest = (pre.length - segment) / Math.max(1, input.horizon);
  if (segment < 50 || effectiveTest < 100) {
    return {
      ...base,
      folds: [],
      oos: null,
      brierSkill: { logistic: null, boosted: null },
      aucPValue: { logistic: null, boosted: null },
      drift: [],
      decisions: { signals: 0, abstained: { disagreement: 0, outOfDistribution: 0 }, selectedMean: null, selectedSe: null, alwaysEnterMean: null },
      verdict: "INSUFFICIENT_EVIDENCE",
      reasons: [`${pre.length} pre-holdout rows at a ${input.horizon}-bar horizon give ≈${effectiveTest.toFixed(0)} independent test labels (< 100) or folds < 50 rows`],
      finalArtefacts: null,
    };
  }

  const folds: FoldSummary[] = [];
  const pAll: Record<ModelFamily, number[]> = { BASE_RATE: [], LOGISTIC_L2: [], BOOSTED_STUMPS: [] };
  const yAll: number[] = [];
  const retAll: number[] = [];
  let signals = 0;
  let disagreement = 0;
  let ood = 0;
  const selected: number[] = [];
  let lastTrain: typeof pre = [];
  let lastArtefacts: Record<ModelFamily, ModelArtefact> | null = null;
  const testX: number[][] = [];

  for (let k = 1; k <= cfg.folds; k += 1) {
    const testStartRow = segment * k;
    const testEndRow = k === cfg.folds ? pre.length : segment * (k + 1);
    const testRows = pre.slice(testStartRow, testEndRow);
    const firstTestBar = testRows[0]!.i;
    // Purge: a training label may not read any bar at or after the first test decision, plus the embargo.
    const candidates = pre.slice(0, testStartRow);
    const train = candidates.filter((r) => r.end < firstTestBar - cfg.embargoBars);
    const purged = candidates.length - train.length;
    if (train.length < 50) continue;
    const X = train.map((r) => r.x);
    const y = train.map((r) => r.y);
    const artefacts: Record<ModelFamily, ModelArtefact> = { BASE_RATE: fitBaseRate(y), LOGISTIC_L2: fitLogistic(X, y, featureNames), BOOSTED_STUMPS: fitBoostedStumps(X, y, featureNames) };
    const st = (artefacts.LOGISTIC_L2 as Extract<ModelArtefact, { family: "LOGISTIC_L2" }>).standardiser;
    for (const r of testRows) {
      const pl = predict(artefacts.LOGISTIC_L2, r.x);
      const pb = predict(artefacts.BOOSTED_STUMPS, r.x);
      pAll.BASE_RATE.push(predict(artefacts.BASE_RATE, r.x));
      pAll.LOGISTIC_L2.push(pl);
      pAll.BOOSTED_STUMPS.push(pb);
      yAll.push(r.y);
      retAll.push(r.ret);
      testX.push(r.x);
      const z = apply(st, r.x);
      const isOod = z.some((v) => Math.abs(v) > cfg.maxAbsZ);
      const disagree = Math.abs(pl - pb) > cfg.maxDisagreement;
      const p = (pl + pb) / 2;
      if (p >= cfg.entryThreshold) {
        if (isOod) ood += 1;
        else if (disagree) disagreement += 1;
        else {
          signals += 1;
          selected.push(r.ret);
        }
      }
    }
    folds.push({
      fold: k,
      trainRows: train.length,
      purged,
      testRows: testRows.length,
      lastTrainLabelEndIndex: Math.max(...train.map((r) => r.end)),
      firstTestIndex: firstTestBar,
      trainStartT: train[0]!.t,
      trainEndT: train.at(-1)!.t,
      testStartT: testRows[0]!.t,
      testEndT: testRows.at(-1)!.t,
      artefactHashes: { BASE_RATE: artefactHash(artefacts.BASE_RATE), LOGISTIC_L2: artefactHash(artefacts.LOGISTIC_L2), BOOSTED_STUMPS: artefactHash(artefacts.BOOSTED_STUMPS) },
    });
    lastTrain = train;
    lastArtefacts = artefacts;
  }

  if (!folds.length || !lastArtefacts) {
    return { ...base, folds, oos: null, brierSkill: { logistic: null, boosted: null }, aucPValue: { logistic: null, boosted: null }, drift: [], decisions: { signals: 0, abstained: { disagreement: 0, outOfDistribution: 0 }, selectedMean: null, selectedSe: null, alwaysEnterMean: null }, verdict: "INSUFFICIENT_EVIDENCE", reasons: ["no fold kept ≥ 50 training rows after purging"], finalArtefacts: null };
  }

  const oos = { BASE_RATE: calibration(pAll.BASE_RATE, yAll), LOGISTIC_L2: calibration(pAll.LOGISTIC_L2, yAll), BOOSTED_STUMPS: calibration(pAll.BOOSTED_STUMPS, yAll) };
  const skill = (c: Calibration) => (oos.BASE_RATE.brier > 0 ? 1 - c.brier / oos.BASE_RATE.brier : null);
  const brierSkill = { logistic: skill(oos.LOGISTIC_L2), boosted: skill(oos.BOOSTED_STUMPS) };
  // Overlapping labels are not independent: deflate n by the horizon before testing AUC.
  const pos = yAll.filter((v) => v === 1).length / Math.max(1, input.horizon);
  const neg = (yAll.length - yAll.filter((v) => v === 1).length) / Math.max(1, input.horizon);
  const aucP = (auc: number | null) => {
    if (auc === null || pos < 5 || neg < 5) return null;
    const q1 = auc / (2 - auc);
    const q2 = (2 * auc * auc) / (1 + auc);
    const se = Math.sqrt((auc * (1 - auc) + (pos - 1) * (q1 - auc * auc) + (neg - 1) * (q2 - auc * auc)) / (pos * neg));
    return se > 0 ? 1 - normalCdf((auc - 0.5) / se) : null;
  };
  const aucPValue = { logistic: aucP(oos.LOGISTIC_L2.auc), boosted: aucP(oos.BOOSTED_STUMPS.auc) };
  const drift = featureNames.map((feature, j) => ({ feature, psi: psi(lastTrain.map((r) => r.x[j]!), testX.map((x) => x[j]!)) }));
  const selectedMean = mean(selected);
  const selectedSd = stdev(selected);
  const selectedSe = selectedSd !== null && selected.length > 0 ? selectedSd * Math.sqrt(Math.max(1, input.horizon) / selected.length) : null;
  const alwaysEnterMean = mean(retAll);

  let verdict: MlVerdict;
  const bestSkill = Math.max(brierSkill.logistic ?? Number.NEGATIVE_INFINITY, brierSkill.boosted ?? Number.NEGATIVE_INFINITY);
  // Bonferroni over the two learned models.
  const bestP = Math.min(1, 2 * Math.min(aucPValue.logistic ?? 1, aucPValue.boosted ?? 1));
  if (!(bestSkill > 0) || bestP > 0.05) {
    verdict = "NO_SKILL";
    reasons.push(`best OOS Brier skill vs base rate ${Number.isFinite(bestSkill) ? bestSkill.toFixed(4) : "n/a"}; best AUC p-value ${bestP.toFixed(3)} (overlap-deflated, Bonferroni ×2)`);
  } else if (selected.length / Math.max(1, input.horizon) < 30) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`${selected.length} signals ≈ ${(selected.length / Math.max(1, input.horizon)).toFixed(0)} independent (< 30)`);
  } else if (selectedMean === null || selectedSe === null || selectedMean - 1.645 * selectedSe <= 0 || selectedMean <= (alwaysEnterMean ?? 0)) {
    verdict = "SKILL_NOT_ECONOMIC";
    reasons.push(`signal net mean ${((selectedMean ?? 0) * 100).toFixed(3)}% (lower 95% one-sided ${(((selectedMean ?? 0) - 1.645 * (selectedSe ?? 0)) * 100).toFixed(3)}%) vs always-enter ${((alwaysEnterMean ?? 0) * 100).toFixed(3)}% and cash 0%`);
  } else {
    verdict = "SHADOW_ELIGIBLE";
    reasons.push("Beats base rate, always-enter and cash out of sample; eligible for prospective shadow scoring only (never paper or live without operator approval)");
  }

  const finalArtefacts = {
    BASE_RATE: { hash: artefactHash(lastArtefacts.BASE_RATE), artefact: lastArtefacts.BASE_RATE },
    LOGISTIC_L2: { hash: artefactHash(lastArtefacts.LOGISTIC_L2), artefact: lastArtefacts.LOGISTIC_L2 },
    BOOSTED_STUMPS: { hash: artefactHash(lastArtefacts.BOOSTED_STUMPS), artefact: lastArtefacts.BOOSTED_STUMPS },
  };
  return { ...base, folds, oos, brierSkill, aucPValue, drift, decisions: { signals, abstained: { disagreement, outOfDistribution: ood }, selectedMean, selectedSe, alwaysEnterMean }, verdict, reasons, finalArtefacts };
}
