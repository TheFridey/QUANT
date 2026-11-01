import { describe, expect, it } from "vitest";
import { seededRng } from "../stats.js";
import { deflatedSharpe, expectedMaxSharpe, maxDrawdown, performanceStats, probabilisticSharpe, probabilityOfBacktestOverfitting } from "./metrics.js";
import { simulate, type ResearchBar, type ResearchStrategy } from "./simulate.js";
import { STRATEGY_LIBRARY, expandGrid } from "./strategies.js";
import { DEFAULT_VALIDATION, fitGridToData, validateStrategy, walkForwardFolds } from "./validate.js";

const H = 3_600_000;

function walk(n: number, seed: number, drift = 0, vol = 0.01): ResearchBar[] {
  const rng = seededRng(seed);
  const bars: ResearchBar[] = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    // Box–Muller normal shocks.
    const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
    const open = p;
    p = p * Math.exp(drift + vol * z);
    bars.push({ t: i * H, open, high: Math.max(open, p) * 1.001, low: Math.min(open, p) * 0.999, close: p, volume: 1 });
  }
  return bars;
}

const spec = (id: string) => STRATEGY_LIBRARY.find((s) => s.id === id)!;
const controls = { buyAndHold: spec("control_buy_and_hold"), random: spec("control_random"), cash: spec("control_cash") };
const cfg = { ...DEFAULT_VALIDATION, costBpsPerSide: 10, periodsPerYear: 24 * 365 };

describe("simulate (point-in-time execution)", () => {
  it("never gives a strategy a bar after the decision bar, and gives exactly its look-back", () => {
    const bars = walk(50, 1);
    const violations: number[] = [];
    let decisions = 0;
    const spy: ResearchStrategy = {
      id: "spy",
      lookback: 5,
      decide: (ctx) => {
        expect(Object.isFrozen(ctx.bars)).toBe(true);
        const decisionIndex = 5 + decisions;
        if (ctx.bars.at(-1)!.t !== bars[decisionIndex]!.t || ctx.bars.length !== 5) violations.push(decisionIndex);
        decisions += 1;
        return 0;
      },
    };
    const sim = simulate({ strategy: spy, bars, startIndex: 0, endIndex: 50, costBpsPerSide: 0 });
    expect(violations).toEqual([]);
    expect(decisions).toBe(44); // decision bars 5..48; bar 49 is only ever a fill
    expect(sim.barReturns).toHaveLength(44);
  });

  it("an oracle that peeks at the future cannot profit, because the future is not in its view", () => {
    const bars = walk(400, 2);
    // Tries to look one bar ahead; with the frozen view, `bars[length]` is undefined, so it never buys.
    const cheat: ResearchStrategy = { id: "cheat", lookback: 1, decide: (ctx) => ((ctx.bars as ResearchBar[])[ctx.bars.length] ? 1 : 0) };
    expect(simulate({ strategy: cheat, bars, startIndex: 0, endIndex: 400, costBpsPerSide: 0 }).trades).toHaveLength(0);
  });

  it("fills at the next open and charges cost on both sides", () => {
    const bars: ResearchBar[] = [100, 100, 110, 121, 121].map((c, i) => ({ t: i * H, open: i === 2 ? 105 : c, high: c, low: c, close: c, volume: 1 }));
    const once: ResearchStrategy = { id: "once", lookback: 1, decide: (ctx) => (ctx.bars.at(-1)!.t === 1 * H ? 1 : ctx.bars.at(-1)!.t === 3 * H ? 0 : ctx.position) };
    const sim = simulate({ strategy: once, bars, startIndex: 0, endIndex: 5, costBpsPerSide: 100 });
    expect(sim.trades).toHaveLength(1);
    expect(sim.trades[0]!.entryPrice).toBe(105); // next open, not the decision close of 100
    expect(sim.trades[0]!.netReturn).toBeCloseTo((121 * 0.99) / (105 * 1.01) - 1, 10);
  });

  it("a costly round trip on a flat market loses exactly the cost", () => {
    const bars: ResearchBar[] = Array.from({ length: 6 }, (_, i) => ({ t: i * H, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
    const flip: ResearchStrategy = { id: "flip", lookback: 1, decide: (ctx) => (ctx.bars.at(-1)!.t === 1 * H ? 1 : ctx.bars.at(-1)!.t === 2 * H ? 0 : ctx.position) };
    const sim = simulate({ strategy: flip, bars, startIndex: 0, endIndex: 6, costBpsPerSide: 50 });
    expect(sim.trades[0]!.netReturn).toBeCloseTo(0.995 / 1.005 - 1, 10);
  });
});

describe("metrics", () => {
  it("computes drawdown depth and duration", () => {
    expect(maxDrawdown([0.1, -0.5, 0.2, 0.0])).toEqual({ depth: 0.5, bars: 3 });
  });

  it("withholds ratios from small samples", () => {
    const s = performanceStats({ barReturns: [0.01, -0.01, 0.02], trades: [], exposure: 1, turnover: 0 }, 252);
    expect(s.sharpe).toBeNull();
    expect(s.winRate).toBeNull();
  });

  it("PSR is 0.5 at the benchmark and rises with sample size", () => {
    expect(probabilisticSharpe({ sharpe: 0.05, benchmark: 0.05, n: 500, skew: 0, kurtosis: 3 })).toBeCloseTo(0.5, 6);
    const small = probabilisticSharpe({ sharpe: 0.05, benchmark: 0, n: 200, skew: 0, kurtosis: 3 })!;
    const large = probabilisticSharpe({ sharpe: 0.05, benchmark: 0, n: 2000, skew: 0, kurtosis: 3 })!;
    expect(large).toBeGreaterThan(small);
  });

  it("DSR deflates more with more trials", () => {
    const rng = seededRng(4);
    const few = Array.from({ length: 5 }, () => (rng() - 0.5) * 0.1);
    const many = Array.from({ length: 200 }, () => (rng() - 0.5) * 0.1);
    expect(expectedMaxSharpe(200, 0.001)).toBeGreaterThan(expectedMaxSharpe(5, 0.001));
    const a = deflatedSharpe({ sharpe: 0.06, n: 1000, skew: 0, kurtosis: 3, trialSharpes: few }).dsr!;
    const b = deflatedSharpe({ sharpe: 0.06, n: 1000, skew: 0, kurtosis: 3, trialSharpes: many }).dsr!;
    expect(b).toBeLessThan(a);
  });

  it("PBO is high when every configuration is pure noise", () => {
    const rng = seededRng(9);
    const matrix = Array.from({ length: 20 }, () => Array.from({ length: 1000 }, () => (rng() - 0.5) * 0.02));
    const { pbo, splits } = probabilityOfBacktestOverfitting(matrix);
    expect(splits).toBe(252);
    expect(pbo!).toBeGreaterThan(0.3);
  }, 60_000);

  it("PBO is low when one configuration has a genuine persistent edge", () => {
    const rng = seededRng(10);
    const matrix = Array.from({ length: 10 }, (_, k) => Array.from({ length: 1000 }, () => (rng() - 0.5) * 0.02 + (k === 0 ? 0.004 : 0)));
    expect(probabilityOfBacktestOverfitting(matrix).pbo!).toBeLessThan(0.1);
  });
});

describe("walk-forward protocol", () => {
  it("keeps the holdout last, untouched by folds, with an embargo before each test", () => {
    const { holdoutStart, folds } = walkForwardFolds(1000, { folds: 4, holdoutFraction: 0.2, embargoBars: 30 });
    expect(holdoutStart).toBe(800);
    for (const f of folds) {
      expect(f.testStart - f.trainEnd).toBe(30);
      expect(f.testEnd).toBeLessThanOrEqual(800);
    }
  });

  it("is reproducible: same data, code and seed give an identical report", () => {
    const bars = walk(1500, 11);
    const a = validateStrategy({ spec: spec("tsmom"), bars, config: cfg, codeVersion: "test", controls });
    const b = validateStrategy({ spec: spec("tsmom"), bars, config: cfg, codeVersion: "test", controls });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 60_000);

  it("rejects or withholds every trend strategy on a driftless random walk", () => {
    const bars = walk(3000, 12, 0, 0.01);
    for (const id of ["tsmom", "ma_trend", "donchian_breakout", "vol_normalised_trend"]) {
      const r = validateStrategy({ spec: spec(id), bars, config: cfg, codeVersion: "test", controls });
      expect(r.verdict, id).not.toBe("VALIDATED_CANDIDATE");
      expect(r.trialCount).toBeGreaterThanOrEqual(expandGrid(spec(id).grid).length);
    }
  }, 60_000);

  it("records every grid point in every fold as a trial, failures included", () => {
    const r = validateStrategy({ spec: spec("ma_trend"), bars: walk(4000, 13), config: cfg, codeVersion: "test", controls });
    const gridSize = expandGrid(spec("ma_trend").grid).length;
    expect(r.trials.filter((t) => t.window === "TRAIN")).toHaveLength(gridSize * 4);
    expect(r.trials.filter((t) => t.window === "FULL_GRID")).toHaveLength(gridSize);
  }, 60_000);

  it("never touches the holdout unless the strategy already passed out of sample", () => {
    const r = validateStrategy({ spec: spec("zscore_reversion"), bars: walk(2000, 14), config: cfg, codeVersion: "test", controls });
    if (r.verdict !== "VALIDATED_CANDIDATE") expect(r.trials.some((t) => t.window === "HOLDOUT")).toBe(r.holdout !== null);
    expect(r.trials.filter((t) => t.window === "HOLDOUT").length).toBeLessThanOrEqual(1);
  }, 60_000);

  it("fits horizon parameters to a short dataset, never thresholds, never upwards", () => {
    const long = fitGridToData(spec("zscore_reversion"), 20_000, cfg);
    expect(long.factor).toBe(1);
    expect(long.grid).toEqual(spec("zscore_reversion").grid);
    const short = fitGridToData(spec("zscore_reversion"), 1464, cfg);
    expect(short.factor).toBeLessThan(1);
    expect(short.maxLookbackBars).toBeLessThanOrEqual(short.budgetBars);
    expect(short.grid.entryZ).toEqual(spec("zscore_reversion").grid.entryZ);
    expect(Math.max(...short.grid.window!)).toBeLessThan(Math.max(...spec("zscore_reversion").grid.window!));
  });

  it("keeps every fold usable on a 1.5k-bar dataset once the grid is fitted, and records the scale", () => {
    const r = validateStrategy({ spec: spec("ma_trend"), bars: walk(1500, 13), config: cfg, codeVersion: "t", controls });
    expect(r.reasons.join(" ")).not.toMatch(/walk-forward needs more bars/);
    expect(r.gridScale!.factor).toBeLessThan(1);
    expect(r.trials.filter((t) => t.window === "TEST")).toHaveLength(4);
  });

  it("still refuses when the data is too short for any honest fold", () => {
    const r = validateStrategy({ spec: spec("ma_trend"), bars: walk(520, 13), config: cfg, codeVersion: "t", controls });
    expect(r.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasons[0]).toMatch(/walk-forward needs more bars/);
    expect(r.trials).toHaveLength(0);
  });

  it("refuses too-short data and unsupported families with explicit verdicts", () => {
    expect(validateStrategy({ spec: spec("tsmom"), bars: walk(100, 15), config: cfg, codeVersion: "t", controls }).verdict).toBe("REJECTED_DATA");
    const pairs = validateStrategy({ spec: spec("pairs_cointegration"), bars: walk(1000, 16), config: cfg, codeVersion: "t", controls });
    expect(pairs.verdict).toBe("RESEARCH_ONLY");
    expect(pairs.reasons[0]).toMatch(/shorting/);
  });

  it("attributes a gross edge eaten by costs to REJECTED_COSTS", () => {
    // Long 4 bars in every 5 on a strongly drifting series: positive gross, but 100 bps per side wipes it out.
    const flipper = {
      ...spec("tsmom"),
      id: "test_flipper",
      grid: { period: [5] },
      build: ({ period }: Record<string, number>) => ({ id: "flip", lookback: 1, decide: (ctx: { bars: readonly ResearchBar[] }) => (Math.round(ctx.bars.at(-1)!.t / H) % period! === 0 ? 0 : 1) as 0 | 1 }),
    };
    const bars = walk(3000, 17, 0.0005, 0.002);
    const r = validateStrategy({ spec: flipper, bars, config: { ...cfg, costBpsPerSide: 100 }, codeVersion: "t", controls });
    expect(r.oosGross!.totalReturn).toBeGreaterThan(0);
    expect(r.oos!.totalReturn).toBeLessThanOrEqual(0);
    expect(r.verdict).toBe("REJECTED_COSTS");
  });
  it("deflates DSR by the programme's trial count when given, and never loosens it", () => {
    const bars = walk(3000, 18, 0.0003, 0.008);
    const local = validateStrategy({ spec: spec("ma_trend"), bars, config: cfg, codeVersion: "t", controls });
    const programme = validateStrategy({ spec: spec("ma_trend"), bars, config: cfg, codeVersion: "t", controls, programmeTrialCount: 1594 });
    expect(local.dsrProgramme).toBeNull();
    expect(programme.dsrProgramme!.trials).toBe(1594 + programme.trials.length);
    expect(programme.dsrProgramme!.benchmark).toBeGreaterThanOrEqual(programme.dsr!.benchmark);
    if (programme.dsrProgramme!.dsr !== null && programme.dsr!.dsr !== null) expect(programme.dsrProgramme!.dsr).toBeLessThanOrEqual(programme.dsr!.dsr);
  }, 60_000);

  it("reports OOS net return at 2x and 3x cost, monotonically worse", () => {
    const r = validateStrategy({ spec: spec("tsmom"), bars: walk(3000, 19, 0.0003, 0.008), config: cfg, codeVersion: "t", controls });
    expect(r.costSensitivity.map((c) => c.multiplier)).toEqual([2, 3]);
    expect(r.costSensitivity[0]!.netReturn).toBeLessThanOrEqual(r.oos!.totalReturn);
    expect(r.costSensitivity[1]!.netReturn).toBeLessThanOrEqual(r.costSensitivity[0]!.netReturn);
  }, 60_000);
});
