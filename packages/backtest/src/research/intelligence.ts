import { netForwardLabels, computeFeatures, horizonsFor } from "./features.js";
import { evaluateModels, type MlReport } from "./ml.js";
import { classifyRegimes, trendTransitions, type MarketCalendar, type RegimeState } from "./regime.js";
import { performanceByRegime, REGIME_GATES, REGIME_HYPOTHESES, regimeGatedSpec, trendKey, volatilityKey, type RegimeBucket } from "./regime-analysis.js";
import { simulate, type ResearchBar } from "./simulate.js";
import { STRATEGY_LIBRARY } from "./strategies.js";
import { DEFAULT_VALIDATION, validateStrategy, type ValidationReport } from "./validate.js";
import { dsrPasses } from "./metrics.js";

/**
 * SINGULARITY end-to-end study on one genuine dataset: regimes → regime-conditioned hypotheses through the
 * ASCEND-03 protocol → point-in-time features → baseline models → adversarial review → one honest verdict.
 * Pure: the caller loads bars, prices costs and decides whether to record anything.
 */

export type Objection = { subject: string; objection: string };

export type IntelligenceStudy = {
  bars: number;
  regimes: {
    modelVersion: string;
    latest: RegimeState | null;
    trendShare: Record<string, number>;
    volatilityShare: Record<string, number>;
    unknownShare: number;
    transitions: ReturnType<typeof trendTransitions>;
    /** Descriptive, in-sample: where buy-and-hold returns came from, by regime at the decision bar. */
    buyAndHoldByTrend: RegimeBucket[];
    buyAndHoldByVolatility: RegimeBucket[];
  };
  hypotheses: Array<{ hypothesis: string; base: ValidationReport; gated: ValidationReport }>;
  ml: MlReport;
  objections: Objection[];
  conclusion: "NO TRADE — NO VALIDATED POSITIVE NET EDGE" | "SHADOW REVIEW REQUESTED";
};

function shares(states: readonly RegimeState[], key: (s: RegimeState) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of states) out[key(s)] = (out[key(s)] ?? 0) + 1 / Math.max(1, states.length);
  return out;
}

/** Adversarial checklist (ASCEND-08 §8.6) applied mechanically; anything it cannot rule out is an objection. */
export function challenge(subject: string, r: ValidationReport, base?: ValidationReport): Objection[] {
  const o: Objection[] = [];
  const add = (objection: string) => o.push({ subject, objection });
  if (r.verdict !== "VALIDATED_CANDIDATE") add(`verdict ${r.verdict}: ${r.reasons.join("; ")}`);
  if (!r.oos) return o;
  if (r.oos.trades < 30) add(`only ${r.oos.trades} OOS trades: too few independent outcomes`);
  const sr = r.oos.perBar.sharpe;
  if (sr === null || (r.oosControls.buyAndHoldSharpe ?? Number.NEGATIVE_INFINITY) >= sr) add("does not beat buy-and-hold out of sample: the result may be market beta");
  const doubled = r.costSensitivity.find((c) => c.multiplier === 2);
  if (doubled && doubled.netReturn <= 0) add(`net at 2× cost is ${(doubled.netReturn * 100).toFixed(2)}%: edge depends on the cost estimate`);
  if (r.pbo?.pbo === null || r.pbo === null) add("PBO not computable");
  else if (r.pbo.pbo > 0.5) add(`PBO ${r.pbo.pbo.toFixed(2)} > 0.5`);
  const dsr = r.dsrProgramme ?? r.dsr;
  if (!dsr || !dsrPasses(dsr.dsr, 0.95)) add(`DSR ${dsr?.dsr?.toFixed(3) ?? "n/a"} < 0.95 after ${dsr?.trials ?? 0} trials`);
  add("single instrument: generalisation across instruments not shown");
  if (base?.oos && r.oos.totalReturn <= base.oos.totalReturn && r.oos.maxDrawdown >= base.oos.maxDrawdown) add("regime gate improves neither net return nor drawdown versus the ungated strategy");
  return o;
}

export function runIntelligenceStudy(input: {
  bars: readonly ResearchBar[];
  barMs: number;
  costBpsPerSide: number;
  periodsPerYear: number;
  codeVersion: string;
  programmeTrialCount?: number;
  costIsProxy?: boolean;
  /** Omitted means no holdout may be read: a caller that cannot record the access must not consume it. */
  holdoutAvailable?: (strategyId: string) => boolean;
  /** F03: true when the caller withholds every holdout (it cannot commit the access before reading). */
  holdoutWithheld?: boolean;
  benchmark?: readonly ResearchBar[];
  calendar?: MarketCalendar;
}): IntelligenceStudy {
  const { bars, barMs } = input;
  const states = classifyRegimes(bars, { barMs, benchmark: input.benchmark, calendar: input.calendar });
  const byT = new Map(states.map((s) => [s.t, s]));
  const find = (id: string) => STRATEGY_LIBRARY.find((s) => s.id === id)!;
  const controls = { buyAndHold: find("control_buy_and_hold"), random: find("control_random"), cash: find("control_cash") };
  const config = { ...DEFAULT_VALIDATION, costBpsPerSide: input.costBpsPerSide, periodsPerYear: input.periodsPerYear };
  const common = { bars, config, codeVersion: input.codeVersion, controls, programmeTrialCount: input.programmeTrialCount, costIsProxy: input.costIsProxy };

  const bh = simulate({ strategy: controls.buyAndHold.build!({}), bars, startIndex: 0, endIndex: bars.length, costBpsPerSide: input.costBpsPerSide });
  const hypotheses = REGIME_HYPOTHESES.map((h) => {
    const baseSpec = find(h.baseId);
    const gatedSpec = regimeGatedSpec(baseSpec, REGIME_GATES[h.gate]!, byT);
    // The base is re-evaluated for comparison only; its holdout is never touched here.
    const base = validateStrategy({ ...common, spec: baseSpec, holdoutAvailable: false });
    const gated = input.holdoutWithheld
      ? validateStrategy({ ...common, spec: gatedSpec, holdoutWithheld: true })
      : validateStrategy({ ...common, spec: gatedSpec, holdoutAvailable: input.holdoutAvailable?.(gatedSpec.id) ?? false });
    return { hypothesis: h.hypothesis, base, gated };
  });

  const horizon = horizonsFor(barMs).m;
  const features = computeFeatures(bars, states, { barMs });
  const ml = evaluateModels({ features, labels: netForwardLabels(bars, horizon, input.costBpsPerSide), horizon, costBpsPerSide: input.costBpsPerSide });

  const objections = hypotheses.flatMap((h) => challenge(h.gated.strategyId, h.gated, h.base));
  if (ml.verdict !== "SHADOW_ELIGIBLE") objections.push({ subject: `ml_netpos_h${horizon}`, objection: `${ml.verdict}: ${ml.reasons.join("; ")}` });
  const anyCandidate = hypotheses.some((h) => h.gated.verdict === "VALIDATED_CANDIDATE" && challenge(h.gated.strategyId, h.gated, h.base).length <= 1) || ml.verdict === "SHADOW_ELIGIBLE";

  return {
    bars: bars.length,
    regimes: {
      modelVersion: states[0]?.modelVersion ?? "n/a",
      latest: states.at(-1) ?? null,
      trendShare: shares(states, (s) => s.trend.state),
      volatilityShare: shares(states, (s) => s.volatility.level),
      unknownShare: states.filter((s) => s.insufficient).length / Math.max(1, states.length),
      transitions: trendTransitions(states),
      buyAndHoldByTrend: performanceByRegime({ sim: bh, bars, states, key: trendKey }),
      buyAndHoldByVolatility: performanceByRegime({ sim: bh, bars, states, key: volatilityKey }),
    },
    hypotheses,
    ml,
    objections,
    // Even a passing candidate goes only to operator review for shadow scoring, never to paper or live.
    conclusion: anyCandidate ? "SHADOW REVIEW REQUESTED" : "NO TRADE — NO VALIDATED POSITIVE NET EDGE",
  };
}
