import { describe, expect, it } from "vitest";
import { reconstructBudget } from "./pg-reservations.js";

/**
 * D04 unit contract: reconstructBudget preserves open-book usage and only adds HELD remainders.
 * Uses an in-memory stub — no PostgreSQL required.
 */
describe("reconstructBudget open+HELD semantics (D04)", () => {
  it("adds HELD remainders on top of open exposure/slots/risk and ignores CONSUMED", async () => {
    const caps = {
      cashAvailableUsd: "1000.00000000",
      exposureCapUsd: "5000.00000000",
      exposureUsedUsd: "200.00000000",
      slotsAvailable: 5,
      slotsUsed: 1,
      riskBudgetUsd: "500.00000000",
      riskUsedUsd: "20.00000000",
    };
    const stub = {
      riskReservation: {
        findMany: async () => [
          {
            status: "HELD",
            remainingCashUsd: { toString: () => "100" },
            remainingExposureUsd: { toString: () => "150" },
            remainingRiskUsd: { toString: () => "15" },
            remainingSlots: 1,
          },
          // CONSUMED rows must not be queried; if present they would double-count.
        ],
      },
    };
    const live = await reconstructBudget(stub as never, "primary", caps);
    expect(Number(live.exposureUsedUsd)).toBeCloseTo(350, 4);
    expect(live.slotsUsed).toBe(2);
    expect(Number(live.riskUsedUsd)).toBeCloseTo(35, 4);
    expect(Number(live.cashAvailableUsd)).toBeCloseTo(900, 4);
    expect(live.slotsAvailable).toBe(5);
  });

  it("does not wipe open usage when there are no reservations", async () => {
    const caps = {
      cashAvailableUsd: "1000.00000000",
      exposureCapUsd: "5000.00000000",
      exposureUsedUsd: "400.00000000",
      slotsAvailable: 5,
      slotsUsed: 2,
      riskBudgetUsd: "500.00000000",
      riskUsedUsd: "40.00000000",
    };
    const stub = {
      riskReservation: {
        findMany: async (args: { where: { status: string } }) => {
          expect(args.where.status).toBe("HELD");
          return [];
        },
      },
    };
    const live = await reconstructBudget(stub as never, "primary", caps);
    expect(Number(live.exposureUsedUsd)).toBeCloseTo(400, 4);
    expect(live.slotsUsed).toBe(2);
    expect(Number(live.riskUsedUsd)).toBeCloseTo(40, 4);
  });
});
