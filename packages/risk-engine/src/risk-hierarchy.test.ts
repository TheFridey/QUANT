import { describe, expect, it } from "vitest";
import {
  alertAckClearsControl,
  evaluateRiskHierarchy,
  RISK_CONTROL_RANKS,
} from "./risk-hierarchy.js";
import { evaluateCircuitBreaker, evaluateRisk } from "./evaluate.js";
import { DEFAULT_STRATEGY } from "@odin/shared";

describe("risk hierarchy / breakers (B26)", () => {
  it("ranks emergency stop above circuit breaker above pause", () => {
    const snap = evaluateRiskHierarchy({
      engineStatus: "EMERGENCY_STOP",
      circuitBreakerOpen: true,
      entriesSuspended: true,
      pauseNewEntries: true,
    });
    expect(snap.dominantHard?.kind).toBe("EMERGENCY_STOP");
    expect(snap.controls[0]?.rank).toBe(RISK_CONTROL_RANKS.EMERGENCY_STOP);
    expect(snap.blocksNewEntries).toBe(true);
    expect(snap.ackDoesNotClear).toContain("CIRCUIT_BREAKER");
    expect(snap.ackDoesNotClear).toContain("ENTRIES_SUSPENDED");
  });

  it("circuit breaker dominates pause when engine is running", () => {
    const snap = evaluateRiskHierarchy({
      engineStatus: "RUNNING",
      circuitBreakerOpen: true,
      circuitBreakerReasons: ["DAILY_LOSS_LIMIT"],
      entriesSuspended: false,
      pauseNewEntries: true,
    });
    expect(snap.dominantHard?.kind).toBe("CIRCUIT_BREAKER");
    expect(snap.dominantHard?.reasonCodes).toContain("DAILY_LOSS_LIMIT");
    expect(alertAckClearsControl("CIRCUIT_BREAKER")).toBe(false);
    expect(alertAckClearsControl("PAUSE_NEW_ENTRIES")).toBe(true);
  });

  it("entries suspended outranks operator pause and is not ACK-cleared", () => {
    const snap = evaluateRiskHierarchy({
      engineStatus: "RUNNING",
      circuitBreakerOpen: false,
      entriesSuspended: true,
      pauseNewEntries: true,
    });
    expect(snap.dominantHard?.kind).toBe("ENTRIES_SUSPENDED");
    expect(alertAckClearsControl("ENTRIES_SUSPENDED")).toBe(false);
  });

  it("composes with evaluateCircuitBreaker + evaluateRisk call path", () => {
    const breaker = evaluateCircuitBreaker({
      dailyPnlUsd: "-5",
      startingBalanceUsd: "100",
      maxDailyLossPct: "3",
      equityUsd: "95",
      highWaterMarkUsd: "100",
      maxTotalDrawdownPct: "10",
    });
    expect(breaker.open).toBe(true);
    const hierarchy = evaluateRiskHierarchy({
      engineStatus: "RUNNING",
      circuitBreakerOpen: breaker.open,
      circuitBreakerReasons: breaker.reasonCodes,
      entriesSuspended: false,
      pauseNewEntries: false,
      dailyLossBreached: true,
    });
    expect(hierarchy.dominantHard?.kind).toBe("CIRCUIT_BREAKER");
    const buy = evaluateRisk({
      engineStatus: "RUNNING",
      side: "BUY",
      intent: "ENTRY",
      freshness: "LIVE",
      allowDelayedExits: true,
      openPositions: 0,
      maxPositions: DEFAULT_STRATEGY.maxPositions,
      dailyPnlUsd: "-5",
      startingBalanceUsd: "100",
      maxDailyLossPct: "3",
      valuation: "CASH_ONLY",
      circuitBreakerOpen: hierarchy.circuitBreakerOpen,
    });
    expect(buy.reasonCodes).toContain("CIRCUIT_BREAKER");
    const sell = evaluateRisk({
      engineStatus: "RUNNING",
      side: "SELL",
      intent: "EXIT",
      freshness: "LIVE",
      allowDelayedExits: true,
      openPositions: 1,
      maxPositions: DEFAULT_STRATEGY.maxPositions,
      dailyPnlUsd: "-5",
      startingBalanceUsd: "100",
      maxDailyLossPct: "3",
      valuation: "LIVE",
      circuitBreakerOpen: hierarchy.circuitBreakerOpen,
    });
    expect(sell.decision).toBe("PASS");
  });
});
