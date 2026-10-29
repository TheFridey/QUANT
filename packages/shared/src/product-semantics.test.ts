import { describe, expect, it } from "vitest";
import { findInstrument } from "./instruments.js";
import {
  assertCommoditySemanticsHonest,
  notionalFromProduct,
  productSemanticsFor,
} from "./product-semantics.js";

describe("commodity product semantics", () => {
  it("exposes honest paper proxy multipliers for XAUUSD and WTI", () => {
    const xau = productSemanticsFor("commodity:XAUUSD");
    expect(xau?.executionSupported).toBe(true);
    expect(xau?.currency).toBe("USD");
    expect(xau?.multiplier).toBe("1");
    expect(xau?.notes.toLowerCase()).toContain("not");

    const wti = productSemanticsFor("commodity:WTI");
    expect(wti?.executionSupported).toBe(true);
    expect(wti?.multiplier).toBe("1");
    expect(wti?.notes).toMatch(/CL futures/i);
  });

  it("refuses unknown commodity without inventing futures economics", () => {
    const unknown = productSemanticsFor("commodity:UNKNOWN_FUT");
    expect(unknown?.executionSupported).toBe(false);
    expect(unknown?.unsupportedReason).toBeTruthy();
    const notional = notionalFromProduct({
      price: "70",
      qty: "1",
      semantics: unknown!,
    });
    expect(notional.ok).toBe(false);
  });

  it("computes notional with multiplier for supported proxies", () => {
    const xau = productSemanticsFor("commodity:XAUUSD")!;
    const n = notionalFromProduct({ price: "2650.5", qty: "0.010", semantics: xau });
    expect(n.ok).toBe(true);
    if (n.ok) expect(Number(n.notional)).toBeCloseTo(26.505, 4);
  });

  it("marks indices unsupported for execution", () => {
    const spx = productSemanticsFor("index:SPX");
    expect(spx?.executionSupported).toBe(false);
  });

  it("assertCommoditySemanticsHonest passes seeded commodities", () => {
    const instrument = findInstrument("commodity:XAUUSD")!;
    expect(assertCommoditySemanticsHonest(instrument).ok).toBe(true);
  });
});
