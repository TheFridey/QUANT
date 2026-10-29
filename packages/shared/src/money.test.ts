import { describe, expect, it } from "vitest";
import { convertToUsd, maxPositionNotionalAtStart } from "./money.js";

describe("FX / monetary helpers", () => {
  it("passes USD through and converts with an explicit rate", () => {
    expect(convertToUsd({ amount: "10", fromCurrency: "USD", usdPerUnit: null })).toEqual({
      ok: true,
      amountUsd: "10.00000000",
    });
    expect(convertToUsd({ amount: "2", fromCurrency: "EUR", usdPerUnit: "1.10" })).toEqual({
      ok: true,
      amountUsd: "2.20000000",
    });
  });

  it("fails closed when the FX rate is missing", () => {
    expect(convertToUsd({ amount: "2", fromCurrency: "EUR", usdPerUnit: null }).ok).toBe(false);
    expect(convertToUsd({ amount: "2", fromCurrency: "JPY", usdPerUnit: "0" }).ok).toBe(false);
  });

  it("computes start-of-day max position headroom after costs", () => {
    const headroom = maxPositionNotionalAtStart({
      startingBalanceUsd: "100.00000000",
      maxPositionPctEquity: "5",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    // 5% of 100 = 5, haircut > 1 → headroom < 5 → legacy deadlock vs minOrder 5
    expect(Number(headroom)).toBeLessThan(5);
  });
});
