import { Decimal, d } from "@odin/shared";
import type { TradeAutopsy } from "@odin/analytics";
import { costModelForInstrument, dexImpactBps } from "@odin/trading-engine";
import { mean, meanConfidenceInterval, meanLowerBound, quantile } from "./stats.js";

/**
 * ASCEND-06 execution intelligence. Research and ADVISORY only: nothing here is wired into order
 * admission. It predicts round-trip execution cost with an explicit uncertainty allowance, measures how
 * well past predictions matched observed fills, and asks whether a candidate's conservative expected
 * gross move survives those costs.
 *
 * The cost model reuses the engine's own market-specific model (`costModelForInstrument`, `dexImpactBps`),
 * so a Solana AMM pool gets constant-product impact and an FX/ETF instrument gets spread + fee only.
 * Nothing assumes a mid-price fill or a universal cost percentage.
 */

export type CostPredictionInput = {
  /** Pair address or instrument id; selects the market cost model. */
  instrumentId: string;
  notionalUsd: number;
  /** Observed pool liquidity (both sides), USD. Required for DEX markets. */
  liquidityUsd: number | null;
  /** Engine defaults used for DEX markets (from StrategyConfig). */
  feeBps: number;
  spreadBpsEstimate: number;
  /** Standard deviation of the mid return over one observation step, in bps. Null when unknown. */
  stepVolatilityBps: number | null;
  /** Decision-to-fill latency in observation steps (0 = same observation). */
  latencySteps: number;
  /** Fractional haircut applied to liquidity for the conservative case (observation uncertainty). Default 0.25. */
  liquidityUncertainty?: number;
  /** Assumed fractional liquidity loss between entry and exit (deterioration). Default 0.2 for DEX, 0 otherwise. */
  exitLiquidityDecay?: number;
  /** Multiplier ≥ 1 from the forecast-error report; corrects systematic underestimation. Default 1. */
  calibrationMultiplier?: number;
  /** z for the latency adverse-move allowance in the conservative case. Default 1.28 (90% one-sided). */
  latencyZ?: number;
};

export type CostComponents = {
  entrySpreadBps: number;
  entryImpactBps: number;
  entryFeeBps: number;
  exitSpreadBps: number;
  exitImpactBps: number;
  exitFeeBps: number;
  latencyAllowanceBps: number;
};

export type CostPrediction = {
  model: "DEX_CONSTANT_PRODUCT" | "QUOTED_SPREAD_FEE";
  supported: boolean;
  unsupportedReason: string | null;
  /** Central estimate of the round trip, bps of entry notional. */
  expectedBps: number;
  /** Conservative estimate: liquidity haircut, exit decay, latency allowance and calibration applied. */
  conservativeBps: number;
  expected: CostComponents;
  conservative: CostComponents;
  assumptions: string[];
};

function impactBps(side: "BUY" | "SELL", notionalUsd: number, liquidityUsd: number): number {
  if (notionalUsd <= 0) return 0;
  return dexImpactBps(side, d(notionalUsd.toString()), d(liquidityUsd.toString())).toNumber();
}

function total(c: CostComponents): number {
  return c.entrySpreadBps + c.entryImpactBps + c.entryFeeBps + c.exitSpreadBps + c.exitImpactBps + c.exitFeeBps + c.latencyAllowanceBps;
}

export function predictRoundTripCost(input: CostPredictionInput): CostPrediction {
  const model = costModelForInstrument(input.instrumentId, {
    feeBps: String(input.feeBps),
    spreadBpsEstimate: String(input.spreadBpsEstimate),
    minLiquidityUsd: "1",
  });
  const assumptions: string[] = [];
  const empty: CostComponents = {
    entrySpreadBps: 0, entryImpactBps: 0, entryFeeBps: 0, exitSpreadBps: 0, exitImpactBps: 0, exitFeeBps: 0, latencyAllowanceBps: 0,
  };
  const kind = model.applyDexImpact ? "DEX_CONSTANT_PRODUCT" : "QUOTED_SPREAD_FEE";
  if (model.executionSupported === false) {
    return {
      model: kind, supported: false, unsupportedReason: model.unsupportedReason ?? "EXECUTION_UNSUPPORTED",
      expectedBps: Number.POSITIVE_INFINITY, conservativeBps: Number.POSITIVE_INFINITY, expected: empty, conservative: empty, assumptions,
    };
  }
  if (model.applyDexImpact && !(input.liquidityUsd !== null && input.liquidityUsd > 0)) {
    return {
      model: kind, supported: false, unsupportedReason: "MISSING_LIQUIDITY",
      expectedBps: Number.POSITIVE_INFINITY, conservativeBps: Number.POSITIVE_INFINITY, expected: empty, conservative: empty, assumptions,
    };
  }

  const halfSpread = Number(model.spreadBpsEstimate) / 2;
  const fee = Number(model.feeBps);
  const n = input.notionalUsd;
  const haircut = input.liquidityUncertainty ?? 0.25;
  const decay = input.exitLiquidityDecay ?? (model.applyDexImpact ? 0.2 : 0);
  const calibration = Math.max(1, input.calibrationMultiplier ?? 1);
  const z = input.latencyZ ?? 1.28;

  let expected: CostComponents;
  let conservative: CostComponents;
  if (model.applyDexImpact) {
    const liq = input.liquidityUsd as number;
    expected = {
      entrySpreadBps: halfSpread,
      entryImpactBps: impactBps("BUY", n, liq),
      entryFeeBps: fee,
      exitSpreadBps: halfSpread,
      exitImpactBps: impactBps("SELL", n, liq),
      exitFeeBps: fee,
      latencyAllowanceBps: 0,
    };
    const liqLow = liq * (1 - haircut);
    conservative = {
      entrySpreadBps: halfSpread,
      entryImpactBps: impactBps("BUY", n, liqLow),
      entryFeeBps: fee,
      exitSpreadBps: halfSpread,
      exitImpactBps: impactBps("SELL", n, liqLow * (1 - decay)),
      exitFeeBps: fee,
      latencyAllowanceBps: 0,
    };
    assumptions.push(`DEX constant-product impact on reserve = liquidity / 2; conservative liquidity haircut ${haircut}, exit decay ${decay}`);
  } else {
    expected = { ...empty, entrySpreadBps: halfSpread, entryFeeBps: fee, exitSpreadBps: halfSpread, exitFeeBps: fee };
    conservative = { ...expected };
    assumptions.push("Quoted market: spread + fee per side from instrument semantics; no pool impact");
  }

  if (input.stepVolatilityBps !== null && input.latencySteps > 0) {
    // Adverse move while the order waits: a one-sided allowance of z·σ·√latency on entry and on exit.
    conservative.latencyAllowanceBps = 2 * z * input.stepVolatilityBps * Math.sqrt(input.latencySteps);
    assumptions.push(`Latency allowance 2 × ${z} × σ_step × √${input.latencySteps}`);
  } else if (input.latencySteps > 0) {
    assumptions.push("Latency allowance omitted: step volatility unknown (conservative cost understates latency risk)");
  }

  const conservativeTotal = total(conservative) * calibration;
  if (calibration > 1) assumptions.push(`Calibration multiplier ${calibration.toFixed(3)} from observed forecast error`);
  return {
    model: kind,
    supported: true,
    unsupportedReason: null,
    expectedBps: total(expected),
    conservativeBps: conservativeTotal,
    expected,
    conservative,
    assumptions,
  };
}

// ---------------------------------------------------------------------------------------------------
// Predicted versus actual execution.

export type CostForecastRecord = {
  tradeId: string;
  instrumentId: string;
  /** Predicted round-trip cost, bps of entry notional. */
  predictedBps: number;
  /** Observed round trip: slippage + fees on both legs, bps of entry notional. */
  actualBps: number;
  notionalUsd: number;
  liquidityUsd: number | null;
  stepVolatilityBps: number | null;
  tokenAgeHours: number | null;
  executionDelaySeconds: number | null;
};

export type ForecastGroup = {
  key: string;
  n: number;
  meanPredictedBps: number;
  meanActualBps: number;
  /** actual − predicted; positive means the model underestimated cost. */
  meanErrorBps: number;
  errorCi95: { lower: number; upper: number } | null;
  /** Ratio of total actual to total predicted cost. */
  actualToPredicted: number | null;
  verdict: "SYSTEMATIC_UNDERESTIMATION" | "SYSTEMATIC_OVERESTIMATION" | "NO_SYSTEMATIC_BIAS" | "INSUFFICIENT_EVIDENCE";
};

export type CostForecastReport = {
  overall: ForecastGroup;
  byInstrument: ForecastGroup[];
  byLiquidity: ForecastGroup[];
  bySize: ForecastGroup[];
  byVolatility: ForecastGroup[];
  byTokenAge: ForecastGroup[];
  byDelay: ForecastGroup[];
  /** Conservative multiplier for predictRoundTripCost: max(1, upper bound of actual/predicted). */
  recommendedCalibrationMultiplier: number;
  notes: string[];
};

export const FORECAST_MIN_SAMPLES = 8;

function bracket(value: number | null, edges: number[], labels: string[]): string {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  for (let i = 0; i < edges.length; i += 1) if (value < edges[i]!) return labels[i]!;
  return labels[labels.length - 1]!;
}

function group(key: string, rows: CostForecastRecord[]): ForecastGroup {
  const errors = rows.map((r) => r.actualBps - r.predictedBps);
  const predictedTotal = rows.reduce((s, r) => s + r.predictedBps, 0);
  const actualTotal = rows.reduce((s, r) => s + r.actualBps, 0);
  const ci = rows.length >= FORECAST_MIN_SAMPLES ? meanConfidenceInterval(errors, 0.95) : null;
  let verdict: ForecastGroup["verdict"] = "INSUFFICIENT_EVIDENCE";
  if (ci) verdict = ci.lower > 0 ? "SYSTEMATIC_UNDERESTIMATION" : ci.upper < 0 ? "SYSTEMATIC_OVERESTIMATION" : "NO_SYSTEMATIC_BIAS";
  return {
    key,
    n: rows.length,
    meanPredictedBps: mean(rows.map((r) => r.predictedBps)) ?? 0,
    meanActualBps: mean(rows.map((r) => r.actualBps)) ?? 0,
    meanErrorBps: mean(errors) ?? 0,
    errorCi95: ci ? { lower: ci.lower, upper: ci.upper } : null,
    actualToPredicted: predictedTotal > 0 ? actualTotal / predictedTotal : null,
    verdict,
  };
}

function groupBy(rows: CostForecastRecord[], keyOf: (r: CostForecastRecord) => string): ForecastGroup[] {
  const map = new Map<string, CostForecastRecord[]>();
  for (const r of rows) {
    const k = keyOf(r);
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return [...map.entries()].map(([k, v]) => group(k, v)).sort((a, b) => a.key.localeCompare(b.key));
}

export function costForecastReport(rows: CostForecastRecord[]): CostForecastReport {
  const notes: string[] = [];
  const overall = group("ALL", rows);
  // Ratio interval per trade, so the multiplier reflects the spread of under-estimation, not one outlier.
  const ratios = rows.filter((r) => r.predictedBps > 0).map((r) => r.actualBps / r.predictedBps);
  let multiplier = 1;
  if (ratios.length >= FORECAST_MIN_SAMPLES) {
    const ci = meanConfidenceInterval(ratios, 0.9);
    multiplier = Math.max(1, ci ? ci.upper : 1);
  } else {
    notes.push(`Fewer than ${FORECAST_MIN_SAMPLES} trades with a positive prediction: calibration multiplier stays at the conservative default and the bias verdict is INSUFFICIENT_EVIDENCE`);
    // Sparse evidence: never relax below the worst observed ratio.
    const worst = quantile(ratios, 1);
    if (worst !== null) multiplier = Math.max(1, worst);
  }
  return {
    overall,
    byInstrument: groupBy(rows, (r) => r.instrumentId),
    byLiquidity: groupBy(rows, (r) => bracket(r.liquidityUsd, [50_000, 250_000, 1_000_000], ["<50k", "50k-250k", "250k-1m", ">=1m"])),
    bySize: groupBy(rows, (r) => bracket(r.notionalUsd, [100, 500, 2_000], ["<100", "100-500", "500-2k", ">=2k"])),
    byVolatility: groupBy(rows, (r) => bracket(r.stepVolatilityBps, [50, 200, 500], ["<50bps", "50-200bps", "200-500bps", ">=500bps"])),
    byTokenAge: groupBy(rows, (r) => bracket(r.tokenAgeHours, [1, 24, 24 * 7], ["<1h", "1-24h", "1-7d", ">=7d"])),
    byDelay: groupBy(rows, (r) => bracket(r.executionDelaySeconds, [5, 30, 120], ["<5s", "5-30s", "30-120s", ">=120s"])),
    recommendedCalibrationMultiplier: multiplier,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------
// Net expected edge.

export type EdgeReasonCode =
  | "EXPECTED_EDGE_INSUFFICIENT"
  | "COST_EXCEEDS_OPPORTUNITY"
  | "IMPACT_TOO_HIGH"
  | "EXECUTION_UNCERTAINTY_HIGH"
  | "LIQUIDITY_DETERIORATING"
  | "SPREAD_UNFAVOURABLE"
  | "MARKET_DATA_INSUFFICIENT";

export type NetEdgeInput = {
  /**
   * Out-of-sample gross (mid-to-mid) returns, bps, of past trades that match this candidate's setup.
   * In-sample or fixture returns must not be passed here as evidence.
   */
  grossReturnSamplesBps: number[];
  cost: CostPrediction;
  /** One-sided confidence for the gross-return lower bound. Default 0.9. */
  confidence?: number;
  /** Extra allowance in bps for model uncertainty. Default 0. */
  uncertaintyAllowanceBps?: number;
  minSamples?: number;
  /** Recent liquidity observations, oldest first, for the deterioration check. */
  recentLiquidityUsd?: number[];
  /** Entry impact cap (bps); IMPACT_TOO_HIGH above this fraction of it. Default: no check. */
  maxPriceImpactBps?: number;
};

export type NetEdgeAssessment = {
  mode: "ADVISORY";
  qualifies: boolean;
  reasons: EdgeReasonCode[];
  n: number;
  meanGrossBps: number | null;
  lowerGrossBps: number | null;
  expectedNetBps: number | null;
  /** lowerGrossBps − conservative cost − allowance. Qualification requires this > 0. */
  conservativeNetBps: number | null;
  confidence: number;
};

export const NET_EDGE_MIN_SAMPLES = 20;

export function assessNetEdge(input: NetEdgeInput): NetEdgeAssessment {
  const confidence = input.confidence ?? 0.9;
  const minSamples = input.minSamples ?? NET_EDGE_MIN_SAMPLES;
  const allowance = input.uncertaintyAllowanceBps ?? 0;
  const samples = input.grossReturnSamplesBps.filter((x) => Number.isFinite(x));
  const reasons: EdgeReasonCode[] = [];
  const base = { mode: "ADVISORY" as const, n: samples.length, confidence };

  if (!input.cost.supported) reasons.push("MARKET_DATA_INSUFFICIENT");
  if (samples.length < minSamples) reasons.push("MARKET_DATA_INSUFFICIENT");
  const liq = input.recentLiquidityUsd ?? [];
  if (liq.length >= 3) {
    const first = liq[0]!;
    const last = liq[liq.length - 1]!;
    if (first > 0 && (first - last) / first > 0.15) reasons.push("LIQUIDITY_DETERIORATING");
  }
  if (input.maxPriceImpactBps !== undefined && input.cost.supported && input.cost.conservative.entryImpactBps > input.maxPriceImpactBps * 0.8) {
    reasons.push("IMPACT_TOO_HIGH");
  }
  if (input.cost.supported && input.cost.expectedBps > 0 && input.cost.conservativeBps / input.cost.expectedBps > 2) {
    reasons.push("EXECUTION_UNCERTAINTY_HIGH");
  }

  if (reasons.includes("MARKET_DATA_INSUFFICIENT")) {
    return { ...base, qualifies: false, reasons: [...new Set(reasons)], meanGrossBps: mean(samples), lowerGrossBps: null, expectedNetBps: null, conservativeNetBps: null };
  }

  const meanGross = mean(samples) as number;
  const lowerGross = meanLowerBound(samples, confidence, minSamples) as number;
  const expectedNet = meanGross - input.cost.expectedBps;
  const conservativeNet = lowerGross - input.cost.conservativeBps - allowance;
  if (meanGross <= input.cost.expectedBps) reasons.push("COST_EXCEEDS_OPPORTUNITY");
  const spread = input.cost.expected.entrySpreadBps + input.cost.expected.exitSpreadBps;
  if (meanGross > 0 && spread > meanGross * 0.5) reasons.push("SPREAD_UNFAVOURABLE");
  if (conservativeNet <= 0) reasons.push("EXPECTED_EDGE_INSUFFICIENT");
  const unique = [...new Set(reasons)];
  return {
    ...base,
    qualifies: unique.length === 0,
    reasons: unique,
    meanGrossBps: meanGross,
    lowerGrossBps: lowerGross,
    expectedNetBps: expectedNet,
    conservativeNetBps: conservativeNet,
  };
}

/**
 * Out-of-sample check of the edge rule: the rule is fitted (samples drawn) only from `train`, and judged on
 * `test` by the realised net return of trades it would have admitted versus rejected. Chronology is the
 * caller's contract; this function refuses overlapping windows.
 */
export type EdgeRuleTrade = { at: string; setupKey: string; grossBps: number; netBps: number; cost: CostPrediction };

export function evaluateEdgeRuleOutOfSample(input: {
  train: EdgeRuleTrade[];
  test: EdgeRuleTrade[];
  confidence?: number;
  minSamples?: number;
}): {
  admitted: { n: number; meanNetBps: number | null };
  rejected: { n: number; meanNetBps: number | null };
  verdict: "RULE_HELPS" | "RULE_DOES_NOT_HELP" | "INSUFFICIENT_EVIDENCE";
} {
  const lastTrain = Math.max(...input.train.map((t) => Date.parse(t.at)));
  const firstTest = Math.min(...input.test.map((t) => Date.parse(t.at)));
  if (input.train.length > 0 && input.test.length > 0 && !(lastTrain < firstTest)) {
    throw new Error("evaluateEdgeRuleOutOfSample: train must end before test begins");
  }
  const bySetup = new Map<string, number[]>();
  for (const t of input.train) bySetup.set(t.setupKey, [...(bySetup.get(t.setupKey) ?? []), t.grossBps]);
  const admitted: number[] = [];
  const rejected: number[] = [];
  for (const t of input.test) {
    const verdict = assessNetEdge({
      grossReturnSamplesBps: bySetup.get(t.setupKey) ?? [],
      cost: t.cost,
      confidence: input.confidence,
      minSamples: input.minSamples,
    });
    (verdict.qualifies ? admitted : rejected).push(t.netBps);
  }
  const ma = mean(admitted);
  const mr = mean(rejected);
  let verdict: "RULE_HELPS" | "RULE_DOES_NOT_HELP" | "INSUFFICIENT_EVIDENCE" = "INSUFFICIENT_EVIDENCE";
  if (admitted.length >= 10 && rejected.length >= 10 && ma !== null && mr !== null) verdict = ma > mr ? "RULE_HELPS" : "RULE_DOES_NOT_HELP";
  return { admitted: { n: admitted.length, meanNetBps: ma }, rejected: { n: rejected.length, meanNetBps: mr }, verdict };
}

/** σ of one-step mid returns in bps, from a chronological price path. Null below three prices. */
export function stepVolatilityBps(prices: number[]): number | null {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) rets.push(Math.log(prices[i]! / prices[i - 1]!) * 10_000);
  }
  if (rets.length < 2) return null;
  const m = mean(rets) as number;
  return Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1));
}

/** Decimal helper for callers holding ledger strings. */
export function bpsOf(partUsd: string, wholeUsd: string): number {
  const whole = new Decimal(wholeUsd);
  if (whole.lte(0)) return 0;
  return new Decimal(partUsd).div(whole).mul(10_000).toNumber();
}

/**
 * Predicted-versus-actual record for a closed round trip from the ASCEND-00 trade autopsy. The prediction
 * uses only what was known at entry (entry liquidity, entry notional, pre-entry volatility when supplied);
 * the actual cost is the autopsy's recorded slippage + fees. Returns null when entry liquidity was not
 * recorded, rather than predicting from an assumed pool size.
 */
export function forecastRecordFromAutopsy(
  trip: TradeAutopsy,
  options: { feeBps: number; spreadBpsEstimate: number; preEntryStepVolBps?: number | null; latencySteps?: number },
): CostForecastRecord | null {
  const notional = Number(trip.entryNotionalUsd);
  const liquidity = trip.entry.liquidityUsd === null ? null : Number(trip.entry.liquidityUsd);
  if (!(notional > 0)) return null;
  const prediction = predictRoundTripCost({
    instrumentId: trip.pairAddress,
    notionalUsd: notional,
    liquidityUsd: liquidity,
    feeBps: options.feeBps,
    spreadBpsEstimate: options.spreadBpsEstimate,
    stepVolatilityBps: options.preEntryStepVolBps ?? null,
    latencySteps: options.latencySteps ?? 0,
  });
  if (!prediction.supported) return null;
  const actualUsd = Number(trip.components.slippageUsd) + Number(trip.components.feesUsd);
  return {
    tradeId: `${trip.pairAddress}:${trip.openedAt}`,
    instrumentId: trip.pairAddress,
    predictedBps: prediction.expectedBps,
    actualBps: (actualUsd / notional) * 10_000,
    notionalUsd: notional,
    liquidityUsd: liquidity,
    stepVolatilityBps: options.preEntryStepVolBps ?? null,
    tokenAgeHours: trip.entry.ageHoursAtEntry === null ? null : Number(trip.entry.ageHoursAtEntry),
    executionDelaySeconds: null,
  };
}
