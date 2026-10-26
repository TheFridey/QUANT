import { describe, expect, it } from "vitest";
import { performanceReport, valuePortfolio } from "./performance.js";

describe("portfolio valuation", () => {
  it("does not invent equity when a mark is missing", () => {
    const valuation = valuePortfolio({
      cashUsd: "80.00000000",
      positions: [
        {
          pairAddress: "PAIR",
          baseSymbol: "SOL",
          baseQty: "0.20000000",
          avgCostUsd: "100.00000000",
          realizedPnlUsd: "0.00000000",
        },
      ],
      marks: {},
    });
    expect(valuation.equityUsd).toBeNull();
    expect(valuation.unrealizedPnlUsd).toBeNull();
    expect(valuation.valuation).toBe("INCOMPLETE");
    expect(valuation.positions[0]?.markState).toBe("MISSING");
  });

  it("marks a live book from the stored price and leaves win rate undefined with no closes", () => {
    const valuation = valuePortfolio({
      cashUsd: "75.00000000",
      positions: [
        {
          pairAddress: "PAIR",
          baseSymbol: "SOL",
          baseQty: "0.25000000",
          avgCostUsd: "100.00000000",
          realizedPnlUsd: "1.50000000",
        },
      ],
      marks: { PAIR: { priceUsd: "110", freshness: "LIVE" } },
    });
    expect(valuation.valuation).toBe("LIVE");
    expect(valuation.equityUsd).toBe("102.50000000");
    expect(valuation.positions[0]?.unrealizedPnlUsd).toBe("2.50000000");
    const report = performanceReport({
      valuation,
      startingBalanceUsd: "100",
      feesUsd: "0.10000000",
      closedTradePnlUsd: [],
    });
    expect(report.winRate).toBeNull();
    expect(report.returnPct).toBe("2.5000");
  });

  it("labels a stale mark instead of calling the book live", () => {
    const valuation = valuePortfolio({
      cashUsd: "100.00000000",
      positions: [
        {
          pairAddress: "PAIR",
          baseSymbol: "SOL",
          baseQty: "1.00000000",
          avgCostUsd: "10.00000000",
          realizedPnlUsd: "0.00000000",
        },
      ],
      marks: { PAIR: { priceUsd: "11", freshness: "STALE" } },
    });
    expect(valuation.valuation).toBe("STALE");
    expect(valuation.equityUsd).toBe("111.00000000");
  });
});
