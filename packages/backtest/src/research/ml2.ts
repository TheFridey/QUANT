import { createHash } from "node:crypto";
import { kurtosis, mean, seededRng, skewness } from "../stats.js";
import { deflatedSharpe } from "./metrics.js";
import { auditPrefixInvariance, buildDefaultFeatureRows, causalViolations, defaultFeatureSetSpec, EXTRA_FEATURE_DEFINITIONS, featureSetSpecHash, validateResearchBars, type CausalFeatureRow, type FeatureSetSpec } from "./feature-set.js";
import { FEATURE_DEFINITIONS, horizonsFor } from "./features.js";
import { buildTradeLabels, costPerSideFraction, labelSpecHash, labelValue, LABELS_VERSION, netOfCost, type LabelSpec } from "./labels.js";
import { calibration, fitBoostedStumps, fitLogistic, predict, psi, type ModelArtefact } from "./ml.js";
import { aucScore, blockBootstrapInterval, innerCalibrationSplit, purgedWalkForwardSplits, topFractionPrecision, tradeSharpe, tradeSortino, type BootstrapInterval, type WalkForwardScheme } from "./ml2-eval.js";
import { applyCalibrator, fitIsotonicCalibrator, fitPlattCalibrator, fitPreprocessor, fitRandomForest, predictForest, transformRow, type Calibrator, type ForestArtefact, type Preprocessor } from "./ml2-learners.js";
import { inferBarMs, regimeConfigFor, type MarketCalendar } from "./regime.js";
import { isContiguous, regimeCalendarFor, toSessionCalendar, type SessionCalendar } from "./sessions.js";
import type { ResearchBar } from "./simulate.js";

/**
 * GENESIS Phase 4: ML Engine 2.0 (`ml-wf-2.0.0`). Research only. Nothing here is imported by admission,
 * sizing, risk or execution, and no verdict promotes, applies or trades anything. The v1 protocol
 * (`ml-wf-1.0.0`, `evaluateModels` in ml.ts) is unchanged and still available.
 *
 * Pipeline (deterministic for a given seed):
 *  1. Refuse invalid bars (duplicates, disorder, off-grid, bad OHLC, bars not yet closed at `asOf`).
 *  2. Executable labels (labels.ts): next-open entry, stop/target/horizon exit, costs both sides.
 *  3. Versioned, hashed feature set; refuse any value available after the decision time and any feature
 *     that changes when later bars are removed (prefix audit); coverage floor after warm-up.
 *  4. Last `holdoutFraction` reserved. Purged + embargoed walk-forward (expanding or rolling) on the rest;
 *     embargo = max(horizon, look-back). Per fold, the imputer/standardiser and every model are fitted on an
 *     inner fit split, the calibrator (Platt or isotonic) on a later inner split; test rows are never seen.
 *  5. Learners: base rate, L2 logistic, boosted stumps (v1 baselines) and a seeded random forest challenger.
 *  6. Out-of-sample metrics on the concatenated test folds, with stationary/moving block-bootstrap CIs
 *     (block ≥ horizon), cost sensitivity at 1×/2×/3×, and controls: base rate, always-enter, buy-and-hold,
 *     cash, and a random-selection control with the same selection frequency and clustering.
 *     Known limitation: the walk-forward bootstrap resamples the concatenated test folds as one series, so a
 *     block may straddle a fold boundary and join predictions from two differently fitted models. This mixes
 *     model vintages inside a block; it does not leak labels.
 *  7. Every configuration is a trial (failures included); the champion's Sharpe is deflated by the
 *     programme-wide trial count.
 *  8. Only if walk-forward passes, and only through a `HoldoutGate` that allows one consumption per key, is
 *     the holdout evaluated, exactly once.
 */

export const ML2_PROTOCOL_VERSION = "ml-wf-2.0.0";

export type Ml2Target = "NET_POSITIVE" | "TARGET_BEFORE_STOP";
export type LearnerFamily = "BASE_RATE" | "LOGISTIC_L2" | "BOOSTED_STUMPS" | "RANDOM_FOREST";
export type LearnerConfig = { family: LearnerFamily; params?: Record<string, number> };

export const DEFAULT_LEARNERS: LearnerConfig[] = [
  { family: "BASE_RATE" },
  { family: "LOGISTIC_L2", params: { lambda: 0.01, iterations: 300, rate: 0.2 } },
  { family: "BOOSTED_STUMPS", params: { rounds: 40, rate: 0.1, candidates: 9 } },
  { family: "RANDOM_FOREST", params: { trees: 30, maxDepth: 3, minLeaf: 40, sampleFraction: 0.5, thresholds: 9 } },
];

export type Ml2Verdict = "NO_SKILL" | "INSUFFICIENT_EVIDENCE" | "SKILL_NOT_ECONOMIC" | "REJECTED_OVERFIT" | "REJECTED_COSTS" | "CANDIDATE";

export type Ml2Config = {
  scheme: WalkForwardScheme;
  folds: number;
  /** ROLLING only: training rows kept per fold (null = one segment). */
  rollingTrainRows: number | null;
  holdoutFraction: number;
  /** null = max(horizon, feature look-back) bars. */
  embargoBars: number | null;
  calibration: "PLATT" | "ISOTONIC" | "NONE";
  /** Share of each fold's training rows (the latest) reserved for fitting the calibrator. */
  calFraction: number;
  /** Pre-declared entry threshold on calibrated P(positive). */
  entryThreshold: number;
  topFraction: number;
  /** A test row whose standardised feature exceeds this |z| abstains (out of training distribution). */
  maxAbsZ: number;
  minFitRows: number;
  /** Test rows / horizon below this: INSUFFICIENT_EVIDENCE. */
  minEffectiveTestLabels: number;
  /** Signals / horizon below this: INSUFFICIENT_EVIDENCE. */
  minEffectiveSignals: number;
  maxEce: number;
  /** Family-wise confidence for skill CIs (Bonferroni over learned models is applied on top). */
  confidence: number;
  bootstrapScheme: "MOVING" | "STATIONARY";
  bootstrapResamples: number;
  /** null = max(horizon, ⌈n^(1/3)⌉). Never below the horizon. */
  blockLength: number | null;
  randomControls: number;
  costMultipliers: number[];
  minDsr: number;
  maxPsi: number;
  brierWindow: number;
  maxBrierDecay: number;
  maxStalenessMs: number;
  prefixProbes: number;
  seed: number;
};

export const DEFAULT_ML2_CONFIG: Ml2Config = {
  scheme: "EXPANDING",
  folds: 4,
  rollingTrainRows: null,
  holdoutFraction: 0.2,
  embargoBars: null,
  calibration: "PLATT",
  calFraction: 0.25,
  entryThreshold: 0.55,
  topFraction: 0.1,
  maxAbsZ: 6,
  minFitRows: 200,
  minEffectiveTestLabels: 100,
  minEffectiveSignals: 30,
  maxEce: 0.05,
  confidence: 0.95,
  bootstrapScheme: "STATIONARY",
  bootstrapResamples: 400,
  blockLength: null,
  randomControls: 200,
  costMultipliers: [1, 2, 3],
  minDsr: 0.95,
  maxPsi: 0.25,
  brierWindow: 250,
  maxBrierDecay: 0.02,
  maxStalenessMs: 30 * 86_400_000,
  prefixProbes: 12,
  seed: 1,
};

/** Records holdout consumption. `consume` returns false when `key` was already consumed (the caller persists it). */
export type HoldoutGate = { consume(key: string): boolean };

export function createMemoryHoldoutGate(consumed: Iterable<string> = []): HoldoutGate & { consumed: Set<string> } {
  const set = new Set(consumed);
  return {
    consumed: set,
    consume(key: string) {
      if (set.has(key)) return false;
      set.add(key);
      return true;
    },
  };
}

export type Ml2Artefact = {
  protocol: string;
  family: LearnerFamily;
  featureSetHash: string;
  features: string[];
  preprocessor: Preprocessor;
  model: { family: "BASE_RATE"; p: number } | { family: "V1"; artefact: ModelArtefact } | { family: "RANDOM_FOREST"; forest: ForestArtefact };
  calibrator: Calibrator;
  /** Last bar read by any training label, and its close time: the training cutoff. */
  trainedThroughIndex: number;
  trainedThroughTime: number;
};

export function ml2ArtefactHash(a: Ml2Artefact): string {
  return createHash("sha256").update(JSON.stringify(a)).digest("hex");
}

/** Calibrated probability for raw (unstandardised, NaN = missing) features in the artefact's order. */
export function predictMl2(a: Ml2Artefact, x: readonly number[]): number {
  return applyCalibrator(a.calibrator, rawScore(a.model, transformRow(a.preprocessor, x)));
}

/**
 * Abstention for a fitted artefact at decision time `asOf`: stale training cutoff, any feature PSI above
 * `maxPsi`, Brier decay above `maxBrierDecay`, or (per row) a standardised feature beyond `maxAbsZ`.
 */
export function ml2Abstention(input: { artefact: Ml2Artefact; asOf: number; maxStalenessMs: number; drift?: Array<{ feature: string; psi: number | null }>; maxPsi?: number; brierDecay?: number | null; maxBrierDecay?: number; x?: readonly number[]; maxAbsZ?: number }): { abstain: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const age = input.asOf - input.artefact.trainedThroughTime;
  if (age > input.maxStalenessMs) reasons.push(`STALE: training cutoff ${new Date(input.artefact.trainedThroughTime).toISOString()} is ${(age / 86_400_000).toFixed(1)} days before asOf (max ${(input.maxStalenessMs / 86_400_000).toFixed(1)})`);
  const drifted = (input.drift ?? []).filter((d) => d.psi !== null && d.psi > (input.maxPsi ?? Number.POSITIVE_INFINITY));
  if (drifted.length) reasons.push(`DRIFT: PSI above ${input.maxPsi} on ${drifted.map((d) => `${d.feature} ${d.psi!.toFixed(3)}`).join(", ")}`);
  if (input.brierDecay != null && input.maxBrierDecay !== undefined && input.brierDecay > input.maxBrierDecay) reasons.push(`BRIER_DECAY: rolling Brier rose by ${input.brierDecay.toFixed(4)} (> ${input.maxBrierDecay})`);
  if (input.x && input.maxAbsZ !== undefined) {
    const z = transformRow(input.artefact.preprocessor, input.x);
    if (z.some((v) => Math.abs(v) > input.maxAbsZ!)) reasons.push(`OUT_OF_DISTRIBUTION: |z| > ${input.maxAbsZ}`);
  }
  return { abstain: reasons.length > 0, reasons };
}

type LearnerModel = Ml2Artefact["model"];

function rawScore(m: LearnerModel, z: readonly number[]): number {
  if (m.family === "BASE_RATE") return m.p;
  if (m.family === "V1") return predict(m.artefact, [...z]);
  return predictForest(m.forest, z);
}

function fitLearner(cfg: LearnerConfig, Z: number[][], y: number[], features: string[], seed: number): LearnerModel {
  const p = cfg.params ?? {};
  switch (cfg.family) {
    case "BASE_RATE":
      return { family: "BASE_RATE", p: mean(y) ?? 0.5 };
    case "LOGISTIC_L2":
      return { family: "V1", artefact: fitLogistic(Z, y, features, p.lambda ?? 0.01, p.iterations ?? 300, p.rate ?? 0.2) };
    case "BOOSTED_STUMPS":
      return { family: "V1", artefact: fitBoostedStumps(Z, y, features, p.rounds ?? 40, p.rate ?? 0.1, p.candidates ?? 9) };
    case "RANDOM_FOREST":
      return { family: "RANDOM_FOREST", forest: fitRandomForest(Z, y, { ...p, seed: (p.seed ?? 7) + seed }) };
  }
}

/** Bars of history a feature reads (for the embargo). Regime features use the regime trend window. */
export function featureLookbackBars(name: string, barMs: number): number {
  const h = horizonsFor(barMs);
  const def = [...FEATURE_DEFINITIONS, ...EXTRA_FEATURE_DEFINITIONS].find((d) => d.name === name);
  if (!def) return h.l;
  if (name === "breakout_persist_s" || name === "absret_autocorr_m") return h.m + h.s + 1;
  if (name === "drawdown_l") return h.l + 1;
  switch (def.lookback) {
    case "s":
      return h.s;
    case "m":
      return h.m;
    case "l":
      return h.l;
    case "regime":
      return regimeConfigFor(barMs).trendWindow;
    default:
      return 0;
  }
}

export type Ml2TrialRecord = {
  trialId: string;
  family: LearnerFamily;
  params: Record<string, number>;
  baseline: boolean;
  status: "OK" | "FAILED";
  error: string | null;
  /** Walk-forward summary (null on failure). */
  brier: number | null;
  brierSkill: number | null;
  auc: number | null;
  ece: number | null;
  signals: number;
  expectancy1x: number | null;
  /** Per-trade Sharpe of selected trades at 1× costs (feeds the DSR). */
  sharpe: number | null;
  /** Mean in-sample (inner fit) AUC across folds: a diagnostic of overfitting, never a pass criterion. */
  trainAuc: number | null;
};

export type ExpectancyRow = { costMultiplier: number; mean: number | null; ci: BootstrapInterval | null; alwaysEnter: number | null; buyAndHoldPerHorizon: number | null };

export type Ml2Evaluation = {
  rows: number;
  brier: number;
  logLoss: number;
  ece: number;
  auc: number | null;
  aucCi: BootstrapInterval | null;
  brierSkill: number | null;
  precisionTop: number | null;
  precisionAtThreshold: number | null;
  signals: number;
  abstainedOod: number;
  selectionFrequency: number;
  expectancy: ExpectancyRow[];
  sharpe: number | null;
  sortino: number | null;
  /** Buy-and-hold over the evaluated span (one round trip at 1× costs). */
  buyAndHold: { net: number | null; bars: number };
  cash: 0;
  randomControl: { draws: number; mean: number | null; p95: number | null; pValue: number | null };
};

export type Ml2FoldSummary = {
  fold: number;
  trainRows: number;
  fitRows: number;
  calRows: number;
  purged: number;
  embargoed: number;
  innerPurged: number;
  testRows: number;
  testStartIndex: number;
  testEndIndex: number;
  lastFitEndIndex: number | null;
  firstFitIndex: number | null;
  preprocessor: Preprocessor | null;
  artefactHashes: Record<string, string>;
  skipped: string | null;
};

export type Ml2HoldoutResult =
  | { evaluated: false; reason: string }
  | { evaluated: true; key: string; evaluations: 1; rows: number; champion: Ml2Evaluation; baseRate: { brier: number } };

export type Ml2Report = {
  protocol: string;
  labelsVersion: string;
  target: Ml2Target;
  labelSpec: LabelSpec;
  labelSpecHash: string;
  featureSet: { spec: FeatureSetSpec; hash: string };
  barMs: number;
  calendar: SessionCalendar;
  config: Ml2Config;
  data: { bars: number; labelled: number; warmupDropped: number; droppedMissing: number; usable: number; preHoldout: number; purgedBeforeHoldout: number; holdoutRows: number; embargoBars: number; lookbackBars: number; blockLength: number | null };
  /** Open times of the first and last decision bars in the reserved holdout (null when there are no holdout rows). Identifies the period for holdout accounting; no holdout label or return is read to compute it. */
  holdoutSpan: { firstT: number | null; lastT: number | null };
  coverage: Array<{ feature: string; missingShare: number; ok: boolean }>;
  causality: { availabilityViolations: number; prefixProbes: number[]; prefixViolations: number };
  folds: Ml2FoldSummary[];
  trials: Ml2TrialRecord[];
  trialCount: number;
  programmeTrialCount: number;
  championTrialId: string | null;
  walkForward: Record<string, Ml2Evaluation>;
  dsr: { dsr: number | null; benchmark: number; trials: number; effectiveN: number } | null;
  holdout: Ml2HoldoutResult;
  drift: { psi: Array<{ feature: string; psi: number | null }>; rollingBrier: number[]; brierDecay: number | null };
  deployment: { abstain: boolean; reasons: string[] } | null;
  artefacts: Array<{ family: LearnerFamily; trialId: string; hash: string; bytes: number }>;
  finalArtefacts: Record<string, Ml2Artefact>;
  verdict: Ml2Verdict;
  reasons: string[];
};

export type Ml2Input = {
  bars: readonly ResearchBar[];
  barMs?: number;
  /**
   * Session calendar for bar alignment, label gaps and the regime engine. CRYPTO_24_7 (default; legacy
   * "CONTINUOUS") uses one UTC grid; US_EQUITY (legacy "WEEKDAYS") uses NYSE sessions in New York time.
   */
  calendar?: SessionCalendar | MarketCalendar;
  /** When each bar became available (aligned with `bars`, e.g. the warehouse `availableAt`). A feature row is never available before the bars it reads. */
  barAvailableAt?: ReadonlyArray<number | null>;
  labelSpec: LabelSpec;
  target?: Ml2Target;
  featureSet?: FeatureSetSpec;
  /** Feature builder; must be point-in-time. Audited for prefix invariance. Default: base + extra OHLCV features. */
  featureBuilder?: (bars: readonly ResearchBar[]) => readonly CausalFeatureRow[];
  learners?: LearnerConfig[];
  config?: Partial<Ml2Config>;
  /** Present only when the caller can record the holdout consumption. Evaluated only if walk-forward passes. */
  holdout?: { gate: HoldoutGate; key: string };
  /** Trials already run across the programme (before this run), for the DSR. */
  priorTrialCount?: number;
  /** Decision time for staleness and bar-closure checks (default: close of the last bar). */
  asOf?: number;
};

type Row = { index: number; endIndex: number; t: number; x: number[]; y: number; gross: number };

type Scored = { p: number[]; y: number[]; gross: number[]; ood: boolean[]; rowIdx: number[] };

function trialIdFor(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Refusal of invalid input: thrown, never reported as a result. */
export class Ml2Refusal extends Error {
  constructor(message: string) {
    super(`REFUSED: ${message}`);
    this.name = "Ml2Refusal";
  }
}

function evaluateScored(s: Scored, cfg: Ml2Config, ctx: { horizon: number; costPerSide: number; blockLength: number; baseP: number[] | null; bars: readonly ResearchBar[]; confidence: number; seed: number }): Ml2Evaluation {
  const cal = calibration(s.p, s.y);
  const n = s.p.length;
  const sel = s.p.map((p, i) => p >= cfg.entryThreshold && !s.ood[i]);
  const signals = sel.filter(Boolean).length;
  const abstainedOod = s.p.filter((p, i) => p >= cfg.entryThreshold && s.ood[i]).length;
  const boot = (stat: (pos: number[]) => number | null, salt: number) => blockBootstrapInterval(n, stat, { blockLength: ctx.blockLength, minBlockLength: ctx.horizon, resamples: cfg.bootstrapResamples, scheme: cfg.bootstrapScheme, seed: ctx.seed + salt, confidence: ctx.confidence });
  const aucCi = boot((pos) => aucScore(pos.map((i) => s.p[i]!), pos.map((i) => s.y[i]!)), 11);
  const baseBrier = ctx.baseP ? ctx.baseP.reduce((acc, p, i) => acc + (p - s.y[i]!) ** 2, 0) / Math.max(1, n) : null;
  const brierSkill = baseBrier && baseBrier > 0 ? 1 - cal.brier / baseBrier : null;
  // Buy-and-hold over the span: entry at the first row's next open, exit at the last row's horizon close.
  const first = s.rowIdx[0];
  const last = s.rowIdx.at(-1);
  let bh: { gross: number | null; bars: number } = { gross: null, bars: 0 };
  if (first !== undefined && last !== undefined && first + 1 < ctx.bars.length) {
    const exitIdx = Math.min(ctx.bars.length - 1, last + ctx.horizon);
    bh = { gross: ctx.bars[exitIdx]!.close / ctx.bars[first + 1]!.open - 1, bars: exitIdx - first };
  }
  const expectancy: ExpectancyRow[] = cfg.costMultipliers.map((m, k) => {
    const net = s.gross.map((g) => netOfCost(g, ctx.costPerSide * m));
    const stat = (pos: number[]) => {
      let sum = 0;
      let c = 0;
      for (const i of pos) if (sel[i]) {
        sum += net[i]!;
        c += 1;
      }
      return c >= 2 ? sum / c : null;
    };
    const chosen = net.filter((_, i) => sel[i]);
    const bhNet = bh.gross === null ? null : netOfCost(bh.gross, ctx.costPerSide * m);
    return {
      costMultiplier: m,
      mean: mean(chosen),
      ci: signals >= 2 ? boot(stat, 101 + k) : null,
      alwaysEnter: mean(net),
      buyAndHoldPerHorizon: bhNet === null || bh.bars <= 0 || bhNet <= -1 ? null : (1 + bhNet) ** (ctx.horizon / bh.bars) - 1,
    };
  });
  const net1 = s.gross.map((g) => netOfCost(g, ctx.costPerSide));
  const chosen1 = net1.filter((_, i) => sel[i]);
  // Random-selection control: the same signal mask circularly shifted (same frequency and clustering).
  const rng = seededRng(ctx.seed + 7919);
  const ctrl: number[] = [];
  if (signals > 0 && n > 2 * ctx.horizon + 1) {
    for (let r = 0; r < cfg.randomControls; r += 1) {
      const off = ctx.horizon + Math.floor(rng() * (n - 2 * ctx.horizon));
      let sum = 0;
      let c = 0;
      for (let i = 0; i < n; i += 1) if (sel[(i + off) % n]) {
        sum += net1[i]!;
        c += 1;
      }
      if (c) ctrl.push(sum / c);
    }
  }
  const model1 = mean(chosen1);
  const sortedCtrl = [...ctrl].sort((a, b) => a - b);
  return {
    rows: n,
    brier: cal.brier,
    logLoss: cal.logLoss,
    ece: cal.ece,
    auc: cal.auc,
    aucCi,
    brierSkill,
    precisionTop: topFractionPrecision(s.p, s.y, cfg.topFraction),
    precisionAtThreshold: signals ? s.y.filter((_, i) => sel[i]).reduce((a, b) => a + b, 0) / signals : null,
    signals,
    abstainedOod,
    selectionFrequency: n ? signals / n : 0,
    expectancy,
    sharpe: tradeSharpe(chosen1),
    sortino: tradeSortino(chosen1),
    buyAndHold: { net: bh.gross === null ? null : netOfCost(bh.gross, ctx.costPerSide), bars: bh.bars },
    cash: 0,
    randomControl: {
      draws: ctrl.length,
      mean: mean(ctrl),
      p95: sortedCtrl.length ? sortedCtrl[Math.min(sortedCtrl.length - 1, Math.floor(0.95 * sortedCtrl.length))]! : null,
      pValue: ctrl.length && model1 !== null ? (1 + ctrl.filter((c) => c >= model1).length) / (ctrl.length + 1) : null,
    },
  };
}

/** Builds the model-ready dataset (exported for tests and audits). Throws `Ml2Refusal` on integrity failures. */
export function buildMl2Dataset(input: Ml2Input) {
  const bars = input.bars;
  const barMs = input.barMs ?? inferBarMs(bars);
  const target = input.target ?? "NET_POSITIVE";
  const asOf = input.asOf ?? (bars.length ? bars.at(-1)!.t + barMs : 0);
  const calendar = toSessionCalendar(input.calendar);
  if (input.barAvailableAt && input.barAvailableAt.length !== bars.length) throw new Ml2Refusal("barAvailableAt must align with bars");
  const issues = validateResearchBars(bars, { barMs, asOf, calendar, availableAt: input.barAvailableAt });
  if (issues.length) {
    const hint = calendar === "CRYPTO_24_7" && issues.some((i) => i.code === "MISALIGNED") ? " (equity bars open at New York midnight: use the US_EQUITY calendar)" : "";
    throw new Ml2Refusal(`${issues.length} bar integrity issue(s) under the ${calendar} calendar; first: ${issues.slice(0, 3).map((i) => `#${i.index} ${i.code} ${i.detail}`).join("; ")}${hint}`);
  }
  if (target === "TARGET_BEFORE_STOP" && (input.labelSpec.stopPct == null || input.labelSpec.targetPct == null)) throw new Ml2Refusal("TARGET_BEFORE_STOP needs both stopPct and targetPct");
  // A source that reports no volume at all (OANDA FX/metals: tick volume is not traded volume) cannot feed the volume
  // features; the default set then omits them (a distinct, hashed spec) instead of dropping every row.
  const spec = input.featureSet ?? defaultFeatureSetSpec(barMs, { volume: bars.some((b) => b.volume !== null) });
  const builder = input.featureBuilder ?? ((b: readonly ResearchBar[]) => buildDefaultFeatureRows(b, { barMs, calendar: regimeCalendarFor(calendar), sessionCalendar: calendar }));
  // A row reading bars[0..i] is available no earlier than the latest availability among those bars.
  const latestAvailable: number[] = [];
  if (input.barAvailableAt) {
    let m = Number.NEGATIVE_INFINITY;
    for (const a of input.barAvailableAt) latestAvailable.push((m = Math.max(m, a ?? Number.NEGATIVE_INFINITY)));
  }
  const featureRows = builder(bars).map((r) => (input.barAvailableAt && latestAvailable[r.index]! > r.availableAt ? { ...r, availableAt: latestAvailable[r.index]! } : r));
  const unknown = spec.features.filter((f) => !featureRows.some((r) => f in r.values));
  if (unknown.length) throw new Ml2Refusal(`feature(s) not produced by the builder: ${unknown.join(", ")}`);
  const violations = causalViolations(featureRows, spec.features, (r) => bars[r.index]!.t + barMs);
  if (violations.length) {
    const v = violations[0]!;
    throw new Ml2Refusal(`${violations.length} feature value(s) available after the decision time; first: ${v.feature} at bar ${v.index} available ${new Date(v.availableAt).toISOString()} > decision ${new Date(v.decisionTime).toISOString()}`);
  }
  const labels = buildTradeLabels(bars, input.labelSpec, { barMs, isContiguous: (a, b) => isContiguous(a.t, b.t, barMs, calendar) });
  const lookbackBars = Math.max(0, ...spec.features.map((f) => featureLookbackBars(f, barMs)));
  // Prefix audit at deterministic probes spread evenly over the whole usable series: from the first bar with a
  // full look-back to the second-to-last bar (the last bar's prefix is the full series, so it proves nothing).
  const probeCount = Math.max(0, Math.floor(input.config?.prefixProbes ?? DEFAULT_ML2_CONFIG.prefixProbes));
  const lo = Math.min(Math.max(0, bars.length - 2), lookbackBars);
  const hi = Math.max(lo, bars.length - 2);
  const probes = [...new Set(Array.from({ length: probeCount }, (_, k) => (probeCount === 1 ? hi : Math.round(lo + ((hi - lo) * k) / (probeCount - 1)))))];
  const audit = auditPrefixInvariance(bars, builder, spec.features, probes, featureRows);
  if (audit.violations.length) {
    const v = audit.violations[0]!;
    throw new Ml2Refusal(`feature ${v.feature} changes when later bars are removed (bar ${v.index}: full ${v.full} vs prefix ${v.prefix}): look-ahead`);
  }
  const labelled: Row[] = [];
  for (const fr of featureRows) {
    const l = labels[fr.index];
    if (!l) continue;
    const yv = labelValue(l, target);
    if (yv === null) continue;
    labelled.push({ index: fr.index, endIndex: l.endIndex, t: bars[fr.index]!.t, x: spec.features.map((f) => fr.values[f] ?? Number.NaN).map((v) => (v === null || !Number.isFinite(v) ? Number.NaN : v)), y: yv, gross: l.grossReturn });
  }
  labelled.sort((a, b) => a.index - b.index);
  // Warm-up: rows before every feature has been observed at least once are structural, not missing data. A feature
  // that is never observed does not extend the warm-up (it used to consume every row, so all features reported 100%
  // missing); it is reported on its own as 100% missing and fails coverage.
  const everSeen = spec.features.map((_, j) => labelled.some((r) => Number.isFinite(r.x[j]!)));
  const seen = spec.features.map(() => false);
  let warm = 0;
  for (; warm < labelled.length; warm += 1) {
    labelled[warm]!.x.forEach((v, j) => {
      if (Number.isFinite(v)) seen[j] = true;
    });
    if (seen.every((s, j) => s || !everSeen[j])) break;
  }
  const post = labelled.slice(warm);
  const coverage = spec.features.map((feature, j) => {
    const missingShare = post.length ? post.filter((r) => !Number.isFinite(r.x[j]!)).length / post.length : 1;
    return { feature, missingShare, ok: missingShare <= spec.maxMissingShare };
  });
  const rows = spec.nullPolicy === "DROP_ROW" ? post.filter((r) => r.x.every((v) => Number.isFinite(v))) : post;
  return { bars, barMs, calendar, target, asOf, spec, specHash: featureSetSpecHash(spec), labels, rows, coverage, warmupDropped: labelled.length - post.length, droppedMissing: post.length - rows.length, labelledCount: labelled.length, lookbackBars, probes, availabilityViolations: violations.length };
}

/** Runs the full GENESIS Phase 4 protocol for one target/horizon and a list of learner configurations. */
export function runMlPipeline(input: Ml2Input): Ml2Report {
  const cfg: Ml2Config = { ...DEFAULT_ML2_CONFIG, ...(input.config ?? {}) };
  const ds = buildMl2Dataset(input);
  const { bars, barMs, spec, specHash, rows } = ds;
  const horizon = input.labelSpec.horizon;
  const costPerSide = costPerSideFraction(input.labelSpec);
  const embargoBars = cfg.embargoBars ?? Math.max(horizon, ds.lookbackBars);
  const learners = input.learners ?? DEFAULT_LEARNERS;
  if (!learners.some((l) => l.family === "BASE_RATE")) throw new Ml2Refusal("learners must include BASE_RATE (the comparison baseline)");
  const lsHash = labelSpecHash(input.labelSpec);
  const reasons: string[] = [];

  const holdoutStart = Math.floor(rows.length * (1 - cfg.holdoutFraction));
  const holdoutRows = rows.slice(holdoutStart);
  const firstHoldoutBar = holdoutRows[0]?.index ?? Number.POSITIVE_INFINITY;
  const preAll = rows.slice(0, holdoutStart);
  const pre = preAll.filter((r) => r.endIndex < firstHoldoutBar);
  const segment = Math.floor(pre.length / (cfg.folds + 1));
  const effectiveTest = (pre.length - segment) / Math.max(1, horizon);
  const blockLength = cfg.blockLength ?? Math.max(horizon, Math.ceil(Math.cbrt(Math.max(1, pre.length - segment))));
  if (blockLength < horizon) throw new Ml2Refusal(`block length ${blockLength} < horizon ${horizon}`);

  const trialMeta = learners.map((l) => ({ l, trialId: trialIdFor({ protocol: ML2_PROTOCOL_VERSION, family: l.family, params: l.params ?? {}, target: ds.target, labelSpec: lsHash, featureSet: specHash, calibration: cfg.calibration, scheme: cfg.scheme, folds: cfg.folds, seed: cfg.seed }) }));

  const base: Omit<Ml2Report, "folds" | "trials" | "trialCount" | "programmeTrialCount" | "championTrialId" | "walkForward" | "dsr" | "holdout" | "drift" | "deployment" | "artefacts" | "finalArtefacts" | "verdict" | "reasons"> = {
    protocol: ML2_PROTOCOL_VERSION,
    labelsVersion: LABELS_VERSION,
    target: ds.target,
    labelSpec: input.labelSpec,
    labelSpecHash: lsHash,
    featureSet: { spec, hash: specHash },
    barMs,
    calendar: ds.calendar,
    config: cfg,
    data: { bars: bars.length, labelled: ds.labelledCount, warmupDropped: ds.warmupDropped, droppedMissing: ds.droppedMissing, usable: rows.length, preHoldout: pre.length, purgedBeforeHoldout: preAll.length - pre.length, holdoutRows: holdoutRows.length, embargoBars, lookbackBars: ds.lookbackBars, blockLength },
    holdoutSpan: { firstT: holdoutRows.length ? bars[holdoutRows[0]!.index]!.t : null, lastT: holdoutRows.length ? bars[holdoutRows.at(-1)!.index]!.t : null },
    coverage: ds.coverage,
    causality: { availabilityViolations: ds.availabilityViolations, prefixProbes: ds.probes, prefixViolations: 0 },
  };
  const emptyTrials = (error: string): Ml2TrialRecord[] => trialMeta.map(({ l, trialId }) => ({ trialId, family: l.family, params: l.params ?? {}, baseline: l.family === "BASE_RATE", status: "FAILED", error, brier: null, brierSkill: null, auc: null, ece: null, signals: 0, expectancy1x: null, sharpe: null, trainAuc: null }));
  const insufficient = (why: string): Ml2Report => {
    const trials = emptyTrials(why);
    return { ...base, folds: [], trials, trialCount: trials.length, programmeTrialCount: (input.priorTrialCount ?? 0) + trials.length, championTrialId: null, walkForward: {}, dsr: null, holdout: { evaluated: false, reason: "walk-forward did not run" }, drift: { psi: [], rollingBrier: [], brierDecay: null }, deployment: null, artefacts: [], finalArtefacts: {}, verdict: "INSUFFICIENT_EVIDENCE", reasons: [why] };
  };
  const failedCoverage = ds.coverage.filter((c) => !c.ok);
  if (failedCoverage.length) return insufficient(`coverage: ${failedCoverage.map((c) => `${c.feature} missing on ${(c.missingShare * 100).toFixed(1)}%`).join(", ")} (max ${(spec.maxMissingShare * 100).toFixed(1)}%)`);
  if (segment < cfg.minFitRows || effectiveTest < cfg.minEffectiveTestLabels) return insufficient(`${pre.length} pre-holdout rows at a ${horizon}-bar horizon give ≈${effectiveTest.toFixed(0)} independent test labels (< ${cfg.minEffectiveTestLabels}) or segments of ${segment} rows (< ${cfg.minFitRows})`);

  const splits = purgedWalkForwardSplits(pre, { scheme: cfg.scheme, folds: cfg.folds, embargoBars, rollingTrainRows: cfg.rollingTrainRows ?? segment });
  const scored: Record<string, Scored> = Object.fromEntries(trialMeta.map((t) => [t.trialId, { p: [], y: [], gross: [], ood: [], rowIdx: [] }]));
  const failures = new Map<string, string>();
  const trainAucs = new Map<string, number[]>();
  const folds: Ml2FoldSummary[] = [];

  const fitAll = (trainPos: number[], source: Row[], seedSalt: number) => {
    const inner = innerCalibrationSplit(source, trainPos, cfg.calibration === "NONE" ? 0 : cfg.calFraction);
    const fitRows = inner.fit.map((p) => source[p]!);
    const calRows = inner.cal.map((p) => source[p]!);
    const pre0 = fitPreprocessor(fitRows.map((r) => r.x), spec.nullPolicy);
    const Zfit = fitRows.map((r) => transformRow(pre0, r.x));
    const yfit = fitRows.map((r) => r.y);
    const lastFit = fitRows.length ? Math.max(...fitRows.map((r) => r.endIndex)) : -1;
    const lastCal = calRows.length ? Math.max(...calRows.map((r) => r.endIndex)) : -1;
    const throughIndex = Math.max(lastFit, lastCal);
    const models = new Map<string, Ml2Artefact | Error>();
    for (const { l, trialId } of trialMeta) {
      if (failures.has(trialId)) continue;
      try {
        const model = fitLearner(l, Zfit, yfit, spec.features, cfg.seed + seedSalt);
        let calibrator: Calibrator = { method: "NONE" };
        if (l.family !== "BASE_RATE" && calRows.length) {
          const raw = calRows.map((r) => rawScore(model, transformRow(pre0, r.x)));
          const yc = calRows.map((r) => r.y);
          calibrator = cfg.calibration === "PLATT" ? fitPlattCalibrator(raw, yc) : cfg.calibration === "ISOTONIC" ? fitIsotonicCalibrator(raw, yc) : { method: "NONE" };
        }
        const art: Ml2Artefact = { protocol: ML2_PROTOCOL_VERSION, family: l.family, featureSetHash: specHash, features: spec.features, preprocessor: pre0, model, calibrator, trainedThroughIndex: throughIndex, trainedThroughTime: throughIndex >= 0 ? bars[throughIndex]!.t + barMs : 0 };
        if (l.family !== "BASE_RATE" && seedSalt < 1000) {
          const a = aucScore(Zfit.map((z) => rawScore(model, z)), yfit);
          if (a !== null) trainAucs.set(trialId, [...(trainAucs.get(trialId) ?? []), a]);
        }
        models.set(trialId, art);
      } catch (error) {
        models.set(trialId, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return { inner, fitRows, calRows, pre0, lastFit, models };
  };

  for (const split of splits) {
    const testRows = split.test.map((p) => pre[p]!);
    const summary: Ml2FoldSummary = { fold: split.fold, trainRows: split.train.length, fitRows: 0, calRows: 0, purged: split.purged, embargoed: split.embargoed, innerPurged: 0, testRows: testRows.length, testStartIndex: split.testStartIndex, testEndIndex: split.testEndIndex, lastFitEndIndex: null, firstFitIndex: null, preprocessor: null, artefactHashes: {}, skipped: null };
    const innerPreview = innerCalibrationSplit(pre, split.train, cfg.calibration === "NONE" ? 0 : cfg.calFraction);
    if (innerPreview.fit.length < cfg.minFitRows) {
      summary.skipped = `${innerPreview.fit.length} inner-fit rows after purging (< ${cfg.minFitRows})`;
      folds.push(summary);
      continue;
    }
    const f = fitAll(split.train, pre, split.fold);
    Object.assign(summary, { fitRows: f.fitRows.length, calRows: f.calRows.length, innerPurged: f.inner.purged, lastFitEndIndex: f.lastFit, firstFitIndex: f.fitRows[0]?.index ?? null, preprocessor: f.pre0 });
    for (const { trialId } of trialMeta) {
      const m = f.models.get(trialId);
      if (!m) continue;
      if (m instanceof Error) {
        failures.set(trialId, m.message);
        continue;
      }
      summary.artefactHashes[trialId] = ml2ArtefactHash(m);
      const s = scored[trialId]!;
      for (const r of testRows) {
        const z = transformRow(f.pre0, r.x);
        s.p.push(applyCalibrator(m.calibrator, rawScore(m.model, z)));
        s.y.push(r.y);
        s.gross.push(r.gross);
        s.ood.push(z.some((v) => Math.abs(v) > cfg.maxAbsZ));
        s.rowIdx.push(r.index);
      }
    }
    folds.push(summary);
  }

  const baseTrial = trialMeta.find((t) => t.l.family === "BASE_RATE")!;
  const learned = trialMeta.filter((t) => t.l.family !== "BASE_RATE");
  const confidence = 1 - (1 - cfg.confidence) / Math.max(1, learned.length);
  const walkForward: Record<string, Ml2Evaluation> = {};
  const baseScored = scored[baseTrial.trialId]!;
  const evalCtx = { horizon, costPerSide, blockLength, bars, confidence, seed: cfg.seed };
  for (const { trialId } of trialMeta) {
    const s = scored[trialId]!;
    if (failures.has(trialId) || !s.p.length) continue;
    walkForward[trialId] = evaluateScored(s, cfg, { ...evalCtx, baseP: baseScored.p.length === s.p.length ? baseScored.p : null });
  }
  const trials: Ml2TrialRecord[] = trialMeta.map(({ l, trialId }) => {
    const e = walkForward[trialId];
    const ta = trainAucs.get(trialId);
    const err = failures.get(trialId) ?? (e ? null : "no fold produced test predictions");
    return { trialId, family: l.family, params: l.params ?? {}, baseline: l.family === "BASE_RATE", status: err ? "FAILED" : "OK", error: err, brier: e?.brier ?? null, brierSkill: e?.brierSkill ?? null, auc: e?.auc ?? null, ece: e?.ece ?? null, signals: e?.signals ?? 0, expectancy1x: e?.expectancy[0]?.mean ?? null, sharpe: e?.sharpe ?? null, trainAuc: ta?.length ? ta.reduce((a, b) => a + b, 0) / ta.length : null };
  });
  const programmeTrialCount = (input.priorTrialCount ?? 0) + trials.length;
  const okLearned = trials.filter((t) => !t.baseline && t.status === "OK");
  const champion = okLearned.length ? okLearned.reduce((b, t) => (t.brier! < b.brier! ? t : b)) : null;

  // Final models on every pre-holdout row (never the holdout): artefacts, drift and the holdout test.
  const finalFit = fitAll(Array.from({ length: pre.length }, (_, i) => i), pre, 1000);
  const finalArtefacts: Record<string, Ml2Artefact> = {};
  const artefacts: Ml2Report["artefacts"] = [];
  for (const { l, trialId } of trialMeta) {
    const m = finalFit.models.get(trialId);
    if (!m || m instanceof Error) continue;
    finalArtefacts[trialId] = m;
    artefacts.push({ family: l.family, trialId, hash: ml2ArtefactHash(m), bytes: Buffer.byteLength(JSON.stringify(m)) });
  }

  // DSR on the champion's selected-trade Sharpe, deflated by every trial in the programme.
  let dsr: Ml2Report["dsr"] = null;
  const champEval = champion ? walkForward[champion.trialId] : undefined;
  if (champion && champEval && champEval.sharpe !== null) {
    const s = scored[champion.trialId]!;
    const chosen = s.p.map((p, i) => (p >= cfg.entryThreshold && !s.ood[i] ? netOfCost(s.gross[i]!, costPerSide) : null)).filter((v): v is number => v !== null);
    const effectiveN = Math.floor(chosen.length / Math.max(1, horizon));
    const d = deflatedSharpe({ sharpe: champEval.sharpe, n: effectiveN, skew: skewness(chosen) ?? 0, kurtosis: kurtosis(chosen) ?? 3, trialSharpes: trials.filter((t) => !t.baseline && t.sharpe !== null).map((t) => t.sharpe!), trialCount: programmeTrialCount });
    dsr = { ...d, effectiveN };
  }

  // Walk-forward verdict.
  let verdict: Ml2Verdict | null = null;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(3)}%`);
  if (!champion || !champEval) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(okLearned.length ? "no champion" : `every learned model failed or produced no predictions (${[...failures.values()].join("; ") || "no usable fold"})`);
  } else {
    const ex1 = champEval.expectancy.find((e) => e.costMultiplier === 1);
    const ex2 = champEval.expectancy.find((e) => e.costMultiplier === 2);
    const effSignals = champEval.signals / Math.max(1, horizon);
    if (!(champEval.brierSkill !== null && champEval.brierSkill > 0) || !(champEval.aucCi && champEval.aucCi.lower > 0.5)) {
      verdict = "NO_SKILL";
      reasons.push(`champion ${champion.family}: walk-forward Brier skill vs base rate ${champEval.brierSkill?.toFixed(4) ?? "n/a"}, AUC ${champEval.auc?.toFixed(3) ?? "n/a"} with ${(confidence * 100).toFixed(1)}% block-bootstrap CI lower ${champEval.aucCi?.lower.toFixed(3) ?? "n/a"} (must exceed 0.5)`);
    } else if (effSignals < cfg.minEffectiveSignals) {
      verdict = "INSUFFICIENT_EVIDENCE";
      reasons.push(`${champEval.signals} signals ≈ ${effSignals.toFixed(0)} independent (< ${cfg.minEffectiveSignals})`);
    } else if (ex1 && ex1.ci && ex1.ci.lower > 0 && (ex1.alwaysEnter === null || ex1.buyAndHoldPerHorizon === null)) {
      // A missing baseline is never treated as 0: the comparison cannot be made, so no economic claim is made.
      verdict = "INSUFFICIENT_EVIDENCE";
      reasons.push(`baseline not computable: ${ex1.alwaysEnter === null ? "always-enter" : ""}${ex1.alwaysEnter === null && ex1.buyAndHoldPerHorizon === null ? " and " : ""}${ex1.buyAndHoldPerHorizon === null ? "buy-and-hold per horizon" : ""} unavailable over the walk-forward span, so beating it cannot be shown`);
    } else if (!ex1?.ci || !(ex1.ci.lower > 0) || !(ex1.mean! > ex1.alwaysEnter!) || !(ex1.mean! > ex1.buyAndHoldPerHorizon!) || !(champEval.randomControl.pValue !== null && champEval.randomControl.pValue <= 0.05)) {
      verdict = "SKILL_NOT_ECONOMIC";
      reasons.push(`1× costs: selected mean ${pct(ex1?.mean)} (CI lower ${pct(ex1?.ci?.lower)}) vs always-enter ${pct(ex1?.alwaysEnter)}, buy-and-hold per horizon ${pct(ex1?.buyAndHoldPerHorizon)}, cash 0%, random-selection control p=${champEval.randomControl.pValue?.toFixed(3) ?? "n/a"}`);
    } else if (!ex2?.ci || !(ex2.ci.lower > 0)) {
      verdict = "REJECTED_COSTS";
      reasons.push(`positive at 1× costs but 2× costs CI lower ${pct(ex2?.ci?.lower)} ≤ 0`);
    } else if (champEval.ece > cfg.maxEce) {
      verdict = "INSUFFICIENT_EVIDENCE";
      reasons.push(`not calibrated: walk-forward ECE ${champEval.ece.toFixed(4)} > ${cfg.maxEce}`);
    } else if (!dsr || dsr.dsr === null) {
      verdict = "INSUFFICIENT_EVIDENCE";
      reasons.push(`DSR not computable (effective selected trades ${dsr?.effectiveN ?? 0}; needs ≥ 100)`);
    } else if (dsr.dsr < cfg.minDsr) {
      verdict = "REJECTED_OVERFIT";
      reasons.push(`DSR ${dsr.dsr.toFixed(3)} < ${cfg.minDsr} after ${dsr.trials} programme trials`);
    }
  }

  // Holdout: only after the walk-forward passes, only through the gate, exactly once.
  let holdout: Ml2HoldoutResult = { evaluated: false, reason: verdict ? `walk-forward did not pass (${verdict})` : "" };
  let holdoutScored: Scored | null = null;
  let baseHoldoutP: number[] | null = null;
  if (verdict === null && champion) {
    if (!input.holdout) {
      verdict = "INSUFFICIENT_EVIDENCE";
      holdout = { evaluated: false, reason: "walk-forward passed; holdout withheld (no gate supplied to record its consumption)" };
      reasons.push(holdout.reason);
    } else if (!input.holdout.gate.consume(input.holdout.key)) {
      verdict = "INSUFFICIENT_EVIDENCE";
      holdout = { evaluated: false, reason: `holdout ${input.holdout.key} already consumed; it is evaluated once only` };
      reasons.push(holdout.reason);
    } else {
      const art = finalArtefacts[champion.trialId];
      const baseArt = finalArtefacts[baseTrial.trialId];
      if (!art || !baseArt) {
        verdict = "INSUFFICIENT_EVIDENCE";
        holdout = { evaluated: false, reason: "final model could not be fitted" };
        reasons.push(holdout.reason);
      } else {
        holdoutScored = { p: [], y: [], gross: [], ood: [], rowIdx: [] };
        baseHoldoutP = [];
        for (const r of holdoutRows) {
          const z = transformRow(art.preprocessor, r.x);
          holdoutScored.p.push(applyCalibrator(art.calibrator, rawScore(art.model, z)));
          holdoutScored.y.push(r.y);
          holdoutScored.gross.push(r.gross);
          holdoutScored.ood.push(z.some((v) => Math.abs(v) > cfg.maxAbsZ));
          holdoutScored.rowIdx.push(r.index);
          baseHoldoutP.push(predictMl2(baseArt, r.x));
        }
        const he = evaluateScored(holdoutScored, cfg, { ...evalCtx, seed: cfg.seed + 5003, baseP: baseHoldoutP });
        const baseBrier = baseHoldoutP.reduce((a, p, i) => a + (p - holdoutScored!.y[i]!) ** 2, 0) / Math.max(1, baseHoldoutP.length);
        holdout = { evaluated: true, key: input.holdout.key, evaluations: 1, rows: holdoutRows.length, champion: he, baseRate: { brier: baseBrier } };
        const h1 = he.expectancy.find((e) => e.costMultiplier === 1);
        const h2 = he.expectancy.find((e) => e.costMultiplier === 2);
        if (holdoutRows.length / Math.max(1, horizon) < 30 || he.signals / Math.max(1, horizon) < 10) {
          verdict = "INSUFFICIENT_EVIDENCE";
          reasons.push(`holdout too small: ${holdoutRows.length} rows, ${he.signals} signals at horizon ${horizon}`);
        } else if (!(he.brierSkill !== null && he.brierSkill > 0) || he.ece > cfg.maxEce) {
          verdict = "REJECTED_OVERFIT";
          reasons.push(`walk-forward passed but holdout Brier skill ${he.brierSkill?.toFixed(4) ?? "n/a"}, ECE ${he.ece.toFixed(4)}`);
        } else if (!h2?.ci || !(h2.ci.lower > 0)) {
          verdict = h1?.mean !== null && h1?.mean !== undefined && h1.mean > 0 ? "REJECTED_COSTS" : "REJECTED_OVERFIT";
          reasons.push(`holdout 2× costs: mean ${pct(h2?.mean)}, CI lower ${pct(h2?.ci?.lower)} (must be > 0)`);
        } else if (h1!.alwaysEnter === null || h1!.buyAndHoldPerHorizon === null) {
          verdict = "INSUFFICIENT_EVIDENCE";
          reasons.push(`holdout baseline not computable (always-enter ${pct(h1!.alwaysEnter)}, buy-and-hold per horizon ${pct(h1!.buyAndHoldPerHorizon)}); never compared against 0`);
        } else if (!(h1!.mean! > h1!.alwaysEnter) || !(h1!.mean! > h1!.buyAndHoldPerHorizon)) {
          verdict = "SKILL_NOT_ECONOMIC";
          reasons.push(`holdout selected mean ${pct(h1?.mean)} does not beat always-enter ${pct(h1?.alwaysEnter)} / buy-and-hold per horizon ${pct(h1?.buyAndHoldPerHorizon)}`);
        } else {
          verdict = "CANDIDATE";
          reasons.push(`walk-forward and once-evaluated holdout pass: holdout 2× cost CI lower ${pct(h2.ci.lower)}, Brier skill ${he.brierSkill!.toFixed(4)}, ECE ${he.ece.toFixed(4)}. Candidate for prospective shadow scoring only; never paper or live without operator approval`);
        }
      }
    }
  }

  // Drift: PSI of the most recent (holdout-period) features vs the final training rows, and rolling Brier of the
  // champion on its out-of-sample predictions. Holdout-period FEATURES are read here for drift PSI only: no holdout
  // label or return is touched, and the result feeds the deployment abstention below, never the verdict (which is
  // fixed above). Rolling Brier includes holdout predictions only when the holdout was already evaluated through
  // the gate.
  const champArt = champion ? finalArtefacts[champion.trialId] : undefined;
  const fitX = finalFit.fitRows.map((r) => r.x);
  const recentX = holdoutRows.map((r) => r.x);
  const psiRows = spec.features.map((feature, j) => ({ feature, psi: psi(fitX.map((x) => x[j]!).filter(Number.isFinite), recentX.map((x) => x[j]!).filter(Number.isFinite)) }));
  const seq = champion ? (holdoutScored ? { p: [...scored[champion.trialId]!.p, ...holdoutScored.p], y: [...scored[champion.trialId]!.y, ...holdoutScored.y] } : scored[champion.trialId]!) : null;
  const rollingBrier: number[] = [];
  if (seq) for (let s = 0; s + cfg.brierWindow <= seq.p.length; s += cfg.brierWindow) rollingBrier.push(seq.p.slice(s, s + cfg.brierWindow).reduce((a, p, i) => a + (p - seq.y[s + i]!) ** 2, 0) / cfg.brierWindow);
  const brierDecay = rollingBrier.length >= 2 ? rollingBrier.at(-1)! - rollingBrier[0]! : null;
  const deployment = champArt ? ml2Abstention({ artefact: champArt, asOf: ds.asOf, maxStalenessMs: cfg.maxStalenessMs, drift: psiRows, maxPsi: cfg.maxPsi, brierDecay, maxBrierDecay: cfg.maxBrierDecay }) : null;
  if (deployment?.abstain) reasons.push(`deployment check: the reported artefact must abstain (${deployment.reasons.join("; ")}); a refit and fresh evaluation are required before any shadow use`);

  return {
    ...base,
    folds,
    trials,
    trialCount: trials.length,
    programmeTrialCount,
    championTrialId: champion?.trialId ?? null,
    walkForward,
    dsr,
    holdout,
    drift: { psi: psiRows, rollingBrier, brierDecay },
    deployment,
    artefacts,
    finalArtefacts,
    verdict: verdict ?? "INSUFFICIENT_EVIDENCE",
    reasons,
  };
}
