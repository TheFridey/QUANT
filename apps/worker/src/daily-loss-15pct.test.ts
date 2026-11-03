import {
  dailyLossHeadroomUsd,
  dailyLossLimitUsd,
  evaluateCircuitBreaker,
  evaluateRisk,
  type RiskContext,
} from "@odin/risk-engine";
import { DEFAULT_STRATEGY, parseStrategyConfig, rollSessionEquity, startOfLondonDay, strategyPatchSchema } from "@odin/shared";
import { describe, expect, it } from "vitest";

// GENESIS Phase 1: the operator-requested PAPER daily loss limit of 15%, exercised against the
// unchanged risk engine. Figures mirror the production paper account on 3 Nov 2026 (start-of-day
// equity 9093.15159827, so the 15% limit is exactly 1363.9727397405 USD). The protected defaults stay 3% / 10%.
const DAY_START = "9093.15159827";
const LIMIT_15 = "1363.9727397405";

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    engineStatus: "RUNNING",
    side: "BUY",
    intent: "ENTRY",
    freshness: "LIVE",
    allowDelayedExits: true,
    openPositions: 0,
    maxPositions: DEFAULT_STRATEGY.maxPositions,
    dailyPnlUsd: "0.00000000",
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    dayStartEquityUsd: DAY_START,
    worstDailyPnlUsd: "0.00000000",
    maxDailyLossPct: "15",
    valuation: "CASH_ONLY",
    equityUsd: DAY_START,
    // A fresh high-water mark, so total drawdown is not what is being tested unless stated.
    highWaterMarkUsd: DAY_START,
    maxTotalDrawdownPct: DEFAULT_STRATEGY.maxTotalDrawdownPct,
    aggregateExposureUsd: "0",
    maxAggregateExposurePct: DEFAULT_STRATEGY.maxAggregateExposurePct,
    ...overrides,
  };
}

const loss = (usd: string) => `-${usd}`;

describe("15% PAPER daily loss configuration", () => {
  it("is accepted by the operator patch schema and leaves the other risk limits and defaults untouched", () => {
    const patch = strategyPatchSchema.parse({ maxDailyLossPct: "15" });
    const next = parseStrategyConfig({ ...DEFAULT_STRATEGY, ...patch });
    expect(next.maxDailyLossPct).toBe("15");
    expect(next.maxTotalDrawdownPct).toBe(DEFAULT_STRATEGY.maxTotalDrawdownPct);
    expect(next.maxRiskPerTradePct).toBe(DEFAULT_STRATEGY.maxRiskPerTradePct);
    expect(next.maxAggregateExposurePct).toBe(DEFAULT_STRATEGY.maxAggregateExposurePct);
    // The protected defaults are not what the operator changes.
    expect(DEFAULT_STRATEGY.maxDailyLossPct).toBe("3");
    expect(DEFAULT_STRATEGY.maxTotalDrawdownPct).toBe("10");
  });

  it("sizes the limit from start-of-day equity, not the starting balance", () => {
    expect(dailyLossLimitUsd({ startingBalanceUsd: "10000", dayStartEquityUsd: DAY_START, maxDailyLossPct: "15" }).toString()).toBe(LIMIT_15);
  });

  it("admits a BUY just below the limit and rejects exactly at and just above it", () => {
    // Total drawdown is held below 10% here so the daily rule is the one under test.
    const hwm = { highWaterMarkUsd: "20000", maxTotalDrawdownPct: "100" };
    expect(evaluateRisk(ctx({ ...hwm, dailyPnlUsd: loss("1363.97273973"), worstDailyPnlUsd: loss("1363.97273973") })).decision).toBe("PASS");
    expect(evaluateRisk(ctx({ ...hwm, dailyPnlUsd: loss(LIMIT_15), worstDailyPnlUsd: loss(LIMIT_15) })).reasonCodes).toEqual(["DAILY_LOSS_LIMIT"]);
    expect(evaluateRisk(ctx({ ...hwm, dailyPnlUsd: loss("1363.97273975"), worstDailyPnlUsd: loss("1363.97273975") })).reasonCodes).toEqual(["DAILY_LOSS_LIMIT"]);
  });

  it("keeps BUYs blocked for the rest of the London day after a breach, even once equity recovers", () => {
    const recovered = ctx({ dailyPnlUsd: "-10.00000000", worstDailyPnlUsd: loss(LIMIT_15), maxTotalDrawdownPct: "100" });
    expect(evaluateRisk(recovered).reasonCodes).toEqual(["DAILY_LOSS_LIMIT"]);
    expect(dailyLossHeadroomUsd(recovered)).toBe("0.00000000");
  });

  it("does not let an operator resume bypass a latched breach, and still allows risk-reducing exits", () => {
    // Resuming sets the engine back to RUNNING; the latch comes from the persisted session low, not engine status.
    const resumed = ctx({ engineStatus: "RUNNING", dailyPnlUsd: "0.00000000", worstDailyPnlUsd: loss(LIMIT_15) });
    expect(evaluateRisk(resumed).decision).toBe("REJECT");
    expect(evaluateRisk({ ...resumed, side: "SELL", intent: "EXIT" }).decision).toBe("PASS");
    expect(evaluateRisk({ ...resumed, engineStatus: "PAUSED", side: "SELL", intent: "OPERATOR" }).decision).toBe("PASS");
  });

  it("restores the latch from persisted session state after a restart and resets it on the next London day", () => {
    const sessionStartedAt = startOfLondonDay(new Date("2026-11-03T09:00:00Z"));
    const lowAfterBreach = "7729.17885852"; // below DAY_START − LIMIT_15 (7729.1788585295)
    const sameDay = rollSessionEquity({
      now: new Date("2026-11-03T22:00:00Z"),
      sessionStartedAt,
      sessionStartEquityUsd: DAY_START,
      currentEquityUsd: "9000.00000000",
      highWaterMarkUsd: "10106.00207701",
      sessionLowEquityUsd: lowAfterBreach,
      startingBalanceUsd: "10000",
    });
    expect(sameDay.rolled).toBe(false);
    expect(sameDay.worstDailyPnlUsd).toBe("-1363.97273975");
    expect(evaluateRisk(ctx({ dailyPnlUsd: sameDay.dailyPnlUsd, worstDailyPnlUsd: sameDay.worstDailyPnlUsd, maxTotalDrawdownPct: "100" })).reasonCodes).toEqual(["DAILY_LOSS_LIMIT"]);

    const nextDay = rollSessionEquity({
      now: new Date("2026-11-04T00:00:01Z"),
      sessionStartedAt,
      sessionStartEquityUsd: DAY_START,
      currentEquityUsd: "9000.00000000",
      highWaterMarkUsd: "10106.00207701",
      sessionLowEquityUsd: lowAfterBreach,
      startingBalanceUsd: "10000",
    });
    expect(nextDay.rolled).toBe(true);
    expect(nextDay.worstDailyPnlUsd).toBe("0.00000000");
    expect(nextDay.highWaterMarkUsd).toBe("10106.00207701"); // never lowered by the roll
  });

  it("rolls at London midnight across both DST changes", () => {
    // BST: London midnight is 23:00 UTC the previous day.
    expect(startOfLondonDay(new Date("2026-07-01T12:00:00Z")).toISOString()).toBe("2026-06-30T23:00:00.000Z");
    // Clocks go back at 01:00 UTC on 25 Oct 2026, so that day still starts in BST; the next starts in GMT.
    expect(startOfLondonDay(new Date("2026-10-25T12:00:00Z")).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfLondonDay(new Date("2026-10-26T12:00:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    // Clocks go forward at 01:00 UTC on 29 Mar 2026: that day starts in GMT, the next in BST.
    expect(startOfLondonDay(new Date("2026-03-29T12:00:00Z")).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfLondonDay(new Date("2026-03-30T12:00:00Z")).toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("leaves the 10% total drawdown limit independent: it still blocks entries well inside the daily limit", () => {
    // Production on 3 Nov 2026: equity 9093.15159827 against HWM 10106.00207701 is a 10.02% drawdown.
    const production = ctx({ equityUsd: DAY_START, highWaterMarkUsd: "10106.00207701", dailyPnlUsd: "0.00000000" });
    expect(evaluateRisk(production).reasonCodes).toEqual(["TOTAL_DRAWDOWN_LIMIT"]);
    const breaker = evaluateCircuitBreaker({ ...production, maxTotalDrawdownPct: "10", equityUsd: DAY_START, highWaterMarkUsd: "10106.00207701" });
    expect(breaker).toEqual({ open: true, reasonCodes: ["CIRCUIT_BREAKER", "TOTAL_DRAWDOWN_LIMIT"] });
  });

  it("keeps the other independent gates in force at 15%", () => {
    expect(evaluateRisk(ctx({ circuitBreakerOpen: true })).reasonCodes).toEqual(["CIRCUIT_BREAKER"]);
    expect(evaluateRisk(ctx({ engineStatus: "EMERGENCY_STOP" })).reasonCodes).toEqual(["EMERGENCY_STOP"]);
    expect(evaluateRisk(ctx({ freshness: "STALE" })).reasonCodes).toContain("DATA_STALE");
    expect(evaluateRisk(ctx({ openPositions: DEFAULT_STRATEGY.maxPositions })).reasonCodes).toEqual(["MAX_POSITIONS"]);
    expect(evaluateRisk(ctx({ aggregateExposureUsd: "1800", proposedNotionalUsd: "100" })).reasonCodes).toEqual(["AGGREGATE_EXPOSURE"]);
    expect(evaluateRisk(ctx({ dailyPnlUsd: null })).reasonCodes).toEqual(["DAILY_PNL_UNAVAILABLE"]);
  });

  it("caps the headroom one entry may use, so a single admission cannot cross the limit", () => {
    expect(dailyLossHeadroomUsd(ctx({ dailyPnlUsd: "-1000.00000000", worstDailyPnlUsd: "-1000.00000000" }))).toBe("363.97273974"); // 363.9727397405 rounded down
  });
});
