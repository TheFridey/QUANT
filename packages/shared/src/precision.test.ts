import { describe, expect, it } from "vitest";
import { SEED_INSTRUMENTS } from "./instruments.js";
import { contractMultiplier, instrumentPrecision, notionalInQuote, roundPriceToTick, roundQtyToLot, stepDecimals } from "./precision.js";

const byId = (id: string) => SEED_INSTRUMENTS.find((i) => i.id === id)!;

describe("roundPriceToTick", () => {
  it("rounds to the nearest tick using registry tick sizes", () => {
    expect(roundPriceToTick("1.083456", byId("fx:EURUSD").tickSize)).toEqual({ ok: true, price: "1.08346" });
    expect(roundPriceToTick("151.2345", byId("fx:USDJPY").tickSize)).toEqual({ ok: true, price: "151.235" });
    expect(roundPriceToTick("512.345", byId("etf:SPY").tickSize)).toEqual({ ok: true, price: "512.35" });
  });

  it("rounds exact half ticks away from zero for NEAREST", () => {
    expect(roundPriceToTick("1.000005", "0.00001")).toEqual({ ok: true, price: "1.00001" });
  });

  it("supports DOWN and UP for conservative sides", () => {
    expect(roundPriceToTick("512.349", "0.01", "DOWN")).toEqual({ ok: true, price: "512.34" });
    expect(roundPriceToTick("512.341", "0.01", "UP")).toEqual({ ok: true, price: "512.35" });
    expect(roundPriceToTick("512.34", "0.01", "UP")).toEqual({ ok: true, price: "512.34" });
  });

  it("handles non-decimal ticks such as 0.25", () => {
    expect(roundPriceToTick("4500.37", "0.25")).toEqual({ ok: true, price: "4500.25" });
    expect(roundPriceToTick("4500.38", "0.25")).toEqual({ ok: true, price: "4500.50" });
  });

  it("refuses invalid ticks and prices, and never rounds a price to zero", () => {
    expect(roundPriceToTick("1", "0")).toEqual({ ok: false, reason: "INVALID_TICK_SIZE" });
    expect(roundPriceToTick("-1", "0.01")).toEqual({ ok: false, reason: "INVALID_PRICE" });
    expect(roundPriceToTick("x", "0.01")).toEqual({ ok: false, reason: "INVALID_PRICE" });
    expect(roundPriceToTick("0.004", "0.01")).toEqual({ ok: false, reason: "INVALID_PRICE" });
    expect(roundPriceToTick("0.004", "0.01", "UP")).toEqual({ ok: true, price: "0.01" });
  });
});

describe("roundQtyToLot", () => {
  it("always rounds down to whole lots", () => {
    expect(roundQtyToLot("1.239", "0.01")).toEqual({ ok: true, qty: "1.23", lots: "123" });
    expect(roundQtyToLot("1.23", "0.01")).toEqual({ ok: true, qty: "1.23", lots: "123" });
    expect(roundQtyToLot("10.9999", "1")).toEqual({ ok: true, qty: "10", lots: "10" });
  });

  it("refuses quantities that round below one lot or below an explicit minimum", () => {
    expect(roundQtyToLot("0.009", "0.01")).toEqual({ ok: false, reason: "BELOW_MINIMUM_QTY" });
    expect(roundQtyToLot("0.5", "0.01", "1")).toEqual({ ok: false, reason: "BELOW_MINIMUM_QTY" });
    expect(roundQtyToLot("1", "0.01", "1")).toEqual({ ok: true, qty: "1.00", lots: "100" });
  });

  it("refuses non-positive, invalid quantities and lot sizes", () => {
    expect(roundQtyToLot("0", "0.01")).toEqual({ ok: false, reason: "NON_POSITIVE_QTY" });
    expect(roundQtyToLot("-1", "0.01")).toEqual({ ok: false, reason: "NON_POSITIVE_QTY" });
    expect(roundQtyToLot("abc", "0.01")).toEqual({ ok: false, reason: "INVALID_QTY" });
    expect(roundQtyToLot("1", "0")).toEqual({ ok: false, reason: "INVALID_LOT_SIZE" });
    expect(roundQtyToLot("1", "0.01", "0")).toEqual({ ok: false, reason: "INVALID_LOT_SIZE" });
  });
});

describe("contract multipliers and notional", () => {
  it("defaults every registry instrument to 1 and honours explicit overrides", () => {
    for (const instrument of SEED_INSTRUMENTS) expect(contractMultiplier(instrument)).toBe("1");
    expect(contractMultiplier(byId("commodity:WTI"), { "commodity:WTI": "1000" })).toBe("1000");
    expect(() => contractMultiplier(byId("commodity:WTI"), { "commodity:WTI": "0" })).toThrow("INVALID_CONTRACT_MULTIPLIER");
  });

  it("computes notional in quote currency", () => {
    expect(notionalInQuote({ qty: "2", price: "70.5", multiplier: "1000" })).toBe("141000");
    expect(notionalInQuote({ qty: "10000", price: "151.5" })).toBe("1515000");
  });

  it("summarises registry precision", () => {
    expect(stepDecimals("0.00001")).toBe(5);
    expect(stepDecimals("1")).toBe(0);
    expect(instrumentPrecision(byId("fx:USDJPY"))).toEqual({ tickSize: "0.001", lotSize: "0.01", priceDecimals: 3, qtyDecimals: 2, minQty: "0.01", multiplier: "1" });
  });
});
