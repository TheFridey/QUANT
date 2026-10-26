import { describe, expect, it } from "vitest";
import { d, qty, sumUsd, usd } from "./money.js";

describe("money", () => {
  it("quantizes usd half up and quantity down", () => {
    expect(usd(d("1.005000004"))).toBe("1.00500000");
    expect(qty(d("1.019999999"))).toBe("1.01999999");
  });

  it("rejects non-strings so binary floats cannot enter the ledger", () => {
    expect(() => d(Number("1.1") as unknown as string)).toThrow(/MONEY_STRING_REQUIRED/);
  });

  it("sums quantized usd strings", () => {
    expect(sumUsd(["10.00000000", "-0.25000000", "0.10000000"])).toBe("9.85000000");
  });
});
