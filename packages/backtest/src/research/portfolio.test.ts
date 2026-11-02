import { describe, expect, it } from "vitest";
import {
  HYPOTHETICAL_SHOCKS,
  MIN_OBSERVATIONS,
  alignReturns,
  backtestAllocation,
  capWeights,
  closeToCloseReturns,
  concentration,
  correlationMatrix,
  covarianceMatrix,
  equalRiskContribution,
  exposureBy,
  exposureOverlap,
  historicalTail,
  inverseVolatility,
  ledoitWolfCovariance,
  ledoitWolfIdentity,
  portfolioReport,
  portfolioVariance,
  riskContributions,
  rollingCorrelation,
  scenarioLoss,
  stressCovariance,
  volatilityTarget,
  type ReturnSeries,
} from "./portfolio.js";

/**
 * DETERMINISTIC TEST FIXTURES. Every return series below is generated from a seeded PRNG. None of it is
 * market data, and nothing derived from it is evidence about any real instrument.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(next: () => number) {
  return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}
/** T rows of N returns: a common factor with loading `beta` plus idiosyncratic noise scaled by `vols`. */
function factorReturns(T: number, vols: number[], beta: number, seed: number): number[][] {
  const g = gaussian(rng(seed));
  return Array.from({ length: T }, () => {
    const f = g();
    return vols.map((v) => v * (beta * f + Math.sqrt(1 - beta * beta) * g()));
  });
}
const toSeries = (X: number[][], markets?: string[]): ReturnSeries[] =>
  X[0]!.map((_, i) => ({ id: `fixture_${i}`, market: markets?.[i], points: X.map((row, k) => ({ t: k * 3_600_000, r: row[i]! })) }));

describe("close-to-close returns never bridge a gap", () => {
  const H = 3_600_000;
  const D = 86_400_000;
  it("skips the return across a missing bar on a continuous calendar", () => {
    const out = closeToCloseReturns([{ t: 0, close: 100 }, { t: H, close: 110 }, { t: 3 * H, close: 121 }, { t: 4 * H, close: 121 }], H);
    expect(out.points).toEqual([{ t: H, r: 0.10000000000000009 }, { t: 4 * H, r: 0 }]);
    expect(out.gaps).toBe(1);
  });

  it("treats Friday → Monday as consecutive for daily equities, and a holiday as a gap", () => {
    // 2026-01-02 is a Friday; New York midnight is 05:00 UTC in winter.
    const fri = Date.UTC(2026, 0, 2, 5);
    const mon = fri + 3 * D;
    const wed = mon + 2 * D; // Tuesday missing (treated as a holiday/gap)
    const out = closeToCloseReturns([{ t: fri, close: 100 }, { t: mon, close: 101 }, { t: wed, close: 102 }], D, "WEEKDAYS");
    expect(out.points.map((p) => p.t)).toEqual([mon]);
    expect(out.gaps).toBe(1);
    // The same Friday → Monday pair is a gap on a continuous calendar.
    expect(closeToCloseReturns([{ t: fri, close: 100 }, { t: mon, close: 101 }], D).gaps).toBe(1);
  });

  it("tolerates the one-hour DST shift in equity daily stamps", () => {
    // US DST starts 2026-03-08: Friday 6 March stamps 05:00 UTC, Monday 9 March 04:00 UTC.
    const out = closeToCloseReturns([{ t: Date.UTC(2026, 2, 6, 5), close: 100 }, { t: Date.UTC(2026, 2, 9, 4), close: 99 }], D, "WEEKDAYS");
    expect(out.points).toHaveLength(1);
  });

  it("refuses unordered bars and skips non-positive closes", () => {
    expect(() => closeToCloseReturns([{ t: H, close: 1 }, { t: 0, close: 1 }], H)).toThrow();
    expect(closeToCloseReturns([{ t: 0, close: 0 }, { t: H, close: 1 }], H).points).toEqual([]);
  });
});

describe("alignment never fills", () => {
  it("drops timestamps missing from any series and counts them", () => {
    const aligned = alignReturns([
      { id: "a", points: [{ t: 1, r: 0.01 }, { t: 2, r: 0.02 }, { t: 3, r: -0.01 }] },
      { id: "b", points: [{ t: 1, r: 0.0 }, { t: 3, r: 0.01 }, { t: 4, r: 0.03 }] },
    ]);
    expect(aligned.t).toEqual([1, 3]);
    expect(aligned.returns).toEqual([[0.01, 0.0], [-0.01, 0.01]]);
    expect(aligned.droppedTimestamps).toBe(2);
  });

  it("refuses duplicate timestamps and drops non-finite or total-loss-beyond returns", () => {
    expect(() => alignReturns([{ id: "a", points: [{ t: 1, r: 0 }, { t: 1, r: 0.1 }] }])).toThrow(/duplicate timestamp/);
    expect(() => alignReturns([{ id: "a", points: [] }, { id: "a", points: [] }])).toThrow(/duplicate series id/);
    const aligned = alignReturns([{ id: "a", points: [{ t: 1, r: Number.NaN }, { t: 2, r: -1.5 }, { t: 3, r: 0.01 }] }]);
    expect(aligned.t).toEqual([3]);
    expect(aligned.invalidReturns).toBe(2);
  });
});

describe("covariance and correlation", () => {
  it("withholds estimates below the minimum sample", () => {
    const X = factorReturns(MIN_OBSERVATIONS - 1, [0.01, 0.02], 0.5, 1);
    expect(covarianceMatrix(X)).toBeNull();
    expect(correlationMatrix(X)).toBeNull();
    expect(ledoitWolfCovariance(X)).toBeNull();
  });

  it("recovers a planted correlation and is symmetric with a unit diagonal", () => {
    const X = factorReturns(4000, [0.01, 0.03, 0.02], Math.sqrt(0.6), 7);
    const C = correlationMatrix(X)!;
    for (let i = 0; i < 3; i++) {
      expect(C[i]![i]).toBe(1);
      for (let j = 0; j < 3; j++) expect(C[i]![j]).toBeCloseTo(C[j]![i]!, 12);
    }
    // Two assets loading √0.6 on one factor have correlation 0.6.
    expect(C[0]![1]!).toBeGreaterThan(0.55);
    expect(C[0]![1]!).toBeLessThan(0.65);
  });

  it("reports null correlation for a zero-variance asset instead of dividing by zero", () => {
    const X = factorReturns(60, [0.01, 0.02], 0.3, 3).map((row) => [row[0]!, row[1]!, 0]);
    const C = correlationMatrix(X)!;
    expect(C[0]![2]).toBeNull();
    expect(C[2]![2]).toBeNull();
  });

  it("Ledoit–Wolf estimator matches an independent numpy reference", () => {
    // Reference: numpy implementation of the 2004 formula and the sklearn-style form agree on δ (scratch
    // script, APEX review); values copied here so a wrong-but-plausible δ fails.
    const X = Array.from({ length: 40 }, (_, k) => [0, 1, 2].map((i) => Math.sin(k * (i + 1) * 0.7) * 0.01 * (i + 1) + Math.cos(k * 0.3 + i) * 0.005));
    const est = ledoitWolfIdentity(X)!;
    expect(est.shrinkage).toBeCloseTo(0.14894172899709784, 12);
    expect(est.covariance[0]![1]!).toBeCloseTo(8.968879761259893e-6, 15);
    expect(est.covariance[0]![0]!).toBeCloseTo(9.59295559319993e-5, 15);
  });

  it("correlation shrinkage keeps every asset's sample variance and refuses a zero-variance asset", () => {
    const X = factorReturns(60, [0.0005, 0.01, 0.08], 0.3, 13);
    const S = covarianceMatrix(X, { population: true })!;
    const est = ledoitWolfCovariance(X)!;
    est.covariance.forEach((row, i) => expect(row[i]!).toBeCloseTo(S[i]![i]!, 18));
    // A frozen feed (constant price → zero returns) must be refused, not given the largest weight.
    const frozen = X.map((row) => [row[0]!, row[1]!, 0]);
    expect(ledoitWolfCovariance(frozen)).toBeNull();
    const bt = backtestAllocation({ returns: [...frozen, ...frozen, ...frozen] }, "INVERSE_VOLATILITY", { lookback: 60, rebalanceEvery: 20, costBpsPerSide: 0, shrink: true, periodsPerYear: 252 });
    expect(bt.rebalances).toBe(0);
    expect(bt.sufficient).toBe(false);
    expect(bt.netReturns).toEqual([]);
  });

  it("Ledoit–Wolf: intensity in [0,1], trace preserved, positive definite, more shrinkage on short samples", () => {
    const vols = [0.01, 0.015, 0.02, 0.025, 0.03, 0.012, 0.018, 0.022];
    const short = ledoitWolfIdentity(factorReturns(40, vols, 0.4, 11))!;
    const long = ledoitWolfIdentity(factorReturns(4000, vols, 0.4, 11))!;
    for (const est of [short, long]) {
      expect(est.shrinkage).toBeGreaterThanOrEqual(0);
      expect(est.shrinkage).toBeLessThanOrEqual(1);
    }
    expect(short.shrinkage).toBeGreaterThan(long.shrinkage);
    const X = factorReturns(40, vols, 0.4, 11);
    const S = covarianceMatrix(X, { population: true })!;
    const trace = (M: number[][]) => M.reduce((s, row, i) => s + row[i]!, 0);
    expect(trace(short.covariance)).toBeCloseTo(trace(S), 14);
    // Positive definite: w'Σw > 0 for many random directions.
    const g = gaussian(rng(5));
    for (let k = 0; k < 200; k++) {
      const w = vols.map(() => g());
      expect(portfolioVariance(w, short.covariance)).toBeGreaterThan(0);
    }
  });
});

describe("rolling correlation is point in time", () => {
  it("is unchanged at k when later observations change (prefix invariance)", () => {
    const X = factorReturns(200, [0.01, 0.02], 0.5, 21);
    const a = X.map((row) => row[0]!);
    const b = X.map((row) => row[1]!);
    const full = rollingCorrelation(a, b, 30);
    const tampered = rollingCorrelation([...a.slice(0, 120), ...a.slice(120).map((v) => -v * 5)], b, 30);
    expect(tampered.slice(0, 120)).toEqual(full.slice(0, 120));
    expect(full.slice(0, 29).every((v) => v === null)).toBe(true);
    expect(full[29]).not.toBeNull();
  });
});

describe("risk decomposition and concentration", () => {
  it("Euler contributions sum to portfolio volatility; shares sum to 1", () => {
    const S = covarianceMatrix(factorReturns(500, [0.01, 0.02, 0.04], 0.5, 31))!;
    const rc = riskContributions([0.5, 0.3, 0.2], S)!;
    expect(rc.contributions.reduce((s, v) => s + v, 0)).toBeCloseTo(rc.volatility, 14);
    expect(rc.shares.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 14);
    expect(riskContributions([0, 0, 0], S)).toBeNull();
  });

  it("concentration: equal weights give effective N = N; a single asset gives 1", () => {
    expect(concentration([0.25, 0.25, 0.25, 0.25])!.effectiveN).toBeCloseTo(4, 12);
    expect(concentration([1, 0, 0])!.effectiveN).toBeCloseTo(1, 12);
    expect(concentration([0, 0])).toBeNull();
  });

  it("groups exposure by market and labels unknown markets", () => {
    expect(exposureBy([0.5, 0.25, 0.25], ["BROAD_ETF", "LIQUID_MAJOR", null])).toEqual({ BROAD_ETF: 0.5, LIQUID_MAJOR: 0.25, UNKNOWN: 0.25 });
  });

  it("strategy overlap is the Jaccard index of exposed bars", () => {
    expect(exposureOverlap([true, true, false, false], [true, false, true, false])).toBeCloseTo(1 / 3, 12);
    expect(exposureOverlap([false, false], [false, false])).toBeNull();
  });
});

describe("allocation baselines", () => {
  it("equal risk contribution equalises contributions and equals inverse volatility on a diagonal covariance", () => {
    const S = covarianceMatrix(factorReturns(800, [0.01, 0.02, 0.05, 0.03], 0.6, 41))!;
    const erc = equalRiskContribution(S)!;
    const rc = riskContributions(erc.weights, S)!;
    for (const share of rc.shares) expect(share).toBeCloseTo(0.25, 8);
    expect(erc.weights.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    const diag = [[0.0001, 0, 0], [0, 0.0004, 0], [0, 0, 0.0016]];
    const ercDiag = equalRiskContribution(diag)!.weights;
    const iv = inverseVolatility(diag)!;
    ercDiag.forEach((w, i) => expect(w).toBeCloseTo(iv[i]!, 10));
    expect(equalRiskContribution([[0, 0], [0, 1]])).toBeNull();
  });

  it("caps weights without levering, leaving cash when everything is capped", () => {
    const capped = capWeights([0.7, 0.2, 0.1], 0.4);
    expect(Math.max(...capped)).toBeLessThanOrEqual(0.4 + 1e-12);
    expect(capped.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    const allCapped = capWeights([0.5, 0.5], 0.3);
    expect(allCapped).toEqual([0.3, 0.3]);
  });

  it("volatility targeting scales down only, never up", () => {
    const S = [[0.0004, 0], [0, 0.0004]];
    const high = volatilityTarget([0.5, 0.5], S, 0.05, 252)!;
    expect(high.scale).toBeLessThan(1);
    expect(Math.sqrt(portfolioVariance(high.weights, S) * 252)).toBeCloseTo(0.05, 10);
    const low = volatilityTarget([0.5, 0.5], S, 5, 252)!;
    expect(low.scale).toBe(1);
  });
});

describe("tail risk and stress", () => {
  it("historical VaR/ES are withheld below the minimum sample and ES ≥ VaR", () => {
    expect(historicalTail([0.01, -0.02])).toBeNull();
    // 90% of 100 observations leaves exactly 10 in the tail (binary rounding must not drop one).
    const ladder = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000);
    expect(historicalTail(ladder, 0.9)!.var).toBeCloseTo(0.041, 12);
    expect(() => historicalTail(ladder, 1)).toThrow();
    expect(() => historicalTail([...ladder.slice(1), Number.NaN], 0.9)).toThrow();
    const r = factorReturns(1000, [0.02], 1, 51).map((row) => row[0]!);
    const tail = historicalTail(r)!;
    expect(tail.expectedShortfall).toBeGreaterThanOrEqual(tail.var);
    expect(tail.var).toBeGreaterThan(0);
  });

  it("a correlation spike and volatility expansion raise diversified portfolio volatility", () => {
    const S = covarianceMatrix(factorReturns(800, [0.01, 0.02, 0.03], 0.2, 61))!;
    const stressed = stressCovariance(S, { volMultiplier: 2, correlationFloor: 0.9 });
    const w = inverseVolatility(S)!;
    expect(portfolioVariance(w, stressed)).toBeGreaterThan(4 * portfolioVariance(w, S));
    expect(() => stressCovariance(S, { volMultiplier: 0, correlationFloor: 0.5 })).toThrow();
  });

  it("scenario losses are unknown (null), not zero, when a held asset's market is not covered", () => {
    const crash = HYPOTHETICAL_SHOCKS.find((s) => s.name === "EQUITY_CRASH")!;
    const covered = scenarioLoss([0.5, 0.3, 0.2], ["BROAD_ETF", "LIQUID_MAJOR", "MAJOR_FX"], crash);
    expect(covered.portfolioReturn).toBeCloseTo(0.5 * -0.2 + 0.3 * -0.3, 12);
    expect(covered.unshockedAssets).toEqual([]);
    const missing = scenarioLoss([0.5, 0.3, 0.2], ["BROAD_ETF", "LIQUID_MAJOR", "COMMODITY"], crash);
    expect(missing.portfolioReturn).toBeNull();
    expect(missing.unshockedAssets).toEqual([2]);
    // Every scenario covers every warehouse cohort explicitly.
    for (const scenario of HYPOTHETICAL_SHOCKS) {
      expect(Object.keys(scenario.shocksByMarket).sort()).toEqual(["BROAD_ETF", "ESTABLISHED_SOLANA", "INACTIVE", "LIQUID_MAJOR", "MAJOR_FX", "SPECULATIVE_SOLANA"]);
    }
  });
});

describe("allocation backtest", () => {
  const config = { lookback: 60, rebalanceEvery: 20, costBpsPerSide: 10, shrink: true, periodsPerYear: 8760 };

  it("is point in time: changing returns from bar k onwards does not change results before k", () => {
    const X = factorReturns(400, [0.01, 0.02, 0.03], 0.4, 71);
    const base = backtestAllocation({ returns: X }, "EQUAL_RISK_CONTRIBUTION", config);
    const k = 250;
    const tampered = X.map((row, i) => (i >= k ? row.map((v) => v * -3) : row));
    const after = backtestAllocation({ returns: tampered }, "EQUAL_RISK_CONTRIBUTION", config);
    const cut = k - base.startIndex;
    expect(after.netReturns.slice(0, cut)).toEqual(base.netReturns.slice(0, cut));
    expect(after.netReturns.slice(cut)).not.toEqual(base.netReturns.slice(cut));
  });

  it("weights applied at a rebalance bar do not depend on that bar's own return", () => {
    const X = factorReturns(400, [0.01, 0.02, 0.03], 0.4, 73);
    for (const rule of ["INVERSE_VOLATILITY", "EQUAL_RISK_CONTRIBUTION"] as const) {
      const base = backtestAllocation({ returns: X }, rule, config);
      const k = base.rebalanceWeights[3]!.index;
      const tampered = X.map((row, i) => (i === k ? row.map((v, j) => (j === 0 ? v + 0.5 : v * -4)) : row));
      const after = backtestAllocation({ returns: tampered }, rule, config);
      expect(after.rebalanceWeights[3]).toEqual(base.rebalanceWeights[3]);
      // The tampered bar's gross return is the unchanged weights times the new returns.
      const w = base.rebalanceWeights[3]!.weights;
      expect(after.grossReturns[k - base.startIndex]).toBeCloseTo(w.reduce((s, wi, j) => s + wi * tampered[k]![j]!, 0), 12);
    }
  });

  it("charges costs: net never beats gross, and zero cost makes them equal", () => {
    const X = factorReturns(400, [0.01, 0.02, 0.03], 0.4, 81);
    const costly = backtestAllocation({ returns: X }, "INVERSE_VOLATILITY", config);
    expect(costly.costDrag).toBeGreaterThan(0);
    // Cost is exactly turnover × bps (simple sum), and the compounded drag is slightly smaller.
    expect(costly.costSum).toBeCloseTo((costly.turnover * config.costBpsPerSide) / 10_000, 15);
    expect(costly.costDrag).toBeLessThanOrEqual(costly.costSum);
    expect(costly.totalReturnNet).toBeLessThan(costly.totalReturnGross);
    const free = backtestAllocation({ returns: X }, "INVERSE_VOLATILITY", { ...config, costBpsPerSide: 0 });
    expect(free.totalReturnNet).toBeCloseTo(free.totalReturnGross, 12);
    // First rebalance trades from cash into a fully invested book: one-way turnover 1.
    expect(costly.turnover).toBeGreaterThanOrEqual(1);
  });

  it("weights drift with returns between rebalances", () => {
    // Two assets, equal weight, never rebalanced again: after one bar of +10% / −10% the next bar's gross
    // return uses drifted weights 0.55 / 0.45 (cash 0).
    const rows = Array.from({ length: 60 }, (_, k) => [0.001 * Math.sin(k), 0.001 * Math.cos(k)]);
    rows.push([0.1, -0.1], [0.02, 0.02], [0.02, 0]);
    const bt = backtestAllocation({ returns: rows }, "EQUAL_WEIGHT", { lookback: 60, rebalanceEvery: 1000, costBpsPerSide: 0, shrink: false, periodsPerYear: 252 });
    expect(bt.grossReturns[0]).toBeCloseTo(0, 15);
    expect(bt.grossReturns[1]).toBeCloseTo(0.02, 15);
    expect(bt.grossReturns[2]).toBeCloseTo(0.55 * 0.02, 15);
  });

  it("refuses ragged or non-finite input", () => {
    const X = factorReturns(100, [0.01, 0.02], 0.4, 93);
    expect(() => backtestAllocation({ returns: [...X, [0.01]] }, "EQUAL_WEIGHT", config)).toThrow(/ragged/);
    expect(() => backtestAllocation({ returns: [...X, [Number.NaN, 0]] }, "EQUAL_WEIGHT", config)).toThrow(/non-finite/);
  });

  it("withholds the Sharpe ratio below 100 bars and refuses a too-short look-back", () => {
    const X = factorReturns(120, [0.01, 0.02], 0.4, 91);
    const r = backtestAllocation({ returns: X }, "EQUAL_WEIGHT", config);
    expect(r.netReturns).toHaveLength(60);
    expect(r.sharpe).toBeNull();
    expect(r.sufficient).toBe(false);
    expect(r.evidence).toBe("RESEARCH_ONLY");
    expect(() => backtestAllocation({ returns: X }, "EQUAL_WEIGHT", { ...config, lookback: 10 })).toThrow();
  });
});

describe("portfolio report", () => {
  it("reports nothing it cannot support and labels itself research-only", () => {
    const thin = portfolioReport(toSeries(factorReturns(10, [0.01, 0.02], 0.3, 101)), { periodsPerYear: 8760 });
    expect(thin.sufficient).toBe(false);
    expect(thin.correlation).toBeNull();
    expect(thin.allocations.every((a) => a.weights === null)).toBe(true);
    expect(thin.evidence).toBe("RESEARCH_ONLY");
  });

  it("produces allocations, risk shares and scenarios on a sufficient fixture", () => {
    const report = portfolioReport(toSeries(factorReturns(500, [0.01, 0.02, 0.03], 0.5, 111), ["BROAD_ETF", "LIQUID_MAJOR", "SPECULATIVE_SOLANA"]), { periodsPerYear: 8760 });
    expect(report.sufficient).toBe(true);
    const erc = report.allocations.find((a) => a.rule === "EQUAL_RISK_CONTRIBUTION")!;
    erc.riskShares!.forEach((s) => expect(s).toBeCloseTo(1 / 3, 6));
    expect(erc.stressedVolatility!).toBeGreaterThan(erc.annualisedVolatility!);
    const collapse = erc.scenarios!.find((s) => s.name === "CRYPTO_LIQUIDITY_COLLAPSE")!;
    expect(collapse.unshockedAssets).toEqual([]);
    expect(collapse.portfolioReturn!).toBeLessThan(0);
  });
});
