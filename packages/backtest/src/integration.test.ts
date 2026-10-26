import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY } from "@odin/shared";
import { computeBaselines } from "./baselines.js";
import { runBacktest } from "./engine.js";
import { renderResearchReportHtml } from "./report.js";
import {
  chronologicalSplits,
  evaluateReleaseGates,
  evaluateSampleGates,
  monteCarloResample,
  scoreBacktestResult,
} from "./validation.js";
import type { BacktestObservation } from "./types.js";
import fixture from "./fixtures/replay-observations.json";

describe("fixture-backed backtest integration", () => {
  it("replays persisted-style observations without inventing prices", () => {
    const observations = fixture.observations as BacktestObservation[];
    expect(observations.every((row) => row.provenance.startsWith("fixture:"))).toBe(true);

    const startAt = observations[0]!.receivedAt;
    const endAt = observations[observations.length - 1]!.receivedAt;
    const config = {
      ...DEFAULT_STRATEGY,
      minLiquidityUsd: "1000",
      minVolume24hUsd: "1000",
      entryM5ChangePct: "2",
      maxEntryM5ChangePct: "25",
      stopLossPct: "3",
      takeProfitPct: "5",
      feeBps: "30",
      minSampleTrades: 5,
      minObservationSpanMs: 60_000,
      paperLatencyMs: 0,
    };

    const result = runBacktest(observations, {
      startAt,
      endAt,
      initialBalanceUsd: "100.00000000",
      latencyMs: 0,
      forceLiquidateAtEnd: true,
      config,
    });

    // Every fill price must equal an observation mid adjusted by costs — never a free-floating invent.
    for (const trade of result.trades) {
      expect(trade.observationId).toBeTruthy();
      const source = observations.find((row) => row.id === trade.observationId);
      expect(source).toBeDefined();
      expect(source!.priceUsd).not.toBeNull();
      expect(Number(trade.feeUsd)).toBeGreaterThanOrEqual(0);
    }

    const metrics = scoreBacktestResult(result);
    const sampleGate = evaluateSampleGates(result, config);
    const splits = chronologicalSplits(startAt, endAt);
    const oos = runBacktest(observations, {
      startAt: splits.testStart,
      endAt: splits.testEnd,
      initialBalanceUsd: "100.00000000",
      latencyMs: 0,
      forceLiquidateAtEnd: true,
      config,
    });
    const oosMetrics = scoreBacktestResult(oos);
    const releaseGate = evaluateReleaseGates({
      config,
      sampleGate,
      oosSampleSize: oosMetrics.sampleSize,
      oosMaxDrawdownPct: oosMetrics.maxDrawdownPct,
      oosReturnPct: oosMetrics.returnPct,
    });
    expect(releaseGate.realMoneyGraduation).toBe(false);
    expect(releaseGate.requiresForwardPaper).toBe(true);
    expect(releaseGate.passed).toBe(false);

    const baselines = computeBaselines({
      observations,
      initialBalanceUsd: "100.00000000",
      strategy: result,
      startAt,
      endAt,
    });
    expect(baselines.map((b) => b.name)).toEqual([
      "no_trade_cash",
      "buy_and_hold",
      "simple_momentum_rule",
    ]);

    const mc = monteCarloResample({
      closedTradePnls: result.closedTradePnls,
      startingBalanceUsd: "100.00000000",
      iterations: 100,
      seed: 7,
      minSample: 3,
    });

    const html = renderResearchReportHtml({
      runId: "btrun_fixture",
      generatedAt: "2024-01-01T12:00:00.000Z",
      strategyName: "fixture",
      strategyVersion: 1,
      result,
      metrics,
      baselines,
      sampleGate,
      releaseGate,
      monteCarlo: mc,
    });
    expect(html).toContain("SIMULATION RESULTS");
    expect(html).toContain("NOT_RELEASE_READY");
    expect(html).toContain("no_trade_cash");
    expect(result.dataQuality.inactivePairs.length + result.dataQuality.pairCount).toBeGreaterThan(0);
  });
});
