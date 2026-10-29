import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import {
  STRATEGY_LIBRARY,
  evaluatePromotedStrategy,
  findStrategyModule,
} from "./strategy-library.js";

describe("strategy library + promotion mapping", () => {
  it("exposes concurrent strategy modules across asset classes", () => {
    expect(STRATEGY_LIBRARY.length).toBeGreaterThanOrEqual(3);
    expect(findStrategyModule("fx-breakout-v1")?.instrumentIds).toContain("fx:EURUSD");
  });

  it("lets an approved fx-breakout module drive ENTER_LONG on EURUSD", () => {
    const signal = evaluatePromotedStrategy({
      strategyId: "fx-breakout-v1",
      pair: {
        source: "fx_stub",
        chainId: "fx",
        pairAddress: "fx:EURUSD",
        dexId: "fx-paper",
        url: null,
        baseAddress: "EUR",
        baseSymbol: "EURUSD",
        baseName: "Euro / US Dollar",
        quoteAddress: "USD",
        quoteSymbol: "USD",
        priceUsd: "1.085",
        liquidityUsd: "50000000",
        volume24hUsd: "10000000",
        volume5mUsd: "100000",
        priceChangeM5Pct: "2.5",
        priceChangeH1Pct: "1.0",
        priceChangeH24Pct: "1.5",
        txnsM5Buys: null,
        txnsM5Sells: null,
        observationId: "obs_fx",
        freshness: "DEMO",
        receivedAt: "2026-10-28T16:00:00.000Z",
      },
      config: DEFAULT_STRATEGY,
      heldQty: "0",
      history: [],
    });
    expect(signal?.intent).toBe("ENTER_LONG");
    expect(signal?.reasonCodes).toContain("ENTRY_MOMENTUM");
  });

  it("returns null when no promoted strategy id is set (PULSE remains default)", () => {
    expect(
      evaluatePromotedStrategy({
        strategyId: null,
        pair: {
          source: "dexscreener",
          chainId: "solana",
          pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
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
          receivedAt: "2026-10-28T16:00:00.000Z",
        },
        config: DEFAULT_STRATEGY,
        heldQty: "0",
        history: [],
      }),
    ).toBeNull();
  });
});
