import { describe, expect, it } from "vitest";
import { findEligibleFillObservation } from "./eligible-observation.js";

/**
 * Unit contract: selection prefers same-instrument events at/after eligibility.
 * Integration coverage lives in store.pending-fill.integration.test.ts when DB is available.
 */
describe("eligible fill observation (R04)", () => {
  const eligibleAt = new Date("2026-10-29T12:00:00.000Z");
  const now = new Date("2026-10-29T12:05:00.000Z");

  function baseRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "obs_fill",
      pairAddress: "pair_a",
      priceUsd: { toString: () => "101.5" },
      liquidityUsd: { toString: () => "1000000" },
      freshness: "LIVE",
      receivedAt: new Date("2026-10-29T12:00:05.000Z"),
      eventTime: null as Date | null,
      dataOrigin: "LIVE_FEED",
      tradingEnvironment: "MARKET_DATA_PAPER" as string | null,
      ingestJobId: "cycle_other",
      ...overrides,
    };
  }

  it("exports a finder used by settlePendingOrder", () => {
    expect(findEligibleFillObservation).toEqual(expect.any(Function));
  });

  it("returns null from an empty stub db when no rows match", async () => {
    const stub = {
      marketObservation: {
        findFirst: async () => null,
        findMany: async () => [],
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      now,
      tradingEnvironment: "MARKET_DATA_PAPER",
      allowNullEnvironment: false,
    });
    expect(found).toBeNull();
  });

  it("returns the first at-or-after eligibility observation from the stub", async () => {
    const decision = baseRow({
      id: "obs_decision",
      receivedAt: new Date("2026-10-29T11:59:00.000Z"),
      priceUsd: { toString: () => "100" },
    });
    const fill = baseRow();
    const stub = {
      marketObservation: {
        findFirst: async () => null,
        findMany: async () => [fill],
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      now,
      tradingEnvironment: "MARKET_DATA_PAPER",
      allowNullEnvironment: false,
    });
    expect(found?.id).toBe("obs_fill");
    expect(found?.priceUsd?.toString()).toBe("101.5");
    expect(found?.id).not.toBe(decision.id);
  });

  it("rejects old provider event with a new receipt", async () => {
    const oldEventNewReceipt = baseRow({
      id: "obs_stale_event",
      receivedAt: new Date("2026-10-29T12:00:05.000Z"),
      eventTime: new Date("2026-10-29T11:00:00.000Z"),
    });
    const stub = {
      marketObservation: {
        findFirst: async () => null,
        findMany: async () => [oldEventNewReceipt],
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      now,
      tradingEnvironment: "MARKET_DATA_PAPER",
      allowNullEnvironment: false,
    });
    expect(found).toBeNull();
  });

  it("rejects future receipts", async () => {
    const future = baseRow({
      id: "obs_future",
      receivedAt: new Date("2026-10-29T13:00:00.000Z"),
    });
    const stub = {
      marketObservation: {
        findFirst: async () => null,
        findMany: async () => [future],
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      now,
      tradingEnvironment: "MARKET_DATA_PAPER",
      allowNullEnvironment: false,
    });
    expect(found).toBeNull();
  });

  it("uses preferIngestJobId when the preferred row is usable", async () => {
    const preferred = baseRow({
      id: "obs_preferred",
      ingestJobId: "cycle_preferred",
      receivedAt: new Date("2026-10-29T12:00:01.000Z"),
      priceUsd: { toString: () => "99.5" },
    });
    const other = baseRow({
      id: "obs_other",
      ingestJobId: "cycle_other",
      receivedAt: new Date("2026-10-29T12:00:02.000Z"),
    });
    const stub = {
      marketObservation: {
        findFirst: async (args: { where: { ingestJobId?: string } }) => {
          if (args.where.ingestJobId === "cycle_preferred") return preferred;
          return null;
        },
        findMany: async () => [other],
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      now,
      tradingEnvironment: "MARKET_DATA_PAPER",
      preferIngestJobId: "cycle_preferred",
      allowNullEnvironment: false,
    });
    expect(found?.id).toBe("obs_preferred");
  });

  it("does not accept null tradingEnvironment when allowNullEnvironment is false", async () => {
    const nullEnv = baseRow({
      id: "obs_null_env",
      tradingEnvironment: null,
    });
    const stub = {
      marketObservation: {
        findFirst: async () => null,
        findMany: async () => [nullEnv],
      },
    };
    const found = await findEligibleFillObservation(stub as never, {
      pairAddress: "pair_a",
      eligibleAt,
      now,
      tradingEnvironment: "MARKET_DATA_PAPER",
      allowNullEnvironment: false,
    });
    expect(found).toBeNull();
  });
});
