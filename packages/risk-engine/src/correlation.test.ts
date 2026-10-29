import { describe, expect, it } from "vitest";
import { DEFAULT_CORRELATION_GROUPS, evaluateCorrelationBudget } from "./correlation.js";

describe("correlation budgeting", () => {
  it("rejects a second FX add that would breach the majors group cap", () => {
    const result = evaluateCorrelationBudget({
      equityUsd: "10000.00000000",
      groups: DEFAULT_CORRELATION_GROUPS,
      openNotionals: { "fx:EURUSD": "1200.00000000" },
      proposedInstrumentId: "fx:GBPUSD",
      proposedNotionalUsd: "500.00000000",
    });
    // 15% of 10k = 1500; 1200+500 = 1700 → breach
    expect(result.ok).toBe(false);
    expect(result.breaches[0]?.groupId).toBe("fx-majors");
  });

  it("allows ETF adds within the equity group budget", () => {
    const result = evaluateCorrelationBudget({
      equityUsd: "10000.00000000",
      groups: DEFAULT_CORRELATION_GROUPS,
      openNotionals: { "etf:SPY": "500.00000000" },
      proposedInstrumentId: "etf:QQQ",
      proposedNotionalUsd: "500.00000000",
    });
    expect(result.ok).toBe(true);
  });
});
