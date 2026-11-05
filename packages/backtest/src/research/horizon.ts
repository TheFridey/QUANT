import { validateResearchBars } from "./feature-set.js";
import { declaredGrids, HORIZON_STRATEGIES_VERSION, horizonStrategySpecs } from "./horizon-strategies.js";
import { costBpsPerSideAt, horizonBars, legacyThresholdDiagnostic, marketConfigHash, periodsPerYearFor, pipSizeFor, validationCostBpsPerSide, type MarketResearchConfig } from "./market-config.js";
import { Ml2Refusal, runMlPipeline, type HoldoutGate, type LearnerConfig, type Ml2Config, type Ml2Verdict } from "./ml2.js";
import { classifyRegimes, type RegimeState } from "./regime.js";
import { regimeCalendarFor } from "./sessions.js";
import type { ResearchBar } from "./simulate.js";
import { STRATEGY_LIBRARY, type ParamValue } from "./strategies.js";
import { DEFAULT_VALIDATION, validateStrategy, type ValidationConfig, type Verdict } from "./validate.js";

/**
 * OPERATION HORIZON study runner (research only). For one market configuration and one bar series it:
 *  1. refuses bars that break the market's session calendar (or arrive after their close, for the strategies);
 *  2. runs every HORIZON strategy family through the ASCEND-03 walk-forward validator (every grid point in every
 *     fold a recorded trial) at the market's flat validation cost, flagged as a proxy cost (2× must survive);
 *  3. runs GENESIS ML 2.0 with market-appropriate labels (horizon in trading hours, fee + spread + slippage);
 *  4. compares each against buy-and-hold, cash and random-selection controls;
 *  5. deflates every Sharpe by the programme-wide trial count (`priorTrials` + every trial run so far here);
 *  6. touches a holdout only through a recording `HoldoutGate`; without one the holdout is withheld.
 * It never writes anything, never changes a strategy instance, engine config, DEFAULT_STRATEGY or promotion state.
 */

export const HORIZON_RUNNER_VERSION = "horizon-runner-1.0.0";

export type HorizonVerdict = "CANDIDATE" | "CANDIDATE_PENDING_HOLDOUT" | "NO_SKILL" | "INSUFFICIENT_EVIDENCE" | "REJECTED_DATA";

export type HorizonInput = {
  bars: readonly ResearchBar[];
  barMs: number;
  /** When each bar became available (aligned with bars); null/absent = at its close. */
  barAvailableAt?: ReadonlyArray<number | null>;
  market: MarketResearchConfig;
  instrument: string;
  /** Instrument + interval identity for holdout keys (e.g. warehouse instrumentKey|interval). */
  datasetKey: string;
  codeVersion: string;
  /** Trials already recorded across the research programme before this run. */
  priorTrials: number;
  /** A recording gate. Absent = read-only run: every holdout is withheld. */
  holdoutGate?: HoldoutGate;
  ml?: { enabled: boolean; horizons?: "PRIMARY" | "ALL"; config?: Partial<Ml2Config>; learners?: LearnerConfig[] };
  validation?: Partial<Pick<ValidationConfig, "folds" | "holdoutFraction" | "seed" | "maxDrawdown">>;
  /** Restrict to these strategy ids (default: all applicable). */
  strategies?: string[];
};

export type HorizonStrategyResult = {
  id: string;
  version: string;
  family: string;
  verdict: Verdict;
  walkForwardPassed: boolean;
  reasons: string[];
  trialCount: number;
  gridAsRun: Record<string, ParamValue[]> | null;
  gridScaleFactor: number | null;
  selectedParamsByFold: Array<Record<string, ParamValue>>;
  oos: { bars: number; trades: number; netReturn: number; grossReturn: number | null; sharpe: number | null; perBarSharpe: number | null; maxDrawdown: number; exposure: number } | null;
  controls: { buyAndHoldPerBarSharpe: number | null; randomPerBarSharpe: number | null; cashPerBarSharpe: 0; beatsBuyAndHold: boolean | null; beatsRandom: boolean | null; beatsCash: boolean | null };
  dsr: number | null;
  dsrProgramme: { dsr: number | null; trials: number } | null;
  pbo: number | null;
  costSensitivity: Array<{ multiplier: number; netReturn: number }>;
  holdout: { evaluated: boolean; netReturn: number | null };
  trials: Array<{ params: Record<string, ParamValue>; window: string; fold: number | null; bars: number; trades: number; netReturn: number; perBarSharpe: number | null }>;
};

export type HorizonMlResult =
  | { horizonBars: number; horizonTradingHours: number; refused: string }
  | {
      horizonBars: number;
      horizonTradingHours: number;
      verdict: Ml2Verdict;
      reasons: string[];
      trialCount: number;
      programmeTrialCount: number;
      championTrialId: string | null;
      champion: { auc: number | null; brierSkill: number | null; signals: number; expectancy1x: number | null; alwaysEnter1x: number | null; buyAndHoldPerHorizon1x: number | null; randomControlMean: number | null; randomControlPValue: number | null } | null;
      holdout: { evaluated: boolean; reason?: string };
      trials: Array<{ trialId: string; family: string; status: string; auc: number | null; brierSkill: number | null; signals: number; expectancy1x: number | null; sharpe: number | null }>;
    };

export type HorizonReport = {
  runner: string;
  strategiesVersion: string;
  market: { id: string; version: string; hash: string; calendar: string; costAssumptions: string[] };
  instrument: string;
  pipSize: number | null;
  data: { bars: number; barMs: number; firstT: number | null; lastT: number | null; lateBars: number };
  costs: { validationBpsPerSide: number; medianPriceBpsPerSide: number | null; costIsProxy: true };
  thresholds: ReturnType<typeof legacyThresholdDiagnostic>;
  declaredGrids: ReturnType<typeof declaredGrids>;
  strategies: HorizonStrategyResult[];
  ml: HorizonMlResult[];
  programme: { priorTrials: number; runTrials: number; total: number };
  holdoutPolicy: "RECORDED_GATE" | "WITHHELD_READ_ONLY";
  verdict: HorizonVerdict;
  reasons: string[];
};

/** Invalid input: thrown, never reported as a result. */
export class HorizonRefusal extends Error {
  constructor(message: string) {
    super(`REFUSED: ${message}`);
    this.name = "HorizonRefusal";
  }
}

const find = (id: string) => STRATEGY_LIBRARY.find((s) => s.id === id)!;
const CONTROLS = { buyAndHold: find("control_buy_and_hold"), random: find("control_random"), cash: find("control_cash") };

/** Causal regime lookup: classifyRegimes is a filtered (one-pass) history, so state t reads bars ≤ t only. */
export function regimeLookup(bars: readonly ResearchBar[], barMs: number, market: MarketResearchConfig): (t: number) => RegimeState | undefined {
  const states = classifyRegimes(bars, { barMs, calendar: regimeCalendarFor(market.calendar) });
  const byT = new Map(states.map((s) => [s.t, s]));
  return (t) => byT.get(t);
}

export function runHorizonStudy(input: HorizonInput): HorizonReport {
  const { bars, barMs, market, instrument } = input;
  if (bars.length === 0) throw new HorizonRefusal("no bars");
  const issues = validateResearchBars(bars, { barMs, calendar: market.calendar, availableAt: input.barAvailableAt });
  if (issues.length) throw new HorizonRefusal(`${issues.length} bar integrity issue(s) under the ${market.calendar} calendar; first: ${issues.slice(0, 3).map((i) => `#${i.index} ${i.code} ${i.detail}`).join("; ")}`);
  if (input.barAvailableAt && input.barAvailableAt.length !== bars.length) throw new HorizonRefusal("barAvailableAt must align with bars");
  // The bar simulator decides at a bar's close; a bar that arrived later could not have been used then.
  const lateBars = (input.barAvailableAt ?? []).filter((a, i) => a !== null && a > bars[i]!.t + barMs).length;

  const hash = marketConfigHash(market);
  const minBars = barMs >= 86_400_000 ? market.minimumSample.minBarsDaily : market.minimumSample.minBarsIntraday;
  const costPerSide = validationCostBpsPerSide(market, instrument, bars, barMs);
  const medianBar = bars.length ? bars[Math.floor(bars.length / 2)]! : null;
  const vcfg: ValidationConfig = { ...DEFAULT_VALIDATION, ...(input.validation ?? {}), costBpsPerSide: costPerSide, periodsPerYear: periodsPerYearFor(market, barMs), minBars };
  const gate = input.holdoutGate;
  let runTrials = 0;
  const reasons: string[] = [];

  const hctx = { market, instrument, barMs, regimeAt: regimeLookup(bars, barMs, market) };
  const allSpecs = horizonStrategySpecs(hctx);
  const specs = input.strategies ? allSpecs.filter((s) => input.strategies!.includes(s.id)) : allSpecs;

  const strategies: HorizonStrategyResult[] = specs.map((spec) => {
    if (lateBars > 0) {
      return { id: spec.id, version: spec.version, family: spec.family, verdict: "REJECTED_DATA" as Verdict, walkForwardPassed: false, reasons: [`${lateBars} bar(s) became available after their close; the bar simulator assumes availability at close`], trialCount: 0, gridAsRun: null, gridScaleFactor: null, selectedParamsByFold: [], oos: null, controls: { buyAndHoldPerBarSharpe: null, randomPerBarSharpe: null, cashPerBarSharpe: 0, beatsBuyAndHold: null, beatsRandom: null, beatsCash: null }, dsr: null, dsrProgramme: null, pbo: null, costSensitivity: [], holdout: { evaluated: false, netReturn: null }, trials: [] };
    }
    const key = `${spec.id}|${input.datasetKey}`;
    const report = validateStrategy({
      spec,
      bars,
      config: vcfg,
      codeVersion: input.codeVersion,
      controls: CONTROLS,
      programmeTrialCount: input.priorTrials + runTrials,
      costIsProxy: true,
      holdoutWithheld: !gate,
      holdoutAvailable: gate ? () => gate.consume(key) : undefined,
    });
    runTrials += report.trialCount;
    let verdict = report.verdict;
    const why = [...report.reasons];
    // Market minimum-sample rule on top of the validator's own (which is never weaker).
    if (verdict === "VALIDATED_CANDIDATE" && report.oos && report.oos.trades < market.minimumSample.minOosTrades) {
      verdict = "INSUFFICIENT_EVIDENCE";
      why.push(`OOS trades ${report.oos.trades} < market minimum ${market.minimumSample.minOosTrades}`);
    }
    const sr = report.oos?.perBar.sharpe ?? null;
    const bh = report.oosControls.buyAndHoldSharpe;
    const rnd = report.oosControls.randomSharpe;
    return {
      id: spec.id,
      version: spec.version,
      family: spec.family,
      verdict,
      walkForwardPassed: report.walkForwardPassed,
      reasons: why,
      trialCount: report.trialCount,
      gridAsRun: report.gridScale?.grid ?? null,
      gridScaleFactor: report.gridScale?.factor ?? null,
      selectedParamsByFold: report.selectedParamsByFold,
      oos: report.oos
        ? { bars: report.oos.bars, trades: report.oos.trades, netReturn: report.oos.totalReturn, grossReturn: report.oosGross?.totalReturn ?? null, sharpe: report.oos.sharpe, perBarSharpe: sr, maxDrawdown: report.oos.maxDrawdown, exposure: report.oos.exposure }
        : null,
      controls: {
        buyAndHoldPerBarSharpe: bh,
        randomPerBarSharpe: rnd,
        cashPerBarSharpe: 0,
        beatsBuyAndHold: sr === null || bh === null ? null : sr > bh,
        beatsRandom: sr === null || rnd === null ? null : sr > rnd,
        beatsCash: report.oos ? report.oos.totalReturn > 0 : null,
      },
      dsr: report.dsr?.dsr ?? null,
      dsrProgramme: report.dsrProgramme ? { dsr: report.dsrProgramme.dsr, trials: report.dsrProgramme.trials } : null,
      pbo: report.pbo?.pbo ?? null,
      costSensitivity: report.costSensitivity,
      holdout: { evaluated: report.holdout !== null, netReturn: report.holdout?.stats.totalReturn ?? null },
      trials: report.trials.map((t) => ({ params: t.params, window: t.window, fold: t.fold, bars: t.bars, trades: t.trades, netReturn: t.netReturn, perBarSharpe: t.perBarSharpe })),
    };
  });

  const ml: HorizonMlResult[] = [];
  if (input.ml?.enabled !== false) {
    const hours = input.ml?.horizons === "ALL" ? market.horizonsTradingHours : market.horizonsTradingHours.slice(0, 1);
    const fee = market.cost.feeBpsPerSide;
    for (const h of hours) {
      const horizon = horizonBars(market, h, barMs);
      try {
        const report = runMlPipeline({
          bars,
          barMs,
          calendar: market.calendar,
          barAvailableAt: input.barAvailableAt,
          labelSpec: { horizon, feeBpsPerSide: fee, slippageBpsPerSide: Math.max(0, costPerSide - fee) },
          target: "NET_POSITIVE",
          learners: input.ml?.learners,
          config: { minEffectiveTestLabels: market.minimumSample.minMlEffectiveTestLabels, minEffectiveSignals: market.minimumSample.minMlEffectiveSignals, ...(input.ml?.config ?? {}) },
          priorTrialCount: input.priorTrials + runTrials,
          holdout: gate ? { gate, key: `ml2|${input.datasetKey}|h${horizon}` } : undefined,
        });
        runTrials += report.trialCount;
        const champ = report.championTrialId ? report.walkForward[report.championTrialId] : undefined;
        const e1 = champ?.expectancy.find((e) => e.costMultiplier === 1);
        ml.push({
          horizonBars: horizon,
          horizonTradingHours: h,
          verdict: report.verdict,
          reasons: report.reasons,
          trialCount: report.trialCount,
          programmeTrialCount: report.programmeTrialCount,
          championTrialId: report.championTrialId,
          champion: champ ? { auc: champ.auc, brierSkill: champ.brierSkill, signals: champ.signals, expectancy1x: e1?.mean ?? null, alwaysEnter1x: e1?.alwaysEnter ?? null, buyAndHoldPerHorizon1x: e1?.buyAndHoldPerHorizon ?? null, randomControlMean: champ.randomControl.mean, randomControlPValue: champ.randomControl.pValue } : null,
          holdout: report.holdout.evaluated ? { evaluated: true } : { evaluated: false, reason: report.holdout.reason },
          trials: report.trials.map((t) => ({ trialId: t.trialId, family: t.family, status: t.status, auc: t.auc, brierSkill: t.brierSkill, signals: t.signals, expectancy1x: t.expectancy1x, sharpe: t.sharpe })),
        });
      } catch (error) {
        if (!(error instanceof Ml2Refusal)) throw error;
        ml.push({ horizonBars: horizon, horizonTradingHours: h, refused: error.message });
      }
    }
  }

  // Overall verdict: research status only.
  const anyCandidate = strategies.some((s) => s.verdict === "VALIDATED_CANDIDATE") || ml.some((m) => "verdict" in m && m.verdict === "CANDIDATE");
  const anyPending = strategies.some((s) => s.walkForwardPassed && s.verdict !== "VALIDATED_CANDIDATE" && !s.holdout.evaluated) || ml.some((m) => "verdict" in m && !m.holdout.evaluated && /withheld/.test(m.holdout.reason ?? ""));
  const ranStrategies = strategies.filter((s) => s.oos !== null && s.oos.bars > 0);
  const ranMl = ml.filter((m) => "verdict" in m && m.verdict !== "INSUFFICIENT_EVIDENCE");
  let verdict: HorizonVerdict;
  if (lateBars > 0 && !ml.some((m) => "verdict" in m)) {
    verdict = "REJECTED_DATA";
    reasons.push(`${lateBars} bar(s) arrived after their close and ML 2.0 did not run`);
  } else if (anyCandidate) {
    verdict = "CANDIDATE";
    reasons.push("At least one hypothesis passed walk-forward and a once-evaluated, recorded holdout. Research status only: never paper or live without operator approval");
  } else if (anyPending) {
    verdict = "CANDIDATE_PENDING_HOLDOUT";
    reasons.push("Walk-forward passed for at least one hypothesis; the holdout was withheld (no recording gate), so this is not evidence of an edge yet");
  } else if (ranStrategies.length > 0 || ranMl.length > 0) {
    verdict = "NO_SKILL";
    reasons.push(`No hypothesis survived walk-forward after costs and ${input.priorTrials + runTrials} programme trials`);
  } else {
    verdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(`Not enough data for any test (${bars.length} bars; market minimum ${minBars})`);
  }

  return {
    runner: HORIZON_RUNNER_VERSION,
    strategiesVersion: HORIZON_STRATEGIES_VERSION,
    market: { id: market.id, version: market.version, hash, calendar: market.calendar, costAssumptions: market.cost.assumptions },
    instrument,
    pipSize: pipSizeFor(market.id, instrument),
    data: { bars: bars.length, barMs, firstT: bars[0]?.t ?? null, lastT: bars.at(-1)?.t ?? null, lateBars },
    costs: { validationBpsPerSide: costPerSide, medianPriceBpsPerSide: medianBar ? costBpsPerSideAt(market, instrument, medianBar.t, medianBar.close, barMs) : null, costIsProxy: true },
    thresholds: legacyThresholdDiagnostic(market, bars, barMs),
    declaredGrids: declaredGrids(allSpecs),
    strategies,
    ml,
    programme: { priorTrials: input.priorTrials, runTrials, total: input.priorTrials + runTrials },
    holdoutPolicy: gate ? "RECORDED_GATE" : "WITHHELD_READ_ONLY",
    verdict,
    reasons,
  };
}
