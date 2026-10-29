import { describe, expect, it } from "vitest";
import {
  assertEntryContextHasNoPostTradeLeak,
  assessObservationIntegrity,
} from "./data-integrity.js";
import type { BacktestObservation } from "@odin/backtest";

function obs(overrides: Partial<BacktestObservation> & Pick<BacktestObservation, "id" | "receivedAt">): BacktestObservation {
  return {
    pairAddress: "pair-a",
    baseSymbol: "SOL",
    quoteAddress: "quote-usdc",
    quoteSymbol: "USDC",
    priceUsd: "100",
    liquidityUsd: "50000",
    volume24hUsd: "100000",
    volume5mUsd: "1000",
    priceChangeM5Pct: "1",
    priceChangeH1Pct: "2",
    txnsM5Buys: 10,
    txnsM5Sells: 4,
    freshness: "REPLAY",
    provenance: "fixture",
    ...overrides,
  };
}

describe("research/eval window data integrity (C36)", () => {
  it("blocks look-ahead and missing market ids inside an eval window", () => {
    const asOfMs = Date.parse("2026-10-28T16:00:00.000Z");
    const result = assessObservationIntegrity(
      [
        obs({ id: "o1", receivedAt: "2026-10-28T15:00:00.000Z" }),
        obs({ id: "o2", receivedAt: "2026-10-28T17:00:00.000Z" }), // after decision clock
        obs({ id: "o3", receivedAt: "2026-10-28T15:30:00.000Z", pairAddress: "", baseSymbol: "" }),
      ],
      { asOfMs },
    );
    expect(result.blocking).toBe(true);
    expect(result.issues.some((i) => i.code === "LOOK_AHEAD")).toBe(true);
    expect(result.issues.some((i) => i.code === "MARKET_ID")).toBe(true);
    expect(result.usable.map((r) => r.id)).toEqual(["o1"]);
  });

  it("warns on duplicates, mixed quotes, and session gaps without inventing fills", () => {
    const rows = [
      obs({ id: "a", receivedAt: "2026-10-28T15:00:00.000Z", quoteSymbol: "USDC" }),
      obs({ id: "a", receivedAt: "2026-10-28T15:00:00.000Z", quoteSymbol: "USDC" }),
      obs({
        id: "b",
        receivedAt: "2026-10-28T18:00:00.000Z",
        quoteSymbol: "USD",
        pairAddress: "pair-b",
        baseSymbol: "EUR",
      }),
    ];
    const result = assessObservationIntegrity(rows, { gapThresholdMs: 60_000 });
    expect(result.issues.some((i) => i.code === "DUPLICATE")).toBe(true);
    expect(result.issues.some((i) => i.code === "QUOTE_CURRENCY")).toBe(true);
    expect(result.blocking).toBe(false);
  });

  it("blocks post-trade leakage into entry reconstruction contexts", () => {
    const leaks = assertEntryContextHasNoPostTradeLeak({
      price: "1",
      exitPrice: "2",
      realizedPnlUsd: "3",
    });
    expect(leaks.some((i) => i.code === "LEAKAGE")).toBe(true);
    expect(leaks.every((i) => i.severity === "block")).toBe(true);
    expect(assertEntryContextHasNoPostTradeLeak({ price: "1", liquidity: "2" })).toEqual([]);
  });
});
