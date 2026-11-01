import { describe, expect, it } from "vitest";
import { admitNotionalAgainstMinOrder, maxEntryNotional } from "./size.js";

describe("sizing admission", () => {
  it("never rounds a risk-sized notional up through the minimum order floor", () => {
    const cap = maxEntryNotional({
      cashUsd: "100.00000000",
      equityUsd: "100.00000000",
      liquidityUsd: "1000000",
      maxPositionPctEquity: "5",
      maxParticipationPctLiquidity: "1",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    expect(Number(cap)).toBeLessThanOrEqual(5);
    const admitted = admitNotionalAgainstMinOrder({
      riskSizedNotionalUsd: cap,
      minOrderNotionalUsd: "5",
    });
    // After fee haircut inside maxEntryNotional cash path, or exact 5 — either reject or equal; never inflate.
    if (!admitted.ok) {
      expect(admitted.reason).toBe("MIN_ORDER_EXCEEDS_RISK_CAP");
    } else {
      expect(Number(admitted.notionalUsd)).toBeLessThanOrEqual(Number(cap));
    }
    const below = admitNotionalAgainstMinOrder({
      riskSizedNotionalUsd: "4.90000000",
      minOrderNotionalUsd: "5",
    });
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.reason).toBe("MIN_ORDER_EXCEEDS_RISK_CAP");
  });

  it("accepts risk-sized notional at or above the minimum", () => {
    const ok = admitNotionalAgainstMinOrder({
      riskSizedNotionalUsd: "25.00000000",
      minOrderNotionalUsd: "25",
    });
    expect(ok).toEqual({ ok: true, notionalUsd: "25.00000000" });
  });
});

describe("daily-loss headroom cap (ASCEND-00 F2)", () => {
  // The 31 Oct HALLOWTRUMP entry: $34.94 of headroom left, default stop/cost settings.
  const entry = {
    cashUsd: "9734.94",
    equityUsd: "9734.94",
    liquidityUsd: "10000000",
    maxPositionPctEquity: "5",
    maxParticipationPctLiquidity: "1",
    feeBps: "30",
    maxSlippageBps: "150",
    maxRiskPerTradePct: "0.5",
    stopLossPct: "3",
    midPriceUsd: "0.0005",
    maxExitImpactBps: "1000",
  };

  it("caps notional so stop loss plus worst entry and exit costs fit the headroom", () => {
    const uncapped = maxEntryNotional(entry);
    const capped = maxEntryNotional({ ...entry, dailyLossHeadroomUsd: "34.94" });
    // Loss per $ = 3% stop + (30 + 150) bps entry + (30 + 1000) bps exit = 15.1%.
    expect(capped).toBe("231.39072847");
    expect(Number(capped)).toBeLessThan(Number(uncapped));
    expect(Number(capped) * 0.151).toBeLessThanOrEqual(34.94);
  });

  it("does not bind when headroom is ample, and sizes to zero when none is left", () => {
    expect(maxEntryNotional({ ...entry, dailyLossHeadroomUsd: "300" })).toBe(maxEntryNotional(entry));
    expect(maxEntryNotional({ ...entry, dailyLossHeadroomUsd: "0" })).toBe("0.00000000");
  });
});
