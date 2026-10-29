import { DEFAULT_STRATEGY, steppedClock } from "@odin/shared";
import {
  evaluateExitRules,
  protectionPricesFromEntry,
  quoteFill,
  type ExitPositionState,
} from "@odin/trading-engine";
import { describe, expect, it } from "vitest";
import { runBacktest } from "./engine.js";
import type { BacktestObservation } from "./types.js";

function obs(
  at: string,
  price: string,
  overrides: Partial<BacktestObservation> = {},
): BacktestObservation {
  return {
    id: `obs_${at}_${price}`,
    pairAddress: "etf:SPY",
    baseSymbol: "SPY",
    quoteAddress: "USD",
    priceUsd: price,
    liquidityUsd: "500000000",
    volume24hUsd: "100000000",
    volume5mUsd: "1000000",
    priceChangeM5Pct: "1.5",
    priceChangeH1Pct: "1.0",
    txnsM5Buys: 10,
    txnsM5Sells: 4,
    receivedAt: at,
    freshness: "REPLAY",
    ...overrides,
  };
}

describe("backtest/runtime exit parity (C34)", () => {
  const config = {
    ...DEFAULT_STRATEGY,
    stopLossPct: "3",
    takeProfitPct: "5",
    trailingStopPct: "2",
    maxHoldingMs: 60_000,
    feeBps: "1",
    maxSlippageBps: "50",
    spreadBpsEstimate: "2",
    exitM5ChangePct: "-5",
  };

  it("shared stop/target geometry matches runtime protectionPricesFromEntry", () => {
    const prices = protectionPricesFromEntry({
      direction: "LONG",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    expect(prices.stopPriceUsd).toBe("97.00000000");
    expect(prices.takeProfitPriceUsd).toBe("105.00000000");
  });

  it("stop / take-profit / trailing / time rules agree via shared evaluateExitRules", () => {
    const clock = steppedClock("2026-10-28T12:00:00.000Z");
    const position: ExitPositionState = {
      direction: "LONG",
      avgCostUsd: "100",
      openedAt: clock.now().toISOString(),
      extremeMarkUsd: "100",
      qty: "1",
    };

    expect(
      evaluateExitRules({
        markUsd: "96.5",
        markAt: clock.now().toISOString(),
        position,
        config,
      })?.reasonCodes,
    ).toContain("STOP_LOSS");

    expect(
      evaluateExitRules({
        markUsd: "106",
        markAt: clock.now().toISOString(),
        position,
        config,
      })?.reasonCodes,
    ).toContain("TAKE_PROFIT");

    // Extreme 104 → trail stop 101.92; mark 101.9 trips trail without hitting 5% TP.
    const trailPos = { ...position, extremeMarkUsd: "104" };
    expect(
      evaluateExitRules({
        markUsd: "101.9",
        markAt: clock.now().toISOString(),
        position: trailPos,
        config,
      })?.reasonCodes,
    ).toContain("TRAILING_STOP");

    clock.advance(60_001);
    expect(
      evaluateExitRules({
        markUsd: "101",
        markAt: clock.now().toISOString(),
        position,
        config,
      })?.reasonCodes,
    ).toEqual(expect.arrayContaining(["MAX_HOLDING", "TIME_EXIT"]));
  });

  it("fee/spread cost model is market-class aware (no DEX impact on ETF)", () => {
    const fill = quoteFill({
      side: "BUY",
      midPriceUsd: "100",
      quantity: "10",
      liquidityUsd: "1",
      feeBps: "10",
      maxSlippageBps: "50",
      instrumentId: "etf:SPY",
    });
    expect(fill.ok).toBe(true);
    if (fill.ok) {
      expect(Number(fill.fill.impactBps)).toBe(0);
      expect(Number(fill.fill.feeUsd)).toBeGreaterThan(0);
    }
  });

  it("gap-through uses adverse fill price (no invented mid recovery)", () => {
    const fill = quoteFill({
      side: "SELL",
      midPriceUsd: "100",
      quantity: "1",
      liquidityUsd: "1000000",
      feeBps: "1",
      maxSlippageBps: "500",
      instrumentId: "etf:SPY",
      adverseFillPriceUsd: "90",
    });
    expect(fill.ok).toBe(true);
    if (fill.ok) expect(Number(fill.fill.priceUsd)).toBeLessThanOrEqual(90);
  });

  it("pending eligibility honour latency — no look-ahead fill", () => {
    const observations = [
      obs("2026-10-28T12:00:00.000Z", "100", {
        priceChangeM5Pct: "3",
        priceChangeH1Pct: "2",
        txnsM5Buys: 20,
        txnsM5Sells: 5,
      }),
      // Next tick before latency elapses — must not fill yet if latency high
      obs("2026-10-28T12:00:00.050Z", "101"),
      obs("2026-10-28T12:00:01.000Z", "102"),
    ];
    const result = runBacktest(observations, {
      startAt: "2026-10-28T12:00:00.000Z",
      endAt: "2026-10-28T12:00:02.000Z",
      initialBalanceUsd: "10000",
      latencyMs: 500,
      forceLiquidateAtEnd: true,
      config: {
        ...config,
        allowDemoPaperEntries: true,
        minLiquidityUsd: "1",
        minVolume24hUsd: "1",
        entryM5ChangePct: "0.5",
        minH1ChangePct: "0.1",
        maxPositions: 5,
        maxPositionPctEquity: "20",
        minOrderNotionalUsd: "1",
      },
    });
    // First fill eligible only after 500ms from signal → at/after 12:00:00.500
    const firstBuy = result.trades.find((t) => t.side === "BUY");
    if (firstBuy) {
      expect(Date.parse(firstBuy.eventAt)).toBeGreaterThanOrEqual(Date.parse("2026-10-28T12:00:00.500Z"));
    }
  });
});
