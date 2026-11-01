import { describe, expect, it } from "vitest";
import { autopsyRoundTrip, closedRoundTrips, summariseAutopsies, type AutopsyFill } from "./trade-autopsy.js";

function fill(overrides: Partial<AutopsyFill> & Pick<AutopsyFill, "id" | "side" | "qty" | "priceUsd" | "notionalUsd" | "feeUsd" | "slippageBps" | "createdAt">): AutopsyFill {
  return { observedMidUsd: null, ownerScope: "STRATEGY", reasonCodes: [], strategyInstanceId: "stratinst_primary_crypto", ...overrides };
}

// 31 Oct 15:51:20 SIS round trip from the production ledger: protective stop gapped to -34.70%.
const sisBuy = fill({
  id: "f1", side: "BUY", qty: "757000.50521817", priceUsd: "0.00067703", notionalUsd: "512.51205205",
  feeUsd: "1.53753616", slippageBps: "151.949000", createdAt: "2026-10-31T15:51:20.901Z",
});
const sisSell = fill({
  id: "f2", side: "SELL", qty: "757000.50521817", priceUsd: "0.00043016", notionalUsd: "325.63133732",
  feeUsd: "0.97689401", slippageBps: "122.617700", createdAt: "2026-10-31T15:51:40.932Z",
  ownerScope: "PROTECTION", reasonCodes: ["STOP_LOSS", "COST_ESTIMATED"], strategyInstanceId: null,
});

describe("trade autopsy (ASCEND-00)", () => {
  it("reproduces the production decomposition of the SIS stop-out", () => {
    const autopsy = autopsyRoundTrip({
      pairAddress: "sis",
      baseSymbol: "SIS",
      fills: [sisBuy, sisSell],
      entry: { priceChangeM5Pct: "17.26", priceChangeH1Pct: "1292", liquidityUsd: "67561", pairCreatedAt: "2026-10-31T15:09:00.000Z" },
      observations: [{ receivedAt: "2026-10-31T15:51:40.000Z", priceUsd: "0.00043550" }],
      stopLossPct: "3",
    });
    expect(autopsy.netPnlUsd).toBe("-189.39514490");
    // Matches the forensic query: mid move -$175.17, slippage $11.71, fees $2.51.
    expect(Number(autopsy.components.midMoveUsd)).toBeCloseTo(-175.17, 1);
    expect(Number(autopsy.components.slippageUsd)).toBeCloseTo(11.71, 1);
    expect(autopsy.components.feesUsd).toBe("2.51443017");
    const sum = Number(autopsy.components.midMoveUsd) - Number(autopsy.components.slippageUsd) - Number(autopsy.components.feesUsd);
    expect(sum).toBeCloseTo(Number(autopsy.netPnlUsd), 6);
    expect(Number(autopsy.midReturnPct)).toBeCloseTo(-34.7, 1);
    expect(Number(autopsy.stopOvershootPct)).toBeCloseTo(31.7, 1);
    expect(autopsy.flags).toEqual(expect.arrayContaining(["STOP_OVERSHOOT", "EXIT_ON_FIRST_OBSERVATION", "MID_RECONSTRUCTED"]));
    expect(autopsy.flags).not.toContain("LOSS_FROM_COSTS_ONLY");
    expect(autopsy.exitOwners).toEqual(["PROTECTION"]);
    expect(autopsy.exitReasons).toEqual(["STOP_LOSS"]);
    expect(autopsy.entry.ageHoursAtEntry).toBe("0.71");
    expect(autopsy.holdSeconds).toBe(20);
    expect(autopsy.notRecorded).toContain("decisionToFillLatencyMs");
  });

  it("flags a loss caused by costs alone and prefers the observed mid when present", () => {
    const buy = fill({ id: "b", side: "BUY", qty: "10", priceUsd: "101.5", notionalUsd: "1015", feeUsd: "3.045", slippageBps: "150", createdAt: "2026-11-01T10:00:00.000Z", observedMidUsd: "100" });
    const sell = fill({ id: "s", side: "SELL", qty: "10", priceUsd: "98.5", notionalUsd: "985", feeUsd: "2.955", slippageBps: "150", createdAt: "2026-11-01T10:10:00.000Z", observedMidUsd: "100", reasonCodes: ["EXIT_MOMENTUM"] });
    const autopsy = autopsyRoundTrip({ pairAddress: "x", baseSymbol: "X", fills: [buy, sell], entry: null, observations: [], stopLossPct: "3" });
    expect(autopsy.netPnlUsd).toBe("-36.00000000");
    expect(autopsy.components).toEqual({ midMoveUsd: "0.00000000", slippageUsd: "30.00000000", feesUsd: "6.00000000" });
    expect(autopsy.flags).toEqual(expect.arrayContaining(["LOSS_FROM_COSTS_ONLY", "ENTRY_CONTEXT_MISSING"]));
    expect(autopsy.flags).not.toContain("MID_RECONSTRUCTED");
    expect(autopsy.stopOvershootPct).toBeNull();
    expect(autopsy.mfePct).toBeNull();
  });

  it("measures MFE and MAE only from observations strictly inside the trade", () => {
    const buy = fill({ id: "b", side: "BUY", qty: "1", priceUsd: "100", notionalUsd: "100", feeUsd: "0", slippageBps: "0", createdAt: "2026-11-01T10:00:00.000Z", observedMidUsd: "100" });
    const sell = fill({ id: "s", side: "SELL", qty: "1", priceUsd: "101", notionalUsd: "101", feeUsd: "0", slippageBps: "0", createdAt: "2026-11-01T10:05:00.000Z", observedMidUsd: "101" });
    const autopsy = autopsyRoundTrip({
      pairAddress: "x", baseSymbol: "X", fills: [buy, sell], entry: null, stopLossPct: "3",
      observations: [
        { receivedAt: "2026-11-01T09:59:00.000Z", priceUsd: "150" }, // before entry: ignored
        { receivedAt: "2026-11-01T10:01:00.000Z", priceUsd: "104" },
        { receivedAt: "2026-11-01T10:03:00.000Z", priceUsd: "97" },
        { receivedAt: "2026-11-01T10:06:00.000Z", priceUsd: "50" }, // after exit: ignored
      ],
    });
    expect(autopsy.mfePct).toBe("4.0000");
    expect(autopsy.maePct).toBe("-3.0000");
    expect(autopsy.observationsInTrade).toBe(2);
  });

  it("splits a pair's fills into closed round trips, including partial exits, and ignores an open tail", () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const f = (id: string, side: "BUY" | "SELL", qty: string, minute: number) =>
      fill({ id, side, qty, priceUsd: "1", notionalUsd: qty, feeUsd: "0", slippageBps: "0", createdAt: at(minute) });
    const trips = closedRoundTrips([
      f("orphan", "SELL", "1", 0),
      f("a", "BUY", "10", 1), f("b", "SELL", "4", 2), f("c", "SELL", "6", 3),
      f("d", "BUY", "5", 4), f("e", "SELL", "5", 5),
      f("open", "BUY", "2", 6),
    ]);
    expect(trips.map((trip) => trip.map((item) => item.id))).toEqual([["a", "b", "c"], ["d", "e"]]);
  });

  it("summarises totals with the same decomposition", () => {
    const one = autopsyRoundTrip({ pairAddress: "sis", baseSymbol: "SIS", fills: [sisBuy, sisSell], entry: null, observations: [], stopLossPct: "3" });
    const summary = summariseAutopsies([one, one]);
    expect(summary.trades).toBe(2);
    expect(summary.wins).toBe(0);
    expect(summary.netPnlUsd).toBe("-378.79028980");
  });
});
