import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { evaluateRisk } from "./evaluate.js";

const base = {
  engineStatus: "RUNNING" as const,
  side: "BUY" as const,
  intent: "ENTRY" as const,
  freshness: "LIVE" as const,
  allowDelayedExits: true,
  openPositions: 0,
  maxPositions: DEFAULT_STRATEGY.maxPositions,
  dailyPnlUsd: "0.00000000",
  startingBalanceUsd: "10000.00000000",
  maxDailyLossPct: DEFAULT_STRATEGY.maxDailyLossPct,
  valuation: "CASH_ONLY" as const,
  equityUsd: "10000.00000000",
  highWaterMarkUsd: "10000.00000000",
  maxTotalDrawdownPct: DEFAULT_STRATEGY.maxTotalDrawdownPct,
  aggregateExposureUsd: "0",
  maxAggregateExposurePct: DEFAULT_STRATEGY.maxAggregateExposurePct,
};

describe("operating controls (B25)", () => {
  it("pauseNewEntries blocks buys with PAUSE_NEW_ENTRIES but allows exits", () => {
    const buy = evaluateRisk({ ...base, pauseNewEntries: true });
    expect(buy.decision).toBe("REJECT");
    expect(buy.reasonCodes).toContain("PAUSE_NEW_ENTRIES");
    expect(buy.reasonCodes).not.toContain("ENGINE_HALTED");

    const exit = evaluateRisk({
      ...base,
      side: "SELL",
      intent: "EXIT",
      pauseNewEntries: true,
    });
    expect(exit.decision).toBe("PASS");
  });

  it("entriesSuspended blocks buys with ENTRIES_SUSPENDED; flatten still allowed when RUNNING", () => {
    const buy = evaluateRisk({ ...base, entriesSuspended: true });
    expect(buy.reasonCodes).toContain("ENTRIES_SUSPENDED");

    const flatten = evaluateRisk({
      ...base,
      side: "SELL",
      intent: "FLATTEN",
      entriesSuspended: true,
    });
    expect(flatten.decision).toBe("PASS");
  });

  it("emergency stop rejects entries but allows FLATTEN", () => {
    expect(evaluateRisk({ ...base, engineStatus: "EMERGENCY_STOP" }).decision).toBe("REJECT");
    expect(
      evaluateRisk({
        ...base,
        engineStatus: "EMERGENCY_STOP",
        side: "SELL",
        intent: "FLATTEN",
      }).decision,
    ).toBe("PASS");
  });
});
