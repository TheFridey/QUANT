import { describe, expect, it } from "vitest";
import { findEligibleFillObservation } from "./eligible-observation.js";

/**
 * Unit contract: selection prefers same-instrument events at/after eligibility.
 * Integration coverage lives in store.pending-fill.integration.test.ts when DB is available.
 */
describe("eligible fill observation (R04)", () => {
  it("exports a finder used by settlePendingOrder", () => {
    expect(findEligibleFillObservation).toEqual(expect.any(Function));
  });

  it("returns null from an empty stub db when no rows match", async () => {
    const stub = {
      marketObservation: {
        findFirst: async () => null,
      },
    };
    const eligibleAt = new Date("2026-10-29T12:00:00.000Z");
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      tradingEnvironment: "MARKET_DATA_PAPER",
    });
    expect(found).toBeNull();
  });

  it("returns the first at-or-after eligibility observation from the stub", async () => {
    const eligibleAt = new Date("2026-10-29T12:00:00.000Z");
    const decision = {
      id: "obs_decision",
      pairAddress: "pair_a",
      priceUsd: { toString: () => "100" },
      liquidityUsd: { toString: () => "1000000" },
      freshness: "LIVE",
      receivedAt: new Date("2026-10-29T11:59:00.000Z"),
      eventTime: null,
      dataOrigin: "LIVE_FEED",
      tradingEnvironment: "MARKET_DATA_PAPER",
    };
    const fill = {
      id: "obs_fill",
      pairAddress: "pair_a",
      priceUsd: { toString: () => "101.5" },
      liquidityUsd: { toString: () => "1000000" },
      freshness: "LIVE",
      receivedAt: new Date("2026-10-29T12:00:05.000Z"),
      eventTime: null,
      dataOrigin: "LIVE_FEED",
      tradingEnvironment: "MARKET_DATA_PAPER",
    };
    const stub = {
      marketObservation: {
        findFirst: async (args: { where: { receivedAt?: { gte: Date } } }) => {
          if (args.where.receivedAt?.gte?.getTime() === eligibleAt.getTime()) return fill;
          return decision;
        },
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      tradingEnvironment: "MARKET_DATA_PAPER",
    });
    expect(found?.id).toBe("obs_fill");
    expect(found?.priceUsd?.toString()).toBe("101.5");
    expect(found?.id).not.toBe(decision.id);
  });
});
