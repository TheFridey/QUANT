import { describe, expect, it } from "vitest";
import {
  computeHistoricalDrawdown,
  drawdownBelowHwmPct,
  HISTORICAL_DRAWDOWN_METHOD,
  normaliseHistoricalDrawdown,
} from "./drawdown.js";
import { performanceReport, valuePortfolio } from "./performance.js";

const t0 = Date.UTC(2026, 9, 1);
const at = (i: number) => new Date(t0 + i * 60_000);

describe("historical drawdown (all snapshots)", () => {
  it("finds a drawdown that happens after the first 500 points", () => {
    const points = [
      ...Array.from({ length: 600 }, (_, i) => ({ equityUsd: String(10_000 + i), at: at(i) })),
      { equityUsd: "9000", at: at(600) },
      { equityUsd: "9500", at: at(601) },
    ];
    const result = computeHistoricalDrawdown(points);
    // peak 10599 at i=599, trough 9000 at i=600
    expect(result.maxDrawdownPct).toBe("15.0863");
    expect(result.peakEquityUsd).toBe("10599.00000000");
    expect(result.troughEquityUsd).toBe("9000.00000000");
    expect(result.peakAt).toBe(at(599).toISOString());
    expect(result.troughAt).toBe(at(600).toISOString());
    expect(result.sampleCount).toBe(602);
    expect(result.firstAt).toBe(at(0).toISOString());
    expect(result.lastAt).toBe(at(601).toISOString());
    expect(result.range).toBe("ALL");
    expect(result.method).toBe(HISTORICAL_DRAWDOWN_METHOD);

    // The legacy earliest-500 sample sees a monotonic rise and reports 0.
    const legacy = performanceReport({
      valuation: valuePortfolio({ cashUsd: "9500", positions: [], marks: {} }),
      startingBalanceUsd: "10000",
      feesUsd: "0",
      closedTradePnlUsd: [],
      equitySeries: points.slice(0, 500).map((p) => p.equityUsd),
    });
    expect(legacy.maxDrawdownPct).toBe("0.0000");
  });

  it("keeps the worst of several drawdowns and dates the peak it fell from", () => {
    const result = computeHistoricalDrawdown([
      { equityUsd: "100", at: at(0) },
      { equityUsd: "90", at: at(1) },
      { equityUsd: "120", at: at(2) },
      { equityUsd: "120", at: at(3) },
      { equityUsd: "96", at: at(4) },
      { equityUsd: "130", at: at(5) },
    ]);
    expect(result.maxDrawdownPct).toBe("20.0000");
    expect(result.peakAt).toBe(at(3).toISOString());
    expect(result.troughAt).toBe(at(4).toISOString());
  });

  it("is null below two samples and zero for a monotonic rise", () => {
    expect(computeHistoricalDrawdown([]).maxDrawdownPct).toBeNull();
    expect(computeHistoricalDrawdown([]).sampleCount).toBe(0);
    expect(computeHistoricalDrawdown([{ equityUsd: "100", at: at(0) }]).maxDrawdownPct).toBeNull();
    expect(
      computeHistoricalDrawdown([
        { equityUsd: "100", at: at(0) },
        { equityUsd: "101", at: at(1) },
      ]).maxDrawdownPct,
    ).toBe("0.0000");
  });

  it("normalises the SQL row (bigint count, text numerics, Date timestamps)", () => {
    const result = normaliseHistoricalDrawdown({
      sampleCount: BigInt(12980),
      firstAt: at(0),
      lastAt: at(9),
      maxDrawdownPct: "9.94123456789",
      peakEquityUsd: "10012.5",
      troughEquityUsd: "9017.1",
      peakAt: at(3),
      troughAt: "2026-10-01T00:07:00.000Z",
    });
    expect(result.sampleCount).toBe(12980);
    expect(result.maxDrawdownPct).toBe("9.9412");
    expect(result.peakEquityUsd).toBe("10012.50000000");
    expect(result.troughAt).toBe("2026-10-01T00:07:00.000Z");
    expect(normaliseHistoricalDrawdown(undefined)).toMatchObject({ sampleCount: 0, maxDrawdownPct: null, firstAt: null });
  });
});

describe("drawdown below high-water mark", () => {
  it("measures current equity against the HWM", () => {
    expect(drawdownBelowHwmPct("9000", "10000")).toBe("10.0000");
    expect(drawdownBelowHwmPct(null, "10000")).toBeNull();
    expect(drawdownBelowHwmPct("9000", null)).toBeNull();
    expect(drawdownBelowHwmPct("9000", "0")).toBeNull();
  });
});
