import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, type StrategyConfig } from "@odin/shared";
import type { BacktestObservation } from "@odin/backtest";
import { assessObservationIntegrity, assertEntryContextHasNoPostTradeLeak } from "./data-integrity.js";
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
  it("names missing liquidity, stale rows, duplicates, market ids, outages, quotes, sessions, survivorship, look-ahead, and leakage", () => {
    const rows = [
      obs({ id: "ok", receivedAt: "2026-01-01T00:00:00.000Z", priceUsd: "1", quoteSymbol: "USDC" }),
      obs({ id: "ok", receivedAt: "2026-01-01T00:00:00.000Z", priceUsd: "1", quoteSymbol: "USDC" }),
      obs({ id: "liq", receivedAt: "2026-01-01T00:00:02.000Z", priceUsd: "1", liquidityUsd: null }),
      obs({ id: "stale", receivedAt: "2026-01-01T00:00:03.000Z", priceUsd: "1", freshness: "STALE" }),
      obs({ id: "out", receivedAt: "2026-01-01T00:00:04.000Z", priceUsd: "1", provenance: "provider-outage" }),
      obs({ id: "eur", receivedAt: "2026-01-01T00:00:05.000Z", priceUsd: "1", quoteSymbol: "EUR" }),
      obs({ id: "noid", receivedAt: "2026-01-01T00:00:06.000Z", priceUsd: "1", pairAddress: "", baseSymbol: "" }),
      obs({ id: "future", receivedAt: "2026-02-01T00:00:00.000Z", priceUsd: "1" }),
      obs({ id: "dead", receivedAt: "2026-01-01T00:00:01.000Z", priceUsd: null, liquidityUsd: null, pairAddress: "dead-pair" }),
    ];
    const report = assessObservationIntegrity(rows, { asOfMs: Date.parse("2026-01-02T00:00:00.000Z"), gapThresholdMs: 1_000 });
    const codes = new Set(report.issues.map((issue) => issue.code));
    for (const code of [
      "DUPLICATE",
      "MISSING_LIQUIDITY",
      "STALE",
      "PROVIDER_OUTAGE",
      "QUOTE_CURRENCY",
      "MARKET_ID",
      "LOOK_AHEAD",
      "INCOMPLETE_SESSION",
      "SURVIVORSHIP",
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
    const leaked = assertEntryContextHasNoPostTradeLeak({ realizedPnlUsd: "1", condition: "m5" });
    expect(leaked.some((issue) => issue.code === "LEAKAGE")).toBe(true);
  });

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

  it("fills a chronological round trip with fees and ignores signal order when timestamps disagree", () => {
    const first = obs({ id: "late", receivedAt: "2026-01-01T00:02:00.000Z", priceUsd: "1.10" });
    const second = obs({ id: "mid", receivedAt: "2026-01-01T00:01:00.000Z", priceUsd: "1.05" });
    const third = obs({ id: "early", receivedAt: "2026-01-01T00:00:00.000Z", priceUsd: "1.00" });
    const result = simulateResearchPath({
      observations: [first, second, third],
      signals: [
        { observationId: "early", intent: "ENTER_LONG" },
        { observationId: "mid", intent: "EXIT_LONG" },
        { observationId: "late", intent: "HOLD" },
      ],
      config,
      initialCashUsd: "1000.00000000",
      latencyMs: 0,
    });
    expect(result.blocked).toBe(false);
    expect(result.fills.map((fill) => fill.side)).toEqual(["BUY", "SELL"]);
    expect(result.fills[0]?.feeUsd).not.toBe("0.00000000");
    expect(result.closedPnls).toHaveLength(1);
    expect(result.fills[0]?.filledAt).toBe("2026-01-01T00:01:00.000Z");
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

describe("walk-forward data and statistics", () => {
  it("reports every statistic when the sample is large enough and withholds them when it is not", () => {
    const closed = Array.from({ length: 30 }, (_, index) => (index % 3 === 0 ? "-1.00000000" : "2.00000000"));
    const equity = ["100.00000000"];
    for (let index = 0; index < 40; index += 1) {
      const prev = Number(equity[index]);
      const next = index % 2 === 0 ? prev * 0.98 : prev * 1.04;
      equity.push(next.toFixed(8));
    }
    const measured = summariseStatistics({
      startingEquityUsd: "100.00000000",
      endingEquityUsd: "130.00000000",
      netProfitUsd: "30.00000000",
      closedPnls: closed,
      equitySeries: equity,
      exposureSeries: Array.from({ length: 30 }, () => "5.00000000"),
      observationSpanMs: 30 * 60_000,
      feeBps: "30",
      alternativeFeeReturns: ["1.00", "0.80"],
      parameterReturns: ["1.20", "1.10"],
    });
    for (const field of [
      "totalReturnPct",
      "netProfitUsd",
      "winRate",
      "averageWinUsd",
      "averageLossUsd",
      "expectancyUsd",
      "profitFactor",
      "maxDrawdownPct",
      "averageExposureUsd",
      "sharpe",
      "sortino",
      "returnVolatility",
      "confidenceInterval95",
      "costSensitivity",
      "parameterStability",
    ] as const) {
      expect(measured[field].status, field).toBe("MEASURED");
      expect(measured[field].value).not.toBeNull();
    }
    expect(measured.sampleSize).toBe(30);

    const tiny = summariseStatistics({
      startingEquityUsd: "100.00000000",
      endingEquityUsd: null,
      netProfitUsd: null,
      closedPnls: [],
      equitySeries: [],
      exposureSeries: [],
      observationSpanMs: null,
      feeBps: null,
      alternativeFeeReturns: null,
      parameterReturns: null,
    });
    for (const field of [
      "totalReturnPct",
      "netProfitUsd",
      "winRate",
      "averageWinUsd",
      "averageLossUsd",
      "expectancyUsd",
      "profitFactor",
      "maxDrawdownPct",
      "averageExposureUsd",
      "sharpe",
      "sortino",
      "returnVolatility",
      "confidenceInterval95",
      "costSensitivity",
      "parameterStability",
    ] as const) {
      expect(tiny[field].status, field).toBe("UNAVAILABLE");
    }
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
