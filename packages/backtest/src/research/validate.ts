import { createHash } from "node:crypto";
import { mean } from "../stats.js";
import { deflatedSharpe, DSR_PROTOCOL_VERSION, dsrPasses, MIN_TRADES, perBarSharpe, performanceStats, probabilisticSharpe, probabilityOfBacktestOverfitting, type DeflatedSharpe, type PerformanceStats } from "./metrics.js";
import { simulate, type ResearchBar, type SimResult } from "./simulate.js";
import { expandGrid, type ParamGrid, type ParamValue, type StrategySpec } from "./strategies.js";

/**
 * ASCEND-03 validation protocol for one strategy family on one dataset:
 *
 * 1. The last `holdoutFraction` of bars is the final holdout. It is evaluated once, with the single
 *    configuration chosen before it is touched, and never used for selection.
 * 2. The rest is split into `folds` expanding walk-forward folds. In each fold every grid point is run on the
 *    training window; the best by training Sharpe is run on the next test window, after an embargo of
 *    `embargoBars` (covers the strategy's look-back so test decisions share no window with training).
 * 3. Out-of-sample (OOS) results are the concatenated test windows. Every grid point in every fold is a trial.
 * 4. DSR deflates the OOS Sharpe by the number and dispersion of trials; PBO is CSCV over the full grid.
 * 5. The verdict is rule-based and conservative; VALIDATED_CANDIDATE is research status only.
 */

export type Verdict = "VALIDATED_CANDIDATE" | "INSUFFICIENT_EVIDENCE" | "REJECTED_OVERFIT" | "REJECTED_COSTS" | "REJECTED_RISK" | "REJECTED_DATA" | "RESEARCH_ONLY";

export type ValidationConfig = {
  folds: number;
  holdoutFraction: number;
  embargoBars: number;
  costBpsPerSide: number;
  periodsPerYear: number;
  seed: number;
  /** Maximum acceptable OOS drawdown (fraction). */
  maxDrawdown: number;
  /** Minimum bars before validation is attempted at all. */
  minBars: number;
};

export const DEFAULT_VALIDATION: Omit<ValidationConfig, "costBpsPerSide" | "periodsPerYear"> = {
  folds: 4,
  holdoutFraction: 0.2,
  embargoBars: 0,
  seed: 20261101,
  maxDrawdown: 0.3,
  minBars: 500,
};

export type TrialRecord = {
  strategyId: string;
  strategyVersion: string;
  params: Record<string, ParamValue>;
  window: "TRAIN" | "TEST" | "HOLDOUT" | "FULL_GRID";
  fold: number | null;
  startT: number;
  endT: number;
  bars: number;
  trades: number;
  netReturn: number;
  sharpe: number | null;
  perBarSharpe: number | null;
};

export type ValidationReport = {
  strategyId: string;
  strategyVersion: string;
  family: string;
  datasetVersion: string;
  codeVersion: string;
  config: ValidationConfig;
  verdict: Verdict;
  reasons: string[];
  /** True when every out-of-sample test passed before the holdout step (which may still demote the verdict). */
  walkForwardPassed: boolean;
  trials: TrialRecord[];
  trialCount: number;
  selectedParamsByFold: Array<Record<string, ParamValue>>;
  /** How the grid was fitted to this dataset's length (null when validation did not run). */
  gridScale: GridScale | null;
  oos: PerformanceStats | null;
  oosGross: { totalReturn: number; expectancy: number | null } | null;
  oosControls: { buyAndHoldSharpe: number | null; randomSharpe: number | null; cashSharpe: number | null };
  psr: number | null;
  dsr: DeflatedSharpe | null;
  /** DSR deflated by every trial in the research programme (null when no programme count was given). The verdict uses this when present. */
  dsrProgramme: DeflatedSharpe | null;
  /** OOS net return of the selected configurations with every cost multiplied (liquidity-deterioration scenarios). */
  costSensitivity: Array<{ multiplier: number; netReturn: number }>;
  pbo: { pbo: number | null; splits: number } | null;
  holdout: { params: Record<string, ParamValue>; stats: PerformanceStats } | null;
  evidence: "VERIFIED_HISTORICAL" | "VERIFIED_OUT_OF_SAMPLE" | "INSUFFICIENT_EVIDENCE" | "RESEARCH_ONLY";
};

export type GridScale = { factor: number; budgetBars: number; maxLookbackBars: number; grid: ParamGrid };

/**
 * Pre-declared, performance-blind rule that fits a grid to a dataset: the longest look-back may use at most
 * half of one walk-forward segment, so every fold keeps at least half its test window after the embargo.
 * When it would not, every horizon parameter is scaled by the same factor (rounded, ≥ 2 bars, de-duplicated).
 * Thresholds are never scaled and the factor never exceeds 1. The result is recorded with the report.
 */
export function fitGridToData(spec: StrategySpec, totalBars: number, cfg: Pick<ValidationConfig, "folds" | "holdoutFraction">): GridScale {
  const holdoutStart = Math.floor(totalBars * (1 - cfg.holdoutFraction));
  const budgetBars = Math.floor(Math.floor(holdoutStart / (cfg.folds + 1)) / 2);
  const lookbackOf = (grid: ParamGrid) => Math.max(...expandGrid(grid).map((params) => spec.build!(params).lookback));
  const original = lookbackOf(spec.grid);
  if (original <= budgetBars || spec.horizonParams.length === 0) return { factor: 1, budgetBars, maxLookbackBars: original, grid: spec.grid };
  let factor = budgetBars / original;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const grid: ParamGrid = { ...spec.grid };
    for (const key of spec.horizonParams) {
      if (grid[key]) grid[key] = [...new Set(grid[key]!.map((v) => Math.max(2, Math.round(v * factor))))];
    }
    const lookback = lookbackOf(grid);
    if (lookback <= budgetBars) return { factor, budgetBars, maxLookbackBars: lookback, grid };
    factor *= 0.95;
  }
  return { factor, budgetBars, maxLookbackBars: original, grid: spec.grid };
}

export function datasetVersionOf(bars: readonly ResearchBar[]): string {
  const h = createHash("sha256");
  for (const b of bars) h.update(`${b.t}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume ?? ""};`);
  return h.digest("hex").slice(0, 24);
}

/** Folds: expanding train [0, trainEnd), test [trainEnd + embargo, testEnd), all inside the pre-holdout span. */
export function walkForwardFolds(totalBars: number, cfg: Pick<ValidationConfig, "folds" | "holdoutFraction" | "embargoBars">) {
  const holdoutStart = Math.floor(totalBars * (1 - cfg.holdoutFraction));
  const segment = Math.floor(holdoutStart / (cfg.folds + 1));
  const folds: Array<{ fold: number; trainStart: number; trainEnd: number; testStart: number; testEnd: number }> = [];
  for (let k = 1; k <= cfg.folds; k += 1) {
    const trainEnd = segment * k;
    const testStart = trainEnd + cfg.embargoBars;
    const testEnd = k === cfg.folds ? holdoutStart : segment * (k + 1);
    if (testEnd - testStart > 0) folds.push({ fold: k, trainStart: 0, trainEnd, testStart, testEnd });
  }
  return { holdoutStart, folds };
}

function run(spec: StrategySpec, params: Record<string, ParamValue>, bars: readonly ResearchBar[], start: number, end: number, cfg: ValidationConfig, cost = cfg.costBpsPerSide): SimResult {
  return simulate({ strategy: spec.build!(params), bars, startIndex: start, endIndex: end, costBpsPerSide: cost, seed: cfg.seed });
}

function trial(spec: StrategySpec, params: Record<string, ParamValue>, window: TrialRecord["window"], fold: number | null, sim: SimResult, cfg: ValidationConfig): TrialRecord {
  const stats = performanceStats(sim, cfg.periodsPerYear);
  return {
    strategyId: spec.id,
    strategyVersion: spec.version,
    params,
    window,
    fold,
    startT: sim.barTimes[0] ?? 0,
    endT: sim.barTimes.at(-1) ?? 0,
    bars: stats.bars,
    trades: stats.trades,
    netReturn: stats.totalReturn,
    sharpe: stats.sharpe,
    perBarSharpe: stats.perBar.sharpe,
  };
}

function concat(parts: SimResult[]): SimResult {
  const barReturns = parts.flatMap((p) => p.barReturns);
  const n = Math.max(1, barReturns.length);
  return {
    barReturns,
    grossBarReturns: parts.flatMap((p) => p.grossBarReturns),
    barTimes: parts.flatMap((p) => p.barTimes),
    trades: parts.flatMap((p) => p.trades),
    exposure: parts.reduce((s, p) => s + p.exposure * p.barReturns.length, 0) / n,
    turnover: parts.reduce((s, p) => s + p.turnover * p.barReturns.length, 0) / n,
    costBpsPerSide: parts[0]?.costBpsPerSide ?? 0,
  };
}

export function validateStrategy(input: {
  spec: StrategySpec;
  bars: readonly ResearchBar[];
  config: ValidationConfig;
  codeVersion: string;
  controls: { buyAndHold: StrategySpec; random: StrategySpec; cash: StrategySpec };
  /**
   * False when this strategy (any version) already consumed a holdout on this instrument and interval (see the
   * trial registry). Keyed wider than the unique key so a version bump or a re-imported dataset cannot buy a
   * fresh look at the same bars. A function is called only when a candidate is about to read the holdout, so a
   * recording gate (HORIZON) is consumed exactly when the holdout is evaluated and never otherwise.
   */
  holdoutAvailable?: boolean | (() => boolean);
  /**
   * True when the caller cannot record a holdout read (a read-only run): a candidate that passed walk-forward is
   * reported as INSUFFICIENT_EVIDENCE with `walkForwardPassed: true`, and the holdout is never touched.
   */
  holdoutWithheld?: boolean;
  /** Trials already recorded across the whole research programme; deflates DSR for programme-wide selection. */
  programmeTrialCount?: number;
  /**
   * True when the cost basis is a proxy rather than point-in-time (e.g. present-day pool liquidity standing in
   * for history). A candidate must then stay net-positive at twice the modelled cost.
   */
  costIsProxy?: boolean;
}): ValidationReport {
  const { spec, bars, config: cfg } = input;
  const base = {
    strategyId: spec.id,
    strategyVersion: spec.version,
    family: spec.family,
    datasetVersion: datasetVersionOf(bars),
    codeVersion: input.codeVersion,
    config: cfg,
  };
  const empty = { walkForwardPassed: false, trials: [], trialCount: 0, selectedParamsByFold: [], gridScale: null, oos: null, oosGross: null, oosControls: { buyAndHoldSharpe: null, randomSharpe: null, cashSharpe: null }, psr: null, dsr: null, dsrProgramme: null, costSensitivity: [], pbo: null, holdout: null };
  if (!spec.supported || !spec.build) {
    return { ...base, ...empty, verdict: "RESEARCH_ONLY", reasons: [spec.unsupportedReason ?? "unsupported"], evidence: "RESEARCH_ONLY" };
  }
  if (bars.length < cfg.minBars) {
    return { ...base, ...empty, verdict: "REJECTED_DATA", reasons: [`${bars.length} bars < minimum ${cfg.minBars}`], evidence: "INSUFFICIENT_EVIDENCE" };
  }

  const gridScale = fitGridToData(spec, bars.length, cfg);
  const grid = expandGrid(gridScale.grid);
  // Embargo at least the longest look-back in the grid, so no test decision reads a window that overlaps
  // the bars the selection was fitted on.
  const maxLookback = Math.max(...grid.map((params) => spec.build!(params).lookback));
  const { holdoutStart, folds } = walkForwardFolds(bars.length, { ...cfg, embargoBars: Math.max(cfg.embargoBars, maxLookback) });
  // Each fold's test window must itself be a usable sample; otherwise the protocol cannot run honestly.
  const usable = folds.filter((f) => f.testEnd - f.testStart >= 50);
  if (usable.length < cfg.folds) {
    return {
      ...base,
      ...empty,
      verdict: "INSUFFICIENT_EVIDENCE",
      reasons: [`walk-forward needs more bars: ${usable.length}/${cfg.folds} folds have ≥ 50 test bars after a ${maxLookback}-bar embargo (${bars.length} bars, holdout from ${holdoutStart})`],
      evidence: "INSUFFICIENT_EVIDENCE",
      gridScale,
    };
  }
  const trials: TrialRecord[] = [];
  const selected: Array<Record<string, ParamValue>> = [];
  const oosParts: SimResult[] = [];
  const oosGrossParts: SimResult[] = [];
  const tested: Array<{ params: Record<string, ParamValue>; start: number; end: number }> = [];
  for (const f of folds) {
    let best: { params: Record<string, ParamValue>; score: number } | null = null;
    for (const params of grid) {
      const sim = run(spec, params, bars, f.trainStart, f.trainEnd, cfg);
      const t = trial(spec, params, "TRAIN", f.fold, sim, cfg);
      trials.push(t);
      const score = t.perBarSharpe ?? Number.NEGATIVE_INFINITY;
      if (!best || score > best.score) best = { params, score };
    }
    selected.push(best!.params);
    tested.push({ params: best!.params, start: f.testStart, end: f.testEnd });
    const test = run(spec, best!.params, bars, f.testStart, f.testEnd, cfg);
    trials.push(trial(spec, best!.params, "TEST", f.fold, test, cfg));
    oosParts.push(test);
    oosGrossParts.push(run(spec, best!.params, bars, f.testStart, f.testEnd, cfg, 0));
  }

  // Full-grid pre-holdout series for PBO (every configuration, same bars).
  const matrix: number[][] = [];
  const allSharpes: number[] = [];
  for (const params of grid) {
    const sim = run(spec, params, bars, 0, holdoutStart, cfg);
    const t = trial(spec, params, "FULL_GRID", null, sim, cfg);
    trials.push(t);
    matrix.push(sim.barReturns);
    if (t.perBarSharpe !== null) allSharpes.push(t.perBarSharpe);
  }

  const oosSim = concat(oosParts);
  const oos = performanceStats(oosSim, cfg.periodsPerYear);
  const gross = concat(oosGrossParts);
  const grossStats = performanceStats(gross, cfg.periodsPerYear);
  const testRange = folds.length ? { start: folds[0]!.testStart, end: holdoutStart } : { start: 0, end: 0 };
  const controlSharpe = (s: StrategySpec, params: Record<string, ParamValue>) => perBarSharpe(run(s, params, bars, testRange.start, testRange.end, cfg).barReturns);
  const randomSharpes = expandGrid(input.controls.random.grid).map((p) => controlSharpe(input.controls.random, p)).filter((x): x is number => x !== null);
  const oosControls = {
    buyAndHoldSharpe: controlSharpe(input.controls.buyAndHold, {}),
    randomSharpe: randomSharpes.length ? (mean(randomSharpes) as number) : null,
    cashSharpe: null,
  };

  const sr = oos.perBar.sharpe;
  const psr = sr !== null && oos.perBar.skew !== null && oos.perBar.kurtosis !== null ? probabilisticSharpe({ sharpe: sr, benchmark: 0, n: oos.bars, skew: oos.perBar.skew, kurtosis: oos.perBar.kurtosis }) : null;
  const trainSharpes = trials.filter((t) => t.window === "TRAIN" && t.perBarSharpe !== null).map((t) => t.perBarSharpe!);
  const dsr = sr !== null && oos.perBar.skew !== null && oos.perBar.kurtosis !== null ? deflatedSharpe({ sharpe: sr, n: oos.bars, skew: oos.perBar.skew, kurtosis: oos.perBar.kurtosis, trialSharpes: [...trainSharpes, ...allSharpes] }) : null;
  const dsrProgramme =
    input.programmeTrialCount !== undefined && sr !== null && oos.perBar.skew !== null && oos.perBar.kurtosis !== null
      ? deflatedSharpe({ sharpe: sr, n: oos.bars, skew: oos.perBar.skew, kurtosis: oos.perBar.kurtosis, trialSharpes: [...trainSharpes, ...allSharpes], trialCount: input.programmeTrialCount + trials.length })
      : null;
  const effectiveDsr = dsrProgramme ?? dsr;
  const costSensitivity = [2, 3].map((multiplier) => {
    const parts = tested.map((t) => run(spec, t.params, bars, t.start, t.end, cfg, cfg.costBpsPerSide * multiplier));
    return { multiplier, netReturn: performanceStats(concat(parts), cfg.periodsPerYear).totalReturn };
  });
  const pbo = grid.length >= 2 ? probabilityOfBacktestOverfitting(matrix) : { pbo: null, splits: 0 };

  const reasons: string[] = [];
  let verdict: Verdict;
  const isControl = spec.family === "CONTROL";
  if (!oos.sufficient.bars) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`OOS bars ${oos.bars} below minimum`);
  } else if (!isControl && oos.trades < MIN_TRADES) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`OOS trades ${oos.trades} < ${MIN_TRADES}`);
  } else if (grossStats.totalReturn > 0 && oos.totalReturn <= 0) {
    verdict = "REJECTED_COSTS";
    reasons.push(`OOS gross ${(grossStats.totalReturn * 100).toFixed(2)}% turns into net ${(oos.totalReturn * 100).toFixed(2)}% after ${cfg.costBpsPerSide} bps/side`);
  } else if (oos.maxDrawdown > cfg.maxDrawdown) {
    verdict = "REJECTED_RISK";
    reasons.push(`OOS max drawdown ${(oos.maxDrawdown * 100).toFixed(1)}% > ${(cfg.maxDrawdown * 100).toFixed(0)}%`);
  } else if (pbo.pbo !== null && pbo.pbo > 0.5) {
    verdict = "REJECTED_OVERFIT";
    reasons.push(`PBO ${pbo.pbo.toFixed(2)} > 0.5`);
  } else if (oos.totalReturn <= 0 || (sr ?? 0) <= 0) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push("OOS net return not positive");
  } else if (!dsrPasses(effectiveDsr?.dsr, 0.95)) {
    // F04: a DSR that is not computable is insufficient evidence, never a pass; a low one is overfit.
    verdict = isControl || effectiveDsr?.dsr === null || effectiveDsr === null ? "INSUFFICIENT_EVIDENCE" : "REJECTED_OVERFIT";
    reasons.push(`DSR ${effectiveDsr?.dsr?.toFixed(3) ?? "n/a"} < 0.95 after ${effectiveDsr?.trials ?? 0} trials${dsrProgramme ? " (programme-wide)" : ""}${effectiveDsr?.reason ? ` [${effectiveDsr.reason}]` : ""} (${DSR_PROTOCOL_VERSION})`);
  } else if (!isControl && ((oosControls.buyAndHoldSharpe ?? Number.NEGATIVE_INFINITY) >= sr! || (oosControls.randomSharpe ?? Number.NEGATIVE_INFINITY) >= sr!)) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push("Does not beat buy-and-hold and the random control out of sample");
  } else {
    verdict = "VALIDATED_CANDIDATE";
  }
  const doubled = costSensitivity.find((c) => c.multiplier === 2)!;
  if (verdict === "VALIDATED_CANDIDATE" && input.costIsProxy && doubled.netReturn <= 0) {
    // A proxy cost basis cannot carry a candidate whose edge vanishes if the true cost was twice the estimate.
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`Cost basis is a proxy and OOS net at 2× cost is ${(doubled.netReturn * 100).toFixed(2)}%`);
  }

  // The final holdout is touched exactly once, with the last fold's selection, and only for a candidate
  // that already passed every OOS test. It can demote a candidate, never promote one.
  let holdout: ValidationReport["holdout"] = null;
  const walkForwardPassed = verdict === "VALIDATED_CANDIDATE";
  if (verdict === "VALIDATED_CANDIDATE" && input.holdoutWithheld) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push("Walk-forward passed; holdout withheld (this run cannot record a holdout read)");
  } else if (verdict === "VALIDATED_CANDIDATE" && (typeof input.holdoutAvailable === "function" ? !input.holdoutAvailable() : input.holdoutAvailable === false)) {
    // Re-evaluating a consumed holdout would turn it into another validation set.
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push("Holdout already consumed by this strategy on this instrument and interval; only genuinely new bars can confirm it");
  } else if (verdict === "VALIDATED_CANDIDATE") {
    const params = selected.at(-1)!;
    const sim = run(spec, params, bars, holdoutStart, bars.length, cfg);
    trials.push(trial(spec, params, "HOLDOUT", null, sim, cfg));
    const stats = performanceStats(sim, cfg.periodsPerYear);
    holdout = { params, stats };
    if (stats.totalReturn <= 0) {
      verdict = "REJECTED_OVERFIT";
      reasons.push(`Holdout net return ${(stats.totalReturn * 100).toFixed(2)}% ≤ 0`);
    }
  }

  return {
    ...base,
    verdict,
    reasons,
    walkForwardPassed,
    trials,
    trialCount: trials.filter((t) => t.window !== "HOLDOUT").length,
    selectedParamsByFold: selected,
    gridScale,
    oos,
    oosGross: { totalReturn: grossStats.totalReturn, expectancy: grossStats.expectancy },
    oosControls,
    psr,
    dsr,
    dsrProgramme,
    costSensitivity,
    pbo,
    holdout,
    evidence: verdict === "VALIDATED_CANDIDATE" ? "VERIFIED_OUT_OF_SAMPLE" : oos.sufficient.bars ? "VERIFIED_HISTORICAL" : "INSUFFICIENT_EVIDENCE",
  };
}
