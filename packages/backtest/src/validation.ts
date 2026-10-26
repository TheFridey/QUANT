import { d, type StrategyConfig } from "@odin/shared";
import { performanceReport, valuePortfolio } from "@odin/analytics";
import type { BacktestResult } from "./types.js";

export type SplitWindows = {
  trainStart: string;
  trainEnd: string;
  validationStart: string;
  validationEnd: string;
  testStart: string;
  testEnd: string;
};

/** Chronological 60/20/20 train / validation / untouched test split. */
export function chronologicalSplits(startAt: string, endAt: string): SplitWindows {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const span = Math.max(0, end - start);
  const trainEnd = start + Math.floor(span * 0.6);
  const validationEnd = start + Math.floor(span * 0.8);
  return {
    trainStart: new Date(start).toISOString(),
    trainEnd: new Date(trainEnd).toISOString(),
    validationStart: new Date(trainEnd).toISOString(),
    validationEnd: new Date(validationEnd).toISOString(),
    testStart: new Date(validationEnd).toISOString(),
    testEnd: new Date(end).toISOString(),
  };
}

export type SampleGateResult = {
  passed: boolean;
  reasons: string[];
  sampleSize: number;
  spanMs: number | null;
  minSampleTrades: number;
  minObservationSpanMs: number;
  label: "INSUFFICIENT_EVIDENCE" | "SAMPLE_OK";
};

export function evaluateSampleGates(
  result: BacktestResult,
  config: StrategyConfig,
): SampleGateResult {
  const reasons: string[] = [];
  const sampleSize = result.closedTradePnls.length;
  const spanMs = result.dataQuality.spanMs;
  if (sampleSize < config.minSampleTrades) {
    reasons.push(
      `Closed trades ${sampleSize} < minSampleTrades ${config.minSampleTrades}`,
    );
  }
  if (spanMs === null || spanMs < config.minObservationSpanMs) {
    reasons.push(
      `Observation span ${spanMs ?? "null"} ms < minObservationSpanMs ${config.minObservationSpanMs}`,
    );
  }
  return {
    passed: reasons.length === 0,
    reasons,
    sampleSize,
    spanMs,
    minSampleTrades: config.minSampleTrades,
    minObservationSpanMs: config.minObservationSpanMs,
    label: reasons.length === 0 ? "SAMPLE_OK" : "INSUFFICIENT_EVIDENCE",
  };
}

export type ReleaseGateResult = {
  passed: boolean;
  reasons: string[];
  label: "NOT_RELEASE_READY" | "PAPER_CANDIDATE";
  /** Explicit: there is no real-money venue. */
  realMoneyGraduation: false;
  requiresForwardPaper: true;
};

export function evaluateReleaseGates(input: {
  config: StrategyConfig;
  sampleGate: SampleGateResult;
  oosSampleSize: number | null;
  oosMaxDrawdownPct: string | null;
  oosReturnPct: string | null;
}): ReleaseGateResult {
  const reasons: string[] = [];
  if (!input.sampleGate.passed) {
    reasons.push(...input.sampleGate.reasons);
  }
  if (input.config.requireOosEvaluation) {
    if (input.oosSampleSize === null || input.oosSampleSize < input.config.minSampleTrades) {
      reasons.push(
        `OOS sample ${input.oosSampleSize ?? 0} < minSampleTrades ${input.config.minSampleTrades}`,
      );
    }
  }
  if (input.oosMaxDrawdownPct !== null && d(input.oosMaxDrawdownPct).gt(input.config.releaseMaxDrawdownPct)) {
    reasons.push(
      `OOS drawdown ${input.oosMaxDrawdownPct}% exceeds releaseMaxDrawdownPct ${input.config.releaseMaxDrawdownPct}%`,
    );
  }
  // One profitable night is never enough — always require forward paper.
  reasons.push("Mandatory forward paper-trading evaluation has not completed");

  return {
    passed: false, // Never auto-pass: paper forward eval is mandatory and external.
    reasons,
    label: "NOT_RELEASE_READY",
    realMoneyGraduation: false,
    requiresForwardPaper: true,
  };
}

export function scoreBacktestResult(result: BacktestResult) {
  const valuation = valuePortfolio({
    cashUsd: result.finalCashUsd,
    positions: [],
    marks: {},
  });
  // Prefer final equity when complete; otherwise cash-only valuation with observed=false.
  const equitySeries = result.equityCurve
    .map((point) => point.equityUsd)
    .filter((value): value is string => value !== null);
  const report = performanceReport({
    valuation:
      result.finalEquityUsd === null
        ? { ...valuation, equityUsd: null, valuation: "INCOMPLETE", marksComplete: false }
        : {
            ...valuation,
            cashUsd: result.finalCashUsd,
            equityUsd: result.finalEquityUsd,
            valuation: "CASH_ONLY",
            marksComplete: true,
          },
    startingBalanceUsd: result.params.initialBalanceUsd,
    feesUsd: result.feesUsd,
    closedTradePnlUsd: result.closedTradePnls,
    equitySeries,
  });
  return {
    ...report,
    turnoverUsd: result.trades.reduce((sum, trade) => sum + Number(trade.notionalUsd), 0).toFixed(8),
    tradeCount: result.trades.length,
    rejectedOrderCount: result.rejectedOrders.length,
  };
}

/** Seeded mulberry32 PRNG for reproducible Monte Carlo. */
export function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export type MonteCarloResult = {
  seed: number;
  iterations: number;
  sampleSize: number;
  observed: boolean;
  meanFinalEquity: string | null;
  p05: string | null;
  p50: string | null;
  p95: string | null;
  label: "INSUFFICIENT_EVIDENCE" | "SIMULATED";
  finals: string[];
};

/**
 * Resample closed trade PnL sequences with replacement.
 * Does not invent trades — empty sample returns INSUFFICIENT_EVIDENCE.
 */
export function monteCarloResample(input: {
  closedTradePnls: string[];
  startingBalanceUsd: string;
  iterations: number;
  seed: number;
  minSample: number;
}): MonteCarloResult {
  if (input.closedTradePnls.length < input.minSample) {
    return {
      seed: input.seed,
      iterations: input.iterations,
      sampleSize: input.closedTradePnls.length,
      observed: false,
      meanFinalEquity: null,
      p05: null,
      p50: null,
      p95: null,
      label: "INSUFFICIENT_EVIDENCE",
      finals: [],
    };
  }
  const rng = createRng(input.seed);
  const n = input.closedTradePnls.length;
  const finals: number[] = [];
  for (let i = 0; i < input.iterations; i += 1) {
    let equity = Number(input.startingBalanceUsd);
    for (let j = 0; j < n; j += 1) {
      const idx = Math.floor(rng() * n);
      equity += Number(input.closedTradePnls[idx]!);
    }
    finals.push(equity);
  }
  finals.sort((a, b) => a - b);
  const mean = finals.reduce((a, b) => a + b, 0) / finals.length;
  const at = (p: number) => finals[Math.min(finals.length - 1, Math.floor(p * (finals.length - 1)))]!;
  return {
    seed: input.seed,
    iterations: input.iterations,
    sampleSize: n,
    observed: true,
    meanFinalEquity: mean.toFixed(8),
    p05: at(0.05).toFixed(8),
    p50: at(0.5).toFixed(8),
    p95: at(0.95).toFixed(8),
    label: "SIMULATED",
    finals: finals.map((value) => value.toFixed(8)),
  };
}

export function sensitivityAnalysis(input: {
  baselineReturnPct: string | null;
  variants: Array<{ label: string; returnPct: string | null; sampleSize: number }>;
}): {
  baselineReturnPct: string | null;
  variants: Array<{ label: string; returnPct: string | null; sampleSize: number; deltaPct: string | null }>;
  stable: boolean | null;
  label: string;
} {
  if (input.baselineReturnPct === null) {
    return {
      baselineReturnPct: null,
      variants: input.variants.map((variant) => ({ ...variant, deltaPct: null })),
      stable: null,
      label: "INSUFFICIENT_EVIDENCE",
    };
  }
  const variants = input.variants.map((variant) => ({
    ...variant,
    deltaPct:
      variant.returnPct === null
        ? null
        : d(variant.returnPct).minus(d(input.baselineReturnPct!)).toFixed(4),
  }));
  const deltas = variants.map((variant) => variant.deltaPct).filter((value): value is string => value !== null);
  const stable =
    deltas.length === 0 ? null : deltas.every((delta) => d(delta).abs().lte("5"));
  return {
    baselineReturnPct: input.baselineReturnPct,
    variants,
    stable,
    label: stable === null ? "INSUFFICIENT_EVIDENCE" : stable ? "STABLE" : "SENSITIVE",
  };
}
