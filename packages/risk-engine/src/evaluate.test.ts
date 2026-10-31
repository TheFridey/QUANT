import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { dailyLossLimitUsd, evaluateCircuitBreaker, evaluateRisk } from "./evaluate.js";

const base = {
  engineStatus: "RUNNING" as const,
  side: "BUY" as const,
  intent: "ENTRY" as const,
  freshness: "LIVE" as const,
  allowDelayedExits: true,
  openPositions: 0,
  maxPositions: DEFAULT_STRATEGY.maxPositions,
  dailyPnlUsd: "0.00000000",
  startingBalanceUsd: "100.00000000",
  maxDailyLossPct: DEFAULT_STRATEGY.maxDailyLossPct,
  valuation: "CASH_ONLY" as const,
  equityUsd: "100.00000000",
  highWaterMarkUsd: "100.00000000",
  maxTotalDrawdownPct: DEFAULT_STRATEGY.maxTotalDrawdownPct,
  aggregateExposureUsd: "0",
  maxAggregateExposurePct: DEFAULT_STRATEGY.maxAggregateExposurePct,
};

describe("risk gate", () => {
  it("rejects stale data, missing daily p&l, and a halted engine", () => {
    expect(evaluateRisk({ ...base, freshness: "STALE" }).reasonCodes).toContain("DATA_STALE");
    expect(evaluateRisk({ ...base, dailyPnlUsd: null }).reasonCodes).toContain("DAILY_PNL_UNAVAILABLE");
    expect(evaluateRisk({ ...base, engineStatus: "PAUSED" }).reasonCodes).toContain("ENGINE_HALTED");
    expect(evaluateRisk({ ...base, valuation: "INCOMPLETE" }).reasonCodes).toContain("MARK_UNAVAILABLE");
  });

  it("blocks entries at the daily loss limit and allows a delayed exit", () => {
    expect(evaluateRisk({ ...base, dailyPnlUsd: "-3.00000000" }).reasonCodes).toContain("DAILY_LOSS_LIMIT");
    const exit = evaluateRisk({
      ...base,
      side: "SELL",
      intent: "EXIT",
      freshness: "DELAYED",
      dailyPnlUsd: "-3.00000000",
    });
    expect(exit.decision).toBe("PASS");
    expect(exit.reasonCodes).toContain("DATA_DELAYED_EXIT_ALLOWED");
  });

  it("allows flatten only as a risk reduction during an emergency stop", () => {
    expect(evaluateRisk({ ...base, engineStatus: "EMERGENCY_STOP" }).decision).toBe("REJECT");
    expect(
      evaluateRisk({ ...base, engineStatus: "EMERGENCY_STOP", side: "SELL", intent: "FLATTEN" }).decision,
    ).toBe("PASS");
  });

  it("rejects aggregate exposure and total drawdown breaches", () => {
    expect(
      evaluateRisk({
        ...base,
        aggregateExposureUsd: "19",
        proposedNotionalUsd: "5",
      }).reasonCodes,
    ).toContain("AGGREGATE_EXPOSURE");
    expect(
      evaluateRisk({
        ...base,
        equityUsd: "89.00000000",
        highWaterMarkUsd: "100.00000000",
      }).reasonCodes,
    ).toContain("TOTAL_DRAWDOWN_LIMIT");
  });

  it("honours an independent circuit breaker on buys only", () => {
    const buy = evaluateRisk({ ...base, circuitBreakerOpen: true });
    expect(buy.reasonCodes).toContain("CIRCUIT_BREAKER");
    const sell = evaluateRisk({ ...base, side: "SELL", intent: "EXIT", circuitBreakerOpen: true });
    expect(sell.decision).toBe("PASS");
  });
});

describe("circuit breaker", () => {
  it("opens on daily loss or HWM drawdown", () => {
    expect(
      evaluateCircuitBreaker({
        dailyPnlUsd: "-3.00000000",
        startingBalanceUsd: "100",
        maxDailyLossPct: "3",
        equityUsd: "100",
        highWaterMarkUsd: "100",
        maxTotalDrawdownPct: "10",
      }).open,
    ).toBe(true);
    expect(
      evaluateCircuitBreaker({
        dailyPnlUsd: "0",
        startingBalanceUsd: "100",
        maxDailyLossPct: "3",
        equityUsd: "85",
        highWaterMarkUsd: "100",
        maxTotalDrawdownPct: "10",
      }).reasonCodes,
    ).toContain("TOTAL_DRAWDOWN_LIMIT");
  });

  it("measures the daily loss limit against start-of-day equity, not starting balance (audit L3)", () => {
    // Growth day: account grew from $100 to $200. 3% of day-start equity is $6, not $3.
    const grown = { ...base, startingBalanceUsd: "100.00000000", dayStartEquityUsd: "200.00000000", equityUsd: "196.00000000", highWaterMarkUsd: "200.00000000" };
    expect(evaluateRisk({ ...grown, dailyPnlUsd: "-4.00000000" }).reasonCodes).not.toContain("DAILY_LOSS_LIMIT");
    expect(evaluateRisk({ ...grown, dailyPnlUsd: "-6.00000000" }).reasonCodes).toContain("DAILY_LOSS_LIMIT");
    // Drawdown day: account fell from $100 to $50. 3% of day-start equity is $1.50 — tighter than $3.
    const shrunk = { ...base, startingBalanceUsd: "100.00000000", dayStartEquityUsd: "50.00000000", equityUsd: "48.50000000", highWaterMarkUsd: "100.00000000", maxTotalDrawdownPct: "60" };
    expect(evaluateRisk({ ...shrunk, dailyPnlUsd: "-1.50000000" }).reasonCodes).toContain("DAILY_LOSS_LIMIT");
    expect(evaluateRisk({ ...shrunk, dailyPnlUsd: "-1.00000000" }).reasonCodes).not.toContain("DAILY_LOSS_LIMIT");
    const breaker = evaluateCircuitBreaker({
      dailyPnlUsd: "-1.50000000",
      startingBalanceUsd: "100.00000000",
      dayStartEquityUsd: "50.00000000",
      maxDailyLossPct: "3",
      equityUsd: "48.50000000",
      highWaterMarkUsd: "100.00000000",
      maxTotalDrawdownPct: "60",
    });
    expect(breaker.reasonCodes).toContain("DAILY_LOSS_LIMIT");
    expect(dailyLossLimitUsd({ startingBalanceUsd: "100", dayStartEquityUsd: null, maxDailyLossPct: "3" }).toFixed(2)).toBe("3.00");
  });
});
