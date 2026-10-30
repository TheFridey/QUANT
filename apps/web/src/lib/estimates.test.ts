import { describe, expect, it } from "vitest";
import { estimateImpactBps, estimateTicket } from "./estimates";

describe("ticket estimates", () => {
  it("uses constant-product impact on the per-side reserve", () => {
    expect(estimateImpactBps("BUY", 1_000, 100_000)).toBeCloseTo(200, 6);
    expect(estimateImpactBps("SELL", 1_000, 100_000)).toBeCloseTo(196.0784, 3);
    expect(estimateImpactBps("BUY", 1_000, null)).toBeNull();
  });

  it("estimates fees, stop risk and post-trade exposure for a buy", () => {
    const estimate = estimateTicket({
      side: "BUY",
      priceUsd: 2,
      qty: 500,
      liquidityUsd: 1_000_000,
      feeBps: 30,
      spreadBps: 0,
      stopLossPct: 3,
      exposureUsd: 4_000,
    });
    expect(estimate.notionalUsd).toBe(1_000);
    expect(estimate.feeUsd).toBeCloseTo(3, 6);
    expect(estimate.stopRiskUsd).toBeGreaterThan(30);
    expect(estimate.postTradeExposureUsd).toBe(5_000);
    expect(estimate.proceedsUsd).toBeNull();
  });

  it("estimates proceeds after fee and impact for a sell", () => {
    const estimate = estimateTicket({
      side: "SELL",
      priceUsd: 1,
      qty: 1_000,
      liquidityUsd: 50_000,
      feeBps: 30,
      spreadBps: 0,
      stopLossPct: 3,
      exposureUsd: 1_000,
    });
    expect(estimate.proceedsUsd).toBeLessThan(1_000 - 3);
    expect(estimate.postTradeExposureUsd).toBe(0);
  });
});
