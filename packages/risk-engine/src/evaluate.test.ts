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
  startingBalanceUsd: "100.00000000",
  maxDailyLossPct: "10",
  valuation: "CASH_ONLY" as const,
};

describe("risk gate", () => {
  it("rejects stale data, missing daily p&l, and a halted engine", () => {
    expect(evaluateRisk({ ...base, freshness: "STALE" }).reasonCodes).toContain("DATA_STALE");
    expect(evaluateRisk({ ...base, dailyPnlUsd: null }).reasonCodes).toContain("DAILY_PNL_UNAVAILABLE");
    expect(evaluateRisk({ ...base, engineStatus: "PAUSED" }).reasonCodes).toContain("ENGINE_HALTED");
    expect(evaluateRisk({ ...base, valuation: "INCOMPLETE" }).reasonCodes).toContain("MARK_UNAVAILABLE");
  });

  it("blocks entries at the daily loss limit and allows a delayed exit", () => {
    expect(evaluateRisk({ ...base, dailyPnlUsd: "-10.00000000" }).reasonCodes).toContain("DAILY_LOSS_LIMIT");
    const exit = evaluateRisk({
      ...base,
      side: "SELL",
      intent: "EXIT",
      freshness: "DELAYED",
      dailyPnlUsd: "-10.00000000",
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
});
