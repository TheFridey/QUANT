import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY } from "@odin/shared";
import { runBacktest } from "./engine.js";
import { reportDataQuality } from "./quality.js";
import {
  createRng,
  evaluateSampleGates,
  monteCarloResample,
} from "./validation.js";
import type { BacktestObservation } from "./types.js";

const SOL = "So11111111111111111111111111111111111111112";
const PAIR_A = "PairAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAIR_B = "PairBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function obs(partial: Partial<BacktestObservation> & Pick<BacktestObservation, "id" | "receivedAt" | "pairAddress">): BacktestObservation {
  return {
    baseSymbol: partial.baseSymbol ?? "TOK",
    quoteAddress: SOL,
    quoteSymbol: "SOL",
    priceUsd: partial.priceUsd ?? "1.00000000",
    liquidityUsd: partial.liquidityUsd ?? "100000.00000000",
    volume24hUsd: partial.volume24hUsd ?? "200000.00000000",
    volume5mUsd: partial.volume5mUsd ?? "5000.00000000",
    priceChangeM5Pct: partial.priceChangeM5Pct ?? "3.0",
    priceChangeH1Pct: partial.priceChangeH1Pct ?? "1.0",
    txnsM5Buys: partial.txnsM5Buys ?? 20,
    txnsM5Sells: partial.txnsM5Sells ?? 5,
    freshness: "REPLAY",
    provenance: "fixture:engine.test",
    ...partial,
  };
}

describe("backtest event ordering and look-ahead", () => {
  it("processes shuffled observations in time order and never fills before latency elapses", () => {
    const rows: BacktestObservation[] = [
      obs({
        id: "3",
        pairAddress: PAIR_A,
        receivedAt: "2024-01-01T00:02:00.000Z",
        priceUsd: "1.05000000",
        priceChangeM5Pct: "-2.0",
      }),
      obs({
        id: "1",
        pairAddress: PAIR_A,
        receivedAt: "2024-01-01T00:00:00.000Z",
        priceUsd: "1.00000000",
        priceChangeM5Pct: "3.0",
      }),
      obs({
        id: "2",
        pairAddress: PAIR_A,
        receivedAt: "2024-01-01T00:01:00.000Z",
        priceUsd: "1.02000000",
        priceChangeM5Pct: "1.0",
        txnsM5Buys: 1,
        txnsM5Sells: 10,
      }),
    ];

    const result = runBacktest(rows, {
      startAt: "2024-01-01T00:00:00.000Z",
      endAt: "2024-01-01T00:05:00.000Z",
      initialBalanceUsd: "100.00000000",
      latencyMs: 60_000,
      forceLiquidateAtEnd: true,
      config: {
        ...DEFAULT_STRATEGY,
        minLiquidityUsd: "1000",
        minVolume24hUsd: "1000",
        paperLatencyMs: 60_000,
        minSampleTrades: 1,
        minObservationSpanMs: 1000,
      },
    });

    // Entry signal at t0; eligible at t0+60s = t1. Fill uses t1 price (1.02), not future t2 (1.05).
    const buy = result.trades.find((trade) => trade.side === "BUY");
    expect(buy).toBeDefined();
    expect(buy!.eventAt).toBe("2024-01-01T00:01:00.000Z");
    expect(Number(buy!.priceUsd)).toBeCloseTo(1.02, 1);
    expect(Number(buy!.priceUsd)).toBeLessThan(1.04);
    // Equity curve timestamps are non-decreasing.
    for (let i = 1; i < result.equityCurve.length; i += 1) {
      expect(Date.parse(result.equityCurve[i]!.at)).toBeGreaterThanOrEqual(
        Date.parse(result.equityCurve[i - 1]!.at),
      );
    }
  });

  it("applies fees so net cash after round trip is below gross mid notional math", () => {
    const rows = [
      obs({
        id: "e1",
        pairAddress: PAIR_A,
        receivedAt: "2024-01-01T00:00:00.000Z",
        priceUsd: "10.00000000",
        priceChangeM5Pct: "3.0",
      }),
      obs({
        id: "e2",
        pairAddress: PAIR_A,
        receivedAt: "2024-01-01T00:01:00.000Z",
        priceUsd: "10.00000000",
        priceChangeM5Pct: "0.0",
        txnsM5Buys: 1,
        txnsM5Sells: 2,
      }),
      obs({
        id: "e3",
        pairAddress: PAIR_A,
        receivedAt: "2024-01-01T00:02:00.000Z",
        priceUsd: "10.00000000",
        priceChangeM5Pct: "-3.0",
      }),
    ];
    const result = runBacktest(rows, {
      startAt: "2024-01-01T00:00:00.000Z",
      endAt: "2024-01-01T00:03:00.000Z",
      initialBalanceUsd: "100.00000000",
      latencyMs: 0,
      forceLiquidateAtEnd: true,
      config: {
        ...DEFAULT_STRATEGY,
        feeBps: "30",
        minLiquidityUsd: "1000",
        minVolume24hUsd: "1000",
        stopLossPct: "50",
        takeProfitPct: "50",
        exitM5ChangePct: "-0.5",
        minSampleTrades: 1,
        minObservationSpanMs: 1000,
      },
    });
    expect(result.trades.length).toBeGreaterThanOrEqual(2);
    expect(Number(result.feesUsd)).toBeGreaterThan(0);
    // Flat mid round-trip with fees must finish below starting cash.
    expect(Number(result.finalCashUsd)).toBeLessThan(100);
  });

  it("reports disappeared and inactive pairs instead of dropping them silently", () => {
    const rows = [
      obs({
        id: "a1",
        pairAddress: PAIR_A,
        baseSymbol: "AAA",
        receivedAt: "2024-01-01T00:00:00.000Z",
      }),
      obs({
        id: "b1",
        pairAddress: PAIR_B,
        baseSymbol: "BBB",
        receivedAt: "2024-01-01T00:00:00.000Z",
        priceUsd: null,
      }),
      obs({
        id: "a2",
        pairAddress: PAIR_A,
        baseSymbol: "AAA",
        receivedAt: "2024-01-01T00:05:00.000Z",
      }),
      // PAIR_B never returns — disappeared relative to window end with gap threshold.
      obs({
        id: "a3",
        pairAddress: PAIR_A,
        baseSymbol: "AAA",
        receivedAt: "2024-01-01T01:00:00.000Z",
      }),
    ];
    const quality = reportDataQuality(rows, { gapThresholdMs: 10 * 60 * 1000 });
    expect(quality.inactivePairs.some((row) => row.pairAddress === PAIR_B)).toBe(true);
    expect(quality.disappearedPairs.some((row) => row.pairAddress === PAIR_B)).toBe(true);
    expect(quality.pairCount).toBe(2);
  });
});

describe("sample gates and monte carlo", () => {
  it("rejects optimisation when sample size is insufficient", () => {
    const empty = runBacktest([], {
      startAt: "2024-01-01T00:00:00.000Z",
      endAt: "2024-01-01T01:00:00.000Z",
      initialBalanceUsd: "100.00000000",
      latencyMs: 0,
      forceLiquidateAtEnd: true,
      config: DEFAULT_STRATEGY,
    });
    const gate = evaluateSampleGates(empty, DEFAULT_STRATEGY);
    expect(gate.passed).toBe(false);
    expect(gate.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("monte carlo is reproducible with the same seed", () => {
    const pnls = ["1.5", "-0.5", "2.0", "-1.0", "0.25", "0.75", "-0.25", "1.1", "-0.8", "0.4"];
    const a = monteCarloResample({
      closedTradePnls: pnls,
      startingBalanceUsd: "100",
      iterations: 200,
      seed: 42,
      minSample: 5,
    });
    const b = monteCarloResample({
      closedTradePnls: pnls,
      startingBalanceUsd: "100",
      iterations: 200,
      seed: 42,
      minSample: 5,
    });
    const c = monteCarloResample({
      closedTradePnls: pnls,
      startingBalanceUsd: "100",
      iterations: 200,
      seed: 99,
      minSample: 5,
    });
    expect(a.label).toBe("SIMULATED");
    expect(a.meanFinalEquity).toBe(b.meanFinalEquity);
    expect(a.p50).toBe(b.p50);
    expect(a.meanFinalEquity).not.toBe(c.meanFinalEquity);
  });

  it("createRng is deterministic", () => {
    const a = createRng(7);
    const b = createRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
