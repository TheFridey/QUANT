import { describe, expect, it } from "vitest";
import {
  assessNetEdge,
  costForecastReport,
  evaluateEdgeRuleOutOfSample,
  forecastRecordFromAutopsy,
  predictRoundTripCost,
  stepVolatilityBps,
  type CostForecastRecord,
  type EdgeRuleTrade,
} from "./execution-intelligence.js";
import { compareExitPolicies, replayExit, type ExitPath } from "./exit-research.js";
import { meanConfidenceInterval, normalQuantile, seededRng, studentTQuantile } from "./stats.js";

const PAIR = "PairAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DEX_DEFAULTS = { feeBps: 30, spreadBpsEstimate: 5 };

describe("stats", () => {
  it("matches reference quantiles", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228, 2);
    expect(studentTQuantile(0.9, 30)).toBeCloseTo(1.310, 2);
  });

  it("refuses an interval from a single observation", () => {
    expect(meanConfidenceInterval([1])).toBeNull();
  });
});

describe("predictRoundTripCost", () => {
  it("reproduces the ASCEND-00 thin-pool cost scale (~$440 in a ~$55k pool)", () => {
    const p = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 440, liquidityUsd: 55_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
    expect(p.model).toBe("DEX_CONSTANT_PRODUCT");
    expect(p.expected.entryImpactBps).toBeCloseTo(160, 0);
    // Forensics measured 123–174 bps slippage per leg and ~3.5% round trip in these pools.
    expect(p.expectedBps).toBeGreaterThan(300);
    expect(p.expectedBps).toBeLessThan(420);
    expect(p.conservativeBps).toBeGreaterThan(p.expectedBps);
  });

  it("deep pools cost far less than thin pools at the same size", () => {
    const thin = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 440, liquidityUsd: 55_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
    const deep = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 440, liquidityUsd: 260_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
    expect(deep.expectedBps).toBeLessThan(thin.expectedBps);
    // GATO forensic: 1.39% per trip in a ~$260k pool.
    expect(deep.expectedBps).toBeGreaterThan(100);
    expect(deep.expectedBps).toBeLessThan(160);
  });

  it("never applies DEX impact to an FX or ETF instrument", () => {
    const fx = predictRoundTripCost({ instrumentId: "fx:EURUSD", notionalUsd: 10_000, liquidityUsd: null, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
    expect(fx.model).toBe("QUOTED_SPREAD_FEE");
    expect(fx.supported).toBe(true);
    expect(fx.expected.entryImpactBps).toBe(0);
    expect(fx.expectedBps).toBeLessThan(10);
  });

  it("refuses a DEX prediction without liquidity instead of assuming a cost", () => {
    const p = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 100, liquidityUsd: null, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
    expect(p.supported).toBe(false);
    expect(p.unsupportedReason).toBe("MISSING_LIQUIDITY");
    expect(p.conservativeBps).toBe(Number.POSITIVE_INFINITY);
  });

  it("adds a latency allowance only to the conservative case, scaled by √latency", () => {
    const one = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 100, liquidityUsd: 1_000_000, ...DEX_DEFAULTS, stepVolatilityBps: 100, latencySteps: 1 });
    const four = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 100, liquidityUsd: 1_000_000, ...DEX_DEFAULTS, stepVolatilityBps: 100, latencySteps: 4 });
    expect(one.expected.latencyAllowanceBps).toBe(0);
    expect(four.conservative.latencyAllowanceBps).toBeCloseTo(2 * one.conservative.latencyAllowanceBps, 6);
  });

  it("a calibration multiplier below 1 never reduces the conservative cost", () => {
    const base = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 100, liquidityUsd: 100_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
    const shrunk = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 100, liquidityUsd: 100_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0, calibrationMultiplier: 0.5 });
    expect(shrunk.conservativeBps).toBe(base.conservativeBps);
  });
});

function forecastRow(i: number, predicted: number, actual: number, liquidityUsd = 60_000): CostForecastRecord {
  return { tradeId: `t${i}`, instrumentId: PAIR, predictedBps: predicted, actualBps: actual, notionalUsd: 440, liquidityUsd, stepVolatilityBps: 150, tokenAgeHours: 3, executionDelaySeconds: 20 };
}

describe("costForecastReport", () => {
  it("detects systematic underestimation and recommends a multiplier above 1", () => {
    const rng = seededRng(7);
    const rows = Array.from({ length: 20 }, (_, i) => forecastRow(i, 300, 360 + (rng() - 0.5) * 20));
    const report = costForecastReport(rows);
    expect(report.overall.verdict).toBe("SYSTEMATIC_UNDERESTIMATION");
    expect(report.recommendedCalibrationMultiplier).toBeGreaterThan(1.15);
    expect(report.byLiquidity.map((g) => g.key)).toEqual(["50k-250k"]);
  });

  it("is INSUFFICIENT_EVIDENCE on a small sample and never relaxes below the worst ratio", () => {
    const report = costForecastReport([forecastRow(1, 100, 150), forecastRow(2, 100, 90)]);
    expect(report.overall.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.recommendedCalibrationMultiplier).toBeCloseTo(1.5, 6);
  });

  it("reports no bias when errors are centred on zero", () => {
    const rows = Array.from({ length: 20 }, (_, i) => forecastRow(i, 300, i % 2 === 0 ? 310 : 290));
    expect(costForecastReport(rows).overall.verdict).toBe("NO_SYSTEMATIC_BIAS");
  });
});

describe("assessNetEdge", () => {
  const deepCost = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 440, liquidityUsd: 260_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });

  it("is advisory and refuses to qualify on too few samples", () => {
    const a = assessNetEdge({ grossReturnSamplesBps: [500, 600, 700], cost: deepCost });
    expect(a.mode).toBe("ADVISORY");
    expect(a.qualifies).toBe(false);
    expect(a.reasons).toContain("MARKET_DATA_INSUFFICIENT");
  });

  it("rejects a mean that barely exceeds cost when the lower bound does not", () => {
    // Mean gross ≈ cost + 20 bps, but the trade-to-trade spread is ±800 bps.
    const rng = seededRng(3);
    const samples = Array.from({ length: 40 }, () => deepCost.expectedBps + 20 + (rng() - 0.5) * 1600);
    const a = assessNetEdge({ grossReturnSamplesBps: samples, cost: deepCost });
    expect(a.qualifies).toBe(false);
    expect(a.reasons).toContain("EXPECTED_EDGE_INSUFFICIENT");
  });

  it("qualifies only when the conservative lower bound survives costs", () => {
    const rng = seededRng(5);
    const samples = Array.from({ length: 60 }, () => 600 + (rng() - 0.5) * 200);
    const a = assessNetEdge({ grossReturnSamplesBps: samples, cost: deepCost });
    expect(a.qualifies).toBe(true);
    expect(a.conservativeNetBps).toBeGreaterThan(0);
  });

  it("flags deteriorating liquidity and a gross mean below cost", () => {
    const a = assessNetEdge({
      grossReturnSamplesBps: Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 50 : 70)),
      cost: deepCost,
      recentLiquidityUsd: [300_000, 280_000, 240_000],
    });
    expect(a.reasons).toEqual(expect.arrayContaining(["LIQUIDITY_DETERIORATING", "COST_EXCEEDS_OPPORTUNITY", "EXPECTED_EDGE_INSUFFICIENT"]));
  });
});

describe("evaluateEdgeRuleOutOfSample", () => {
  const cost = predictRoundTripCost({ instrumentId: PAIR, notionalUsd: 100, liquidityUsd: 1_000_000, ...DEX_DEFAULTS, stepVolatilityBps: null, latencySteps: 0 });
  const t = (at: string, setupKey: string, grossBps: number): EdgeRuleTrade => ({ at, setupKey, grossBps, netBps: grossBps - cost.expectedBps, cost });

  it("refuses overlapping train and test windows (no look-ahead)", () => {
    expect(() => evaluateEdgeRuleOutOfSample({ train: [t("2026-01-02T00:00:00Z", "A", 1)], test: [t("2026-01-01T00:00:00Z", "A", 1)] })).toThrow(/train must end/);
  });

  it("admits the setup with a genuine edge and rejects the one without", () => {
    const train = [
      ...Array.from({ length: 30 }, (_, i) => t(`2026-01-01T00:${String(i).padStart(2, "0")}:00Z`, "GOOD", 400 + (i % 3) * 10)),
      ...Array.from({ length: 30 }, (_, i) => t(`2026-01-01T01:${String(i).padStart(2, "0")}:00Z`, "BAD", (i % 2 === 0 ? -1 : 1) * 300)),
    ];
    const test = [
      ...Array.from({ length: 12 }, (_, i) => t(`2026-02-01T00:${String(i).padStart(2, "0")}:00Z`, "GOOD", 380)),
      ...Array.from({ length: 12 }, (_, i) => t(`2026-02-01T01:${String(i).padStart(2, "0")}:00Z`, "BAD", -50)),
    ];
    const r = evaluateEdgeRuleOutOfSample({ train, test });
    expect(r.admitted.n).toBe(12);
    expect(r.rejected.n).toBe(12);
    expect(r.verdict).toBe("RULE_HELPS");
  });
});

describe("exit research", () => {
  const path = (tradeId: string, mids: number[], vol: number | null = 200): ExitPath => ({ tradeId, mids, preEntryStepVolBps: vol, costBpsAtBaseSize: 140, impactShareOfCost: 0.5 });

  it("stops fill at the observed gap price, not the trigger", () => {
    const o = replayExit({ kind: "FIXED", stopPct: 3, targetPct: 5 }, path("a", [1, 0.85]), 3);
    expect(o?.exitReason).toBe("STOP");
    expect(o?.grossReturnPct).toBeCloseTo(-15, 6);
  });

  it("a wider volatility stop trades smaller so dollar risk never exceeds the fixed policy", () => {
    const o = replayExit({ kind: "VOL_SCALED", stopSigmas: 3, targetSigmas: 5, maxStopPct: 12 }, path("a", [1, 1.01, 1.2]), 3);
    expect(o?.sizeMultiplier).toBeCloseTo(0.5, 6); // 3σ of 2% = 6% stop → half size
    expect(o?.exitReason).toBe("TARGET");
  });

  it("skips volatility-scaled exits without point-in-time volatility", () => {
    const [, vol] = compareExitPolicies({
      fixed: { kind: "FIXED", stopPct: 3, targetPct: 5 },
      candidates: [{ kind: "VOL_SCALED", stopSigmas: 3, targetSigmas: 5, maxStopPct: 12 }],
      paths: [path("a", [1, 1.1], null)],
    });
    expect(vol?.n).toBe(0);
    expect(vol?.skipped).toBe(1);
  });

  it("a trailing stop never loosens below the initial stop and moves to break-even", () => {
    const o = replayExit({ kind: "TRAILING", stopPct: 3, trailPct: 50, breakEvenAtPct: 2 }, path("a", [1, 1.03, 0.999]), 3);
    expect(o?.exitReason).toBe("TRAIL");
    expect(o?.exitStep).toBe(2);
  });

  it("measures one-step volatility from a price path", () => {
    expect(stepVolatilityBps([1, 1])).toBeNull();
    expect(stepVolatilityBps([1, 1.01, 1, 1.01, 1])).toBeGreaterThan(90);
  });
});

describe("forecastRecordFromAutopsy", () => {
  const trip = {
    pairAddress: PAIR, baseSymbol: "TOK", strategyInstanceId: null, openedAt: "2026-10-31T15:44:20Z", closedAt: "2026-10-31T15:45:00Z", holdSeconds: 40,
    entryNotionalUsd: "440", exitNotionalUsd: "430", netPnlUsd: "-25",
    components: { midMoveUsd: "-8", slippageUsd: "13", feesUsd: "2.6" },
    midReturnPct: "-1.8", costPctOfEntry: "3.5", exitOwners: [], exitReasons: [],
    entry: { priceChangeM5Pct: "10", priceChangeH1Pct: "300", liquidityUsd: "55000", pairCreatedAt: null, ageHoursAtEntry: "3" },
    mfePct: null, maePct: null, observationsInTrade: 1, stopOvershootPct: null, flags: [], notRecorded: [],
  } as Parameters<typeof forecastRecordFromAutopsy>[0];

  it("predicts from entry-time liquidity and measures actual slippage + fees in bps", () => {
    const r = forecastRecordFromAutopsy(trip, DEX_DEFAULTS);
    expect(r?.actualBps).toBeCloseTo(354.5, 1);
    expect(r?.predictedBps).toBeGreaterThan(300);
    expect(r?.executionDelaySeconds).toBeNull();
  });

  it("refuses to predict when entry liquidity was not recorded", () => {
    expect(forecastRecordFromAutopsy({ ...trip, entry: { ...trip.entry, liquidityUsd: null } }, DEX_DEFAULTS)).toBeNull();
  });
});
