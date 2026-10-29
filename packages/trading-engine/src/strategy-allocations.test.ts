import { describe, expect, it } from "vitest";
import {
  allocationVenueDrift,
  distributeProRata,
  maxCloseableAllocationQty,
  netAllocationQty,
} from "./strategy-allocations.js";

describe("allocation ownership helpers", () => {
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

  it("distributeProRata assigns remainder to the largest holder so slices sum to fillQty", () => {
    const slices = distributeProRata(
      [
        { strategyInstanceId: "a", qty: "3" },
        { strategyInstanceId: "b", qty: "7" },
      ],
      "10",
    );
    expect(slices).toHaveLength(2);
    const sum = slices.reduce((s, row) => s + Number(row.qty), 0);
    expect(sum).toBeCloseTo(10, 8);
    // B is largest → gets remainder; A gets floor(3/10*10)=3.
    expect(slices.find((s) => s.strategyInstanceId === "a")?.qty).toBe("3.00000000");
    expect(slices.find((s) => s.strategyInstanceId === "b")?.qty).toBe("7.00000000");
  });

  it("distributeProRata handles awkward fractions without losing dust", () => {
    const slices = distributeProRata(
      [
        { strategyInstanceId: "a", qty: "1" },
        { strategyInstanceId: "b", qty: "1" },
        { strategyInstanceId: "c", qty: "1" },
      ],
      "1",
    );
    const sum = slices.reduce((s, row) => s + Number(row.qty), 0);
    expect(sum).toBeCloseTo(1, 8);
  });

  it("allocationVenueDrift reports under and over attribution", () => {
    expect(
      allocationVenueDrift({
        venueQty: "10",
        allocations: [
          { qty: "3", strategyInstanceId: "a" },
          { qty: "7", strategyInstanceId: "b" },
        ],
      }),
    ).toEqual({ ok: true });
    expect(
      allocationVenueDrift({
        venueQty: "10",
        allocations: [{ qty: "3", strategyInstanceId: "a" }],
      }),
    ).toMatchObject({ ok: false, driftQty: "7.00000000" });
  });
});
