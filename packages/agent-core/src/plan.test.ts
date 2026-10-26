import { DEFAULT_STRATEGY, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { planCycle, type PlanInput } from "./plan.js";

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

function pair(overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress,
    dexId: "orca",
    url: null,
    baseAddress: "So11111111111111111111111111111111111111112",
    baseSymbol: "SOL",
    baseName: "Wrapped SOL",
    quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteSymbol: "USDC",
    priceUsd: "100",
    liquidityUsd: "1000000",
    volume24hUsd: "5000000",
    volume5mUsd: "10000",
    priceChangeM5Pct: "3.5",
    priceChangeH1Pct: "1.2",
    priceChangeH24Pct: "4",
    txnsM5Buys: 80,
    txnsM5Sells: 20,
    observationId: "obs_1",
    freshness: "LIVE",
    receivedAt: "2026-10-26T16:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  const quote = pair();
  return {
    cycleId: "cyc_test",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: "100.00000000",
    startingBalanceUsd: "100.00000000",
    positions: [],
    pairs: [quote],
    marks: { [pairAddress]: { priceUsd: quote.priceUsd, freshness: "LIVE" } },
    dailyPnlUsd: "0.00000000",
    flatten: false,
    operator: null,
    ...overrides,
  };
}

describe("agent plan", () => {
  it("proposes one paper entry when momentum and risk both pass", () => {
    const plan = planCycle(input());
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]?.side).toBe("BUY");
    expect(plan.orders[0]?.qty).toBe("0.25000000");
    expect(plan.decisions.some((decision) => decision.agent === "ARCHIVIST" && decision.reasonCodes.includes("AUDIT_RECORDED"))).toBe(true);
    expect(plan.decisions.find((decision) => decision.agent === "EXECUTOR")?.output.venue).toBe("PAPER");
  });

  it("does not trade when the price is missing or the engine is paused", () => {
    expect(planCycle(input({ pairs: [pair({ priceUsd: null })], marks: {} })).orders).toHaveLength(0);
    expect(planCycle(input({ engineStatus: "PAUSED" })).orders).toHaveLength(0);
    const stale = planCycle(input({ pairs: [pair({ freshness: "STALE" })] }));
    expect(stale.orders).toHaveLength(0);
    expect(stale.decisions.some((decision) => decision.reasonCodes.includes("DATA_STALE"))).toBe(true);
  });

  it("closes a position on the stop without inventing a second entry", () => {
    const plan = planCycle(
      input({
        cashUsd: "75.00000000",
        positions: [
          {
            pairAddress,
            baseSymbol: "SOL",
            baseQty: "0.25000000",
            avgCostUsd: "100.00000000",
            realizedPnlUsd: "0.00000000",
          },
        ],
        pairs: [pair({ priceUsd: "90", priceChangeM5Pct: "0.1", priceChangeH1Pct: "0.1" })],
        marks: { [pairAddress]: { priceUsd: "90", freshness: "LIVE" } },
      }),
    );
    expect(plan.orders.map((order) => order.side)).toEqual(["SELL"]);
    expect(plan.orders[0]?.intent).toBe("EXIT");
  });

  it("does not open risk on an anomalous print or an unlisted quote mint", () => {
    const spike = planCycle(input({ pairs: [pair({ priceChangeM5Pct: "8090" })] }));
    expect(spike.orders).toHaveLength(0);
    expect(spike.decisions.some((decision) => decision.reasonCodes.includes("PRICE_ANOMALY"))).toBe(true);
    const exotic = planCycle(
      input({
        pairs: [pair({ quoteAddress: "11111111111111111111111111111111exotic", quoteSymbol: "AMD" })],
      }),
    );
    expect(exotic.orders).toHaveLength(0);
    expect(exotic.decisions.some((decision) => decision.reasonCodes.includes("QUOTE_NOT_ALLOWED"))).toBe(true);
    const held = planCycle(
      input({
        cashUsd: "75.00000000",
        positions: [
          {
            pairAddress,
            baseSymbol: "SOL",
            baseQty: "0.25000000",
            avgCostUsd: "100.00000000",
            realizedPnlUsd: "0.00000000",
          },
        ],
        pairs: [pair({ priceUsd: "90", priceChangeM5Pct: "8090", quoteAddress: "11111111111111111111111111111111exotic" })],
        marks: { [pairAddress]: { priceUsd: "90", freshness: "LIVE" } },
      }),
    );
    expect(held.orders.map((order) => order.intent)).toEqual(["EXIT"]);
  });

  it("labels an operator ticket as an override and still rejects it above the cap", () => {
    const allowed = planCycle(
      input({
        pairs: [pair({ priceChangeM5Pct: "0", txnsM5Buys: 1, txnsM5Sells: 9 })],
        operator: { side: "BUY", pairAddress, notionalUsd: "10" },
      }),
    );
    expect(allowed.orders).toHaveLength(1);
    expect(allowed.decisions.some((decision) => decision.reasonCodes.includes("OPERATOR_OVERRIDE"))).toBe(true);
    const blocked = planCycle(
      input({
        operator: { side: "BUY", pairAddress, notionalUsd: "90" },
      }),
    );
    expect(blocked.orders).toHaveLength(0);
    expect(blocked.decisions.some((decision) => decision.reasonCodes.includes("SIZE_ABOVE_CAP"))).toBe(true);
  });
});
