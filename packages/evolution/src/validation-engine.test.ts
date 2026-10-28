import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, type StrategyConfig } from "@odin/shared";
import type { BacktestObservation } from "@odin/backtest";
import { assessObservationIntegrity } from "./data-integrity.js";
import { classifyResearchOutcomes } from "./outcomes.js";
import { simulateResearchPath } from "./research-backtest.js";
import { summariseStatistics } from "./statistics.js";

const config: StrategyConfig = {
  ...DEFAULT_STRATEGY,
  paperLatencyMs: 0,
  minLiquidityUsd: "100",
  maxSlippageBps: "500",
  maxPriceImpactBps: "500",
  minOrderNotionalUsd: "1",
  maxPositionPctEquity: "20",
  maxParticipationPctLiquidity: "20",
  feeBps: "30",
};

function obs(partial: Partial<BacktestObservation> & { id: string; receivedAt: string; priceUsd: string | null }): BacktestObservation {
  return {
    pairAddress: "pair-a",
    baseSymbol: "AAA",
    quoteAddress: "quote",
    quoteSymbol: "USDC",
    liquidityUsd: "100000",
    volume24hUsd: "100000",
    volume5mUsd: "1000",
    priceChangeM5Pct: "1",
    priceChangeH1Pct: "1",
    txnsM5Buys: 3,
    txnsM5Sells: 1,
    freshness: "LIVE",
    provenance: "fixture:validation",
    ...partial,
  };
}

describe("research outcomes", () => {
  it("keeps a null return out of measurable, statistical, and deployment states", () => {
    const outcomes = classifyResearchOutcomes({
      pipelineFinished: true,
      experimentExecuted: true,
      returnPct: null,
      sampleSize: 40,
      minSampleSize: 30,
      statisticsRecorded: true,
      untouchedTestReturnPct: null,
      untouchedSampleSize: 0,
      tunedOnEvaluationSample: false,
      forwardPaperValidated: false,
      promotionAuthorised: false,
    });
    expect(outcomes.PIPELINE_COMPLETED.met).toBe(true);
    expect(outcomes.EXPERIMENT_EXECUTED.met).toBe(true);
    expect(outcomes.RESULTS_MEASURABLE.met).toBe(false);
    expect(outcomes.STATISTICALLY_EVALUATED.met).toBe(false);
    expect(outcomes.OUT_OF_SAMPLE_VALIDATED.met).toBe(false);
    expect(outcomes.DEPLOYMENT_ELIGIBLE.met).toBe(false);
  });

  it("refuses out-of-sample validation when parameters were fit on the evaluation window", () => {
    const outcomes = classifyResearchOutcomes({
      pipelineFinished: true,
      experimentExecuted: true,
      returnPct: "4",
      sampleSize: 40,
      minSampleSize: 30,
      statisticsRecorded: true,
      untouchedTestReturnPct: "3",
      untouchedSampleSize: 30,
      tunedOnEvaluationSample: true,
      forwardPaperValidated: true,
      promotionAuthorised: true,
    });
    expect(outcomes.OUT_OF_SAMPLE_VALIDATED.met).toBe(false);
    expect(outcomes.DEPLOYMENT_ELIGIBLE.met).toBe(false);
  });
});

describe("data integrity and simulation", () => {
  it("blocks invalid timestamps and does not invent a return", () => {
    const rows = [obs({ id: "bad", receivedAt: "not-a-date", priceUsd: "1" })];
    expect(assessObservationIntegrity(rows).blocking).toBe(true);
    const result = simulateResearchPath({
      observations: rows,
      signals: [{ observationId: "bad", intent: "ENTER_LONG" }],
      config,
      initialCashUsd: "100.00000000",
      latencyMs: 0,
    });
    expect(result.blocked).toBe(true);
    expect(result.returnPct).toBeNull();
    expect(result.fills).toHaveLength(0);
  });

  it("does not invent fills when prices are missing", () => {
    const rows = [
      obs({ id: "a", receivedAt: "2026-01-01T00:00:00.000Z", priceUsd: null, liquidityUsd: null }),
      obs({ id: "b", receivedAt: "2026-01-01T00:01:00.000Z", priceUsd: null, liquidityUsd: null }),
    ];
    const result = simulateResearchPath({
      observations: rows,
      signals: [
        { observationId: "a", intent: "ENTER_LONG" },
        { observationId: "b", intent: "EXIT_LONG" },
      ],
      config,
      initialCashUsd: "100.00000000",
      latencyMs: 0,
    });
    expect(result.fills).toHaveLength(0);
    expect(result.returnPct).toBeNull();
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it("rejects entries the risk gateway rejects", () => {
    const rows = [
      obs({ id: "a", receivedAt: "2026-01-01T00:00:00.000Z", priceUsd: "1", freshness: "DEMO" }),
      obs({ id: "b", receivedAt: "2026-01-01T00:01:00.000Z", priceUsd: "1.1", freshness: "DEMO" }),
    ];
    const result = simulateResearchPath({
      observations: rows,
      signals: [
        { observationId: "a", intent: "ENTER_LONG" },
        { observationId: "b", intent: "EXIT_LONG" },
      ],
      config,
      initialCashUsd: "100.00000000",
      latencyMs: 0,
    });
    expect(result.fills).toHaveLength(0);
    expect(result.rejected.some((row) => row.reason.includes("DATA_DEMO"))).toBe(true);
  });
});

describe("statistics", () => {
  it("marks Sharpe and the confidence interval unavailable on a tiny sample", () => {
    const report = summariseStatistics({
      startingEquityUsd: "100.00000000",
      endingEquityUsd: "101.00000000",
      netProfitUsd: "1.00000000",
      closedPnls: ["1.00000000"],
      equitySeries: ["100.00000000", "101.00000000"],
      exposureSeries: ["5.00000000"],
      observationSpanMs: 60_000,
      feeBps: "30",
      alternativeFeeReturns: null,
      parameterReturns: null,
    });
    expect(report.totalReturnPct.status).toBe("MEASURED");
    expect(report.sharpe.status).toBe("UNAVAILABLE");
    expect(report.sortino.status).toBe("UNAVAILABLE");
    expect(report.confidenceInterval95.status).toBe("UNAVAILABLE");
    expect(report.parameterStability.status).toBe("UNAVAILABLE");
  });
});
