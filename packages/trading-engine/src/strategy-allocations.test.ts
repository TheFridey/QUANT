import { describe, expect, it } from "vitest";
import {
  allocationVenueDrift,
  maxCloseableAllocationQty,
  netAllocationQty,
} from "./strategy-allocations.js";

describe("strategy allocation settlement helpers", () => {
  it("nets quantities and refuses oversell", () => {
    expect(netAllocationQty([{ qty: "3" }, { qty: "7" }])).toBe("10.00000000");
    expect(maxCloseableAllocationQty({ instanceQty: "3", requestedQty: "7" })).toEqual({
      ok: false,
      reason: "SELL_EXCEEDS_ALLOCATION",
    });
    expect(maxCloseableAllocationQty({ instanceQty: "3", requestedQty: "2" })).toEqual({
      ok: true,
      qty: "2.00000000",
    });
  });

  it("detects venue vs allocation drift without rewriting history", () => {
    expect(
      allocationVenueDrift({
        venueQty: "10",
        allocations: [
          { qty: "3", strategyInstanceId: "A" },
          { qty: "7", strategyInstanceId: "B" },
        ],
      }),
    ).toEqual({ ok: true });
    expect(
      allocationVenueDrift({
        venueQty: "10",
        allocations: [{ qty: "3", strategyInstanceId: "A" }],
      }),
    ).toMatchObject({ ok: false, allocationNet: "3.00000000" });
  });
});
