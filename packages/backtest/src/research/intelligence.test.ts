import { describe, expect, it } from "vitest";
import { seededRng } from "../stats.js";
import { barrierLabels, computeFeatures, FEATURE_NAMES, netForwardLabels } from "./features.js";
import { calibration, DEFAULT_ML_CONFIG, evaluateModels, fitLogistic, predict, psi } from "./ml.js";
import { runIntelligenceStudy } from "./intelligence.js";
import { classifyRegimes, regimeConfigFor, trendTransitions } from "./regime.js";
import { performanceByRegime, REGIME_GATES, regimeGatedSpec, trendKey } from "./regime-analysis.js";
import { simulate, type ResearchBar } from "./simulate.js";
import { STRATEGY_LIBRARY } from "./strategies.js";
import { DEFAULT_VALIDATION, validateStrategy } from "./validate.js";

const H = 3_600_000;

/** Synthetic test fixtures only (never research evidence): log-normal bars with a per-bar drift schedule. */
function series(n: number, seed: number, drift: (i: number) => number, vol: (i: number) => number = () => 0.01): ResearchBar[] {
  const rng = seededRng(seed);
  const bars: ResearchBar[] = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
    const open = p;
    p = p * Math.exp(drift(i) + vol(i) * z);
    bars.push({ t: i * H, open, high: Math.max(open, p) * 1.001, low: Math.min(open, p) * 0.999, close: p, volume: 1 + rng() });
  }
  return bars;
}

describe("regime engine (ASCEND-04)", () => {
  it("is filtered: classifying a prefix reproduces the same states (no look-ahead, no smoothing)", () => {
    const bars = series(900, 1, () => 0, (i) => (i > 600 ? 0.03 : 0.01));
    const full = classifyRegimes(bars);
    for (const k of [100, 333, 650, 899]) expect(JSON.stringify(classifyRegimes(bars.slice(0, k), { barMs: H }))).toBe(JSON.stringify(full.slice(0, k)));
  });

  it("stays UNKNOWN without enough history, and when gaps break coverage", () => {
    const cfg = regimeConfigFor(H);
    const bars = series(400, 2, () => 0.002);
    const states = classifyRegimes(bars);
    expect(states[cfg.trendWindow - 2]!.trend.state).toBe("UNKNOWN");
    expect(states[cfg.trendWindow - 2]!.insufficient).toBe(true);
    // Keep every other bar in the last 100: coverage ≈ 50%.
    const gappy = [...bars.slice(0, 300), ...bars.slice(300).filter((_, i) => i % 2 === 0)];
    const g = classifyRegimes(gappy, { barMs: H });
    expect(g.at(-1)!.trend.state).toBe("UNKNOWN");
    expect(g.at(-1)!.coverage).toBeLessThan(cfg.minCoverage);
  });

  it("labels clear trends and quiet ranges, and never invents liquidity", () => {
    const up = classifyRegimes(series(400, 3, () => 0.004, () => 0.005)).at(-1)!;
    const down = classifyRegimes(series(400, 4, () => -0.004, () => 0.005)).at(-1)!;
    expect(up.trend.state).toBe("STRONG_UP");
    expect(down.trend.state).toBe("STRONG_DOWN");
    expect(up.liquidity.state).toBe("UNKNOWN");
    const flat = classifyRegimes(series(2000, 5, () => 0));
    const counts = new Map<string, number>();
    for (const s of flat) if (s.trend.state !== "UNKNOWN") counts.set(s.trend.state, (counts.get(s.trend.state) ?? 0) + 1);
    // Regression guard: a slope t-stat on price levels called most random walks STRONG trends.
    expect([...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]).toBe("RANGE");
  });

  it("sees a volatility spike as ELEVATED or EXTREME and EXPANDING, and flags a change point", () => {
    const bars = series(800, 6, () => 0, (i) => (i >= 700 ? 0.05 : 0.005));
    const s = classifyRegimes(bars);
    expect(["ELEVATED", "EXTREME"]).toContain(s[715]!.volatility.level);
    expect(s.slice(700, 712).some((x) => x.volatility.direction === "EXPANDING")).toBe(true);
    expect(s.slice(700, 720).some((x) => x.behaviour.changePoint)).toBe(true);
  });

  it("uses a benchmark bar only after it has closed", () => {
    const bars = series(400, 7, () => 0.001);
    // Daily benchmark bars: the bar opening at t closes 24h later and is unknown until then.
    const bench = series(30, 8, () => 0.01, () => 0.002).map((b, i) => ({ ...b, t: i * 24 * H }));
    const s = classifyRegimes(bars, { benchmark: bench });
    expect(s[10]!.broad.state).toBe("UNKNOWN");
    expect(s.every((x) => x.modelVersion === "regime-det-1.0.0")).toBe(true);
    const m = trendTransitions(s);
    expect(m.counts.flat().reduce((a, b) => a + b, 0)).toBe(m.total);
  });

  it("gates a strategy to permitted regimes and runs it through the full protocol as its own hypothesis", () => {
    const bars = series(2500, 9, (i) => (Math.floor(i / 300) % 2 ? 0.002 : -0.002));
    const states = classifyRegimes(bars);
    const byT = new Map(states.map((s) => [s.t, s]));
    const find = (id: string) => STRATEGY_LIBRARY.find((s) => s.id === id)!;
    const gated = regimeGatedSpec(find("tsmom"), REGIME_GATES.trendOnly!, byT);
    expect(gated.family).toBe("REGIME_CONDITIONED");
    const sim = simulate({ strategy: gated.build!({ lookback: 24 }), bars, startIndex: 0, endIndex: bars.length, costBpsPerSide: 10 });
    // Every entry was decided (bar before its fill) in a permitted regime.
    const indexOf = new Map(bars.map((b, i) => [b.t, i]));
    expect(sim.trades.length).toBeGreaterThan(0);
    for (const trade of sim.trades) expect(["WEAK_UP", "STRONG_UP"]).toContain(states[indexOf.get(trade.entryT)! - 1]!.trend.state);
    const buckets = performanceByRegime({ sim, bars, states, key: trendKey });
    expect(buckets.reduce((s, b) => s + b.bars, 0)).toBe(sim.barReturns.length);
    const report = validateStrategy({
      spec: gated,
      bars,
      config: { ...DEFAULT_VALIDATION, costBpsPerSide: 10, periodsPerYear: 8760 },
      codeVersion: "t",
      controls: { buyAndHold: find("control_buy_and_hold"), random: find("control_random"), cash: find("control_cash") },
    });
    expect(report.strategyId).toBe("tsmom__trend_only");
    expect(report.trialCount).toBeGreaterThan(0);
  }, 60_000);
});

describe("feature store and labels (ASCEND-05)", () => {
  it("is point-in-time: features for a prefix equal the same rows computed on the full series", () => {
    const bars = series(600, 10, () => 0.0005);
    const full = computeFeatures(bars, classifyRegimes(bars));
    const prefix = bars.slice(0, 400);
    const part = computeFeatures(prefix, classifyRegimes(prefix, { barMs: H }), { barMs: H });
    expect(JSON.stringify(part)).toBe(JSON.stringify(full.slice(0, 400)));
    expect(full[399]!.availableAt).toBe(bars[399]!.t + H);
    expect(Object.keys(full[0]!.values).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("labels enter at the next open and exit after the horizon, net of cost on both sides", () => {
    const bars = series(50, 11, () => 0);
    const labels = netForwardLabels(bars, 5, 25);
    const l = labels[10]!;
    expect(l.endIndex).toBe(16);
    expect(l.netReturn).toBeCloseTo((bars[16]!.open * (1 - 0.0025)) / (bars[11]!.open * 1.0025) - 1, 12);
    expect(labels.at(-6)).toBeNull();
    for (const b of barrierLabels(bars, computeFeatures(bars, classifyRegimes(bars)), 5)) if (b) expect(b.endIndex).toBeGreaterThan(b.index);
  });
});

describe("baseline models (ASCEND-05)", () => {
  it("scores calibration honestly", () => {
    const c = calibration([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0]);
    expect(c.auc).toBe(1);
    expect(c.brier).toBeCloseTo(0.01, 10);
    const coin = calibration([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]);
    expect(coin.ece).toBeCloseTo(0, 10);
    expect(coin.auc).toBe(0.5);
    expect(psi([...Array(200).keys()], [...Array(200).keys()])).toBeCloseTo(0, 6);
  });

  it("fits a separable logistic problem and stores plain-number artefacts", () => {
    const X = Array.from({ length: 200 }, (_, i) => [i < 100 ? -1 - (i % 7) / 10 : 1 + (i % 7) / 10]);
    const y = X.map((x) => (x[0]! > 0 ? 1 : 0));
    const m = fitLogistic(X, y, ["x"]);
    expect(predict(m, [2])).toBeGreaterThan(0.9);
    expect(predict(m, [-2])).toBeLessThan(0.1);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("purges every training label that reaches the test window, and reserves a holdout", () => {
    const bars = series(6000, 12, () => 0);
    const features = computeFeatures(bars, classifyRegimes(bars));
    const r = evaluateModels({ features, labels: netForwardLabels(bars, 24, 10), horizon: 24, costBpsPerSide: 10 });
    expect(r.folds.length).toBeGreaterThan(0);
    for (const f of r.folds) {
      expect(f.lastTrainLabelEndIndex).toBeLessThan(f.firstTestIndex);
      expect(f.purged).toBeGreaterThan(0);
    }
    expect(r.rows.holdoutReserved).toBeGreaterThan(0);
  }, 60_000);

  it("finds no economic skill on a driftless random walk, and is reproducible", () => {
    const bars = series(3000, 13, () => 0);
    const features = computeFeatures(bars, classifyRegimes(bars));
    const labels = netForwardLabels(bars, 6, 10);
    const a = evaluateModels({ features, labels, horizon: 6, costBpsPerSide: 10 });
    const b = evaluateModels({ features, labels, horizon: 6, costBpsPerSide: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.verdict).not.toBe("SHADOW_ELIGIBLE");
  }, 60_000);

  it("detects a planted, persistent signal (the pipeline can learn at all)", () => {
    // Drift flips sign in 150-bar blocks, so the trailing return predicts the forward return within a block.
    const bars = series(4000, 14, (i) => (Math.floor(i / 150) % 2 ? 0.003 : -0.003), () => 0.006);
    const features = computeFeatures(bars, classifyRegimes(bars));
    const r = evaluateModels({ features, labels: netForwardLabels(bars, 6, 5), horizon: 6, costBpsPerSide: 5 });
    expect(r.brierSkill.logistic!).toBeGreaterThan(0);
    expect(r.oos!.LOGISTIC_L2.auc!).toBeGreaterThan(0.55);
  }, 60_000);

  it("refuses to evaluate on too little data", () => {
    const bars = series(300, 15, () => 0);
    const features = computeFeatures(bars, classifyRegimes(bars));
    const r = evaluateModels({ features, labels: netForwardLabels(bars, 24, 10), horizon: 24, costBpsPerSide: 10, config: DEFAULT_ML_CONFIG });
    expect(r.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finalArtefacts).toBeNull();
  });
});

describe("integrated study (SINGULARITY)", () => {
  it("never reads a holdout unless the caller can record it, and concludes NO TRADE on noise", () => {
    const bars = series(2500, 16, () => 0);
    const study = runIntelligenceStudy({ bars, barMs: H, costBpsPerSide: 10, periodsPerYear: 8760, codeVersion: "t" });
    for (const h of study.hypotheses) {
      expect(h.gated.trials.some((t) => t.window === "HOLDOUT")).toBe(false);
      expect(h.base.trials.some((t) => t.window === "HOLDOUT")).toBe(false);
    }
    expect(study.conclusion).toBe("NO TRADE — NO VALIDATED POSITIVE NET EDGE");
  }, 120_000);
});
