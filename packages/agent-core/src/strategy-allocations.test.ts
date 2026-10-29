import { describe, expect, it } from "vitest";
import { maxCloseableAllocationQty, netAllocationQty } from "./strategy-allocations.js";

describe("§8 allocation ownership helpers", () => {
  it("nets multiple instance quantities", () => {
    expect(netAllocationQty([{ qty: "1.5" }, { qty: "2.5" }, { qty: "0" }])).toBe("4.00000000");
  });

  it("refuses closing more than the instance owns", () => {
    expect(maxCloseableAllocationQty({ instanceQty: "1", requestedQty: "2" })).toEqual({
      ok: false,
      reason: "SELL_EXCEEDS_ALLOCATION",
    });
    expect(maxCloseableAllocationQty({ instanceQty: "2", requestedQty: "1.5" })).toEqual({
      ok: true,
      qty: "1.50000000",
    });
  });
});
