import { describe, expect, it } from "vitest";
import { computeAccountValuation } from "./account-valuation.js";

describe("§17 account valuation", () => {
  it("separates cash, equity, reserved, stop-risk, unprotected, and PnL", () => {
    const snap = computeAccountValuation({
      cashUsd: "9000",
      reservedUsd: "500",
      realizedPnlUsd: "25",
      positions: [
        {
          instrumentId: "etf:SPY",
          qty: "2",
          avgCostUsd: "500",
          markUsd: "520",
          stopRiskUsd: "40",
          protected: true,
          productFamily: "etf",
        },
        {
          instrumentId: "fx:EURUSD",
          qty: "1000",
          avgCostUsd: "1.08",
          markUsd: "1.10",
          protected: false,
          productFamily: "fx",
        },
      ],
    });
    expect(snap.cashUsd).toBe("9000.00000000");
    expect(snap.reservedUsd).toBe("500.00000000");
    expect(snap.buyingPowerUsd).toBe("8500.00000000");
    expect(snap.stopRiskUsd).toBe("40.00000000");
    expect(d(snap.unprotectedQtyNotionalUsd)).toBeGreaterThan(0);
    expect(snap.valuationComplete).toBe(true);
    expect(snap.equityUsd).not.toBeNull();
  });

  it("does not invent stop risk from a global percent when distance unknown", () => {
    const snap = computeAccountValuation({
      cashUsd: "10000",
      positions: [
        {
          instrumentId: "solana:x",
          qty: "1",
          avgCostUsd: "10",
          markUsd: "12",
          protected: false,
          productFamily: "spot_crypto",
        },
      ],
    });
    expect(snap.stopRiskUsd).toBe("0.00000000");
    expect(snap.limitations.some((l) => l.includes("stop distance unknown"))).toBe(true);
  });
});

function d(value: string): number {
  return Number(value);
}
