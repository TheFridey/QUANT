import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deflatedSharpe, DSR_PROTOCOL_VERSION, dsrPasses, probabilisticSharpe } from "./metrics.js";

/**
 * OPERATION INTEGRITY F04: Deflated Sharpe protocol dsr-2.0.0. The reference below is written independently of
 * `metrics.ts`: a different normal CDF (Zelen & Severo / A&S 26.2.17, |error| < 7.5e-8) and a quantile by
 * bisection on it, so a shared bug in `stats.ts` would show up as a disagreement.
 */
function refCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return x >= 0 ? 1 - tail : tail;
}
function refQuantile(p: number): number {
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (refCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
const GAMMA = 0.5772156649015329;
function refDsr(sr: number, n: number, skew: number, kurt: number, trialSharpes: number[], trialCount: number): number {
  const N = Math.max(1, trialSharpes.length, trialCount);
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  let v = 0;
  if (N >= 2) {
    const m = trialSharpes.reduce((s, x) => s + x, 0) / trialSharpes.length;
    const cross = trialSharpes.reduce((s, x) => s + (x - m) ** 2, 0) / (trialSharpes.length - 1);
    v = Math.max(cross, Math.max(1, denom) / (n - 1));
  }
  const bench = N < 2 ? 0 : Math.sqrt(v) * ((1 - GAMMA) * refQuantile(1 - 1 / N) + GAMMA * refQuantile(1 - 1 / (N * Math.E)));
  return refCdf(((sr - bench) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}

const degenerate = { sharpe: 0.125, n: 1_000, skew: 0, kurtosis: 3, trialSharpes: [0.125, 0.125, 0.125] };

describe("DSR protocol dsr-2.0.0 (F04)", () => {
  it("reproduces the original defect as fixed: identical trial Sharpes no longer ignore the trial count", () => {
    const dsrs = [3, 10, 100, 1_000, 10_000, 1e6, 1e9].map((trialCount) => deflatedSharpe({ ...degenerate, trialCount }));
    for (const d of dsrs) {
      expect(d.reason).toBeNull();
      expect(d.varianceSource).toBe("SAMPLING_FLOOR");
      expect(d.protocol).toBe(DSR_PROTOCOL_VERSION);
    }
    // Independent reviewer's figures (docs/integrity/F04-STATISTICAL-REVIEW.md).
    const expected = [0.99897, 0.99089, 0.91998, 0.75188, 0.52984, 0.17558, 0.01559];
    dsrs.forEach((d, i) => expect(d.dsr!).toBeCloseTo(expected[i]!, 4));
    for (let i = 1; i < dsrs.length; i += 1) expect(dsrs[i]!.dsr!).toBeLessThan(dsrs[i - 1]!.dsr!);
  });

  it("agrees with an independent reference implementation across a grid of inputs", () => {
    const cases: Array<[number, number, number, number, number[], number]> = [
      [0.125, 1_000, 0, 3, [0.125, 0.125, 0.125], 1_000],
      [0.08, 2_500, -0.4, 6, [0.01, 0.03, 0.05, 0.02, 0.08, -0.01], 50],
      [0.2, 300, 0.3, 4.5, [0.05, 0.12, 0.2, 0.15], 3_000],
      [0.05, 10_000, -1.2, 12, [0.0, 0.02, 0.05, 0.01], 1],
      [0.3, 150, 0.1, 3.2, [0.3, 0.1], 2],
    ];
    for (const [sr, n, skew, kurt, ts, tc] of cases) {
      const d = deflatedSharpe({ sharpe: sr, n, skew, kurtosis: kurt, trialSharpes: ts, trialCount: tc });
      // The reference quantile inherits ~1e-5 error in the far tail from its CDF approximation.
      expect(d.dsr!).toBeCloseTo(refDsr(sr, n, skew, kurt, ts, tc), 4);
    }
  });

  it("is monotone non-increasing in the trial count for fixed data (degenerate and dispersed trials)", () => {
    for (const trialSharpes of [[0.1, 0.1], [0.01, 0.03, 0.05, 0.02, 0.08, -0.01]]) {
      let prev = Number.POSITIVE_INFINITY;
      for (const trialCount of [1, 2, 3, 5, 10, 30, 100, 1e3, 1e4, 1e5, 1e6, 1e8, 1e12]) {
        const d = deflatedSharpe({ sharpe: 0.1, n: 1_500, skew: 0, kurtosis: 3, trialSharpes, trialCount }).dsr!;
        expect(d).toBeLessThanOrEqual(prev + 1e-12);
        prev = d;
      }
    }
  });

  it("uses the larger of cross-trial variance and the floor, never their sum", () => {
    const wide = deflatedSharpe({ sharpe: 0.1, n: 1_000, skew: 0, kurtosis: 3, trialSharpes: [-0.2, 0.0, 0.2, 0.4], trialCount: 100 });
    expect(wide.varianceSource).toBe("CROSS_TRIAL");
    expect(wide.variance).toBeCloseTo((0.2 ** 2 * 5) / 3, 12);
    const tight = deflatedSharpe({ sharpe: 0.1, n: 1_000, skew: 0, kurtosis: 3, trialSharpes: [0.1, 0.1001], trialCount: 100 });
    expect(tight.varianceSource).toBe("SAMPLING_FLOOR");
    expect(tight.variance).toBeCloseTo(Math.max(1, 1 + (2 / 4) * 0.01) / 999, 12);
  });

  it("the floor numerator is clamped at 1: positive skew cannot push the floor below the null variance", () => {
    const d = deflatedSharpe({ sharpe: 0.3, n: 500, skew: 2, kurtosis: 9, trialSharpes: [0.3, 0.3], trialCount: 10 });
    // 1 − 2·0.3 + 2·0.09 = 0.58 < 1, so the floor is 1/(n − 1).
    expect(d.variance).toBeCloseTo(1 / 499, 12);
  });

  it("highly correlated trials (ML learners) are deflated by the full programme count, not their tiny spread", () => {
    const learners = [0.1, 0.1003, 0.0998, 0.1001];
    const d = deflatedSharpe({ sharpe: 0.1, n: 800, skew: 0, kurtosis: 3, trialSharpes: learners, trialCount: 3_000 });
    expect(d.varianceSource).toBe("SAMPLING_FLOOR");
    expect(d.trials).toBe(3_000);
    expect(d.dsr!).toBeLessThan(0.95);
  });

  it("no selection (one trial): DSR equals PSR against zero", () => {
    const one = deflatedSharpe({ sharpe: 0.1, n: 1_000, skew: 0, kurtosis: 3, trialSharpes: [0.1] });
    expect(one.trials).toBe(1);
    expect(one.benchmark).toBe(0);
    expect(one.dsr!).toBeCloseTo(probabilisticSharpe({ sharpe: 0.1, benchmark: 0, n: 1_000, skew: 0, kurtosis: 3 })!, 12);
    expect(deflatedSharpe({ sharpe: 0.1, n: 1_000, skew: 0, kurtosis: 3, trialSharpes: [] }).dsr).toBe(one.dsr);
  });

  it.each([
    ["one finite trial Sharpe but many trials", { trialSharpes: [0.1], trialCount: 1_000 }, "DSR_DISPERSION_UNESTIMABLE"],
    ["failed trials only", { trialSharpes: [Number.NaN, Number.POSITIVE_INFINITY], trialCount: 5 }, "DSR_DISPERSION_UNESTIMABLE"],
    ["non-finite Sharpe", { sharpe: Number.NaN }, "DSR_NONFINITE_INPUT"],
    ["non-finite n", { n: Number.NaN }, "DSR_NONFINITE_INPUT"],
    ["non-finite skew", { skew: Number.POSITIVE_INFINITY }, "DSR_NONFINITE_INPUT"],
    ["too few observations", { n: 99 }, "DSR_SAMPLE_TOO_SMALL"],
    ["impossible kurtosis (−2)", { kurtosis: -2 }, "DSR_INVALID_MOMENTS"],
    ["kurtosis below 1 + skew²", { skew: 2, kurtosis: 4.5 }, "DSR_INVALID_MOMENTS"],
    // With valid moments 1 − γ3·SR + (γ4−1)/4·SR² ≥ (γ3·SR/2 − 1)² ≥ 0; zero exactly at γ4 = 1 + γ3², SR = 2/γ3.
    ["zero PSR variance at the moment boundary", { sharpe: 1, skew: 2, kurtosis: 5 }, "DSR_VARIANCE_NONPOSITIVE"],
    ["NaN trial count", { trialCount: Number.NaN }, "DSR_INVALID_TRIAL_COUNT"],
    ["infinite trial count", { trialCount: Number.POSITIVE_INFINITY }, "DSR_INVALID_TRIAL_COUNT"],
    ["negative trial count", { trialCount: -1 }, "DSR_INVALID_TRIAL_COUNT"],
    ["trial count beyond float resolution", { trialCount: 1e17 }, "DSR_INVALID_TRIAL_COUNT"],
  ] as const)("insufficient evidence, explicitly: %s", (_name, patch, reason) => {
    const d = deflatedSharpe({ sharpe: 0.1, n: 1_000, skew: 0, kurtosis: 3, trialSharpes: [0.05, 0.1, 0.15], ...patch });
    expect(d).toMatchObject({ dsr: null, benchmark: null, reason, protocol: DSR_PROTOCOL_VERSION });
    expect(dsrPasses(d.dsr, 0.95)).toBe(false);
  });

  it("extreme but valid Sharpe ratios stay finite and bounded", () => {
    for (const sharpe of [-3, -0.5, 0, 0.5, 3]) {
      const d = deflatedSharpe({ sharpe, n: 5_000, skew: 0, kurtosis: 3, trialSharpes: [0.01, 0.02], trialCount: 1e6 });
      expect(d.dsr!).toBeGreaterThanOrEqual(0);
      expect(d.dsr!).toBeLessThanOrEqual(1);
    }
  });

  it("PSR never returns NaN (a NaN would pass `dsr < 0.95` checks)", () => {
    expect(probabilisticSharpe({ sharpe: 0.1, benchmark: 0, n: Number.NaN, skew: 0, kurtosis: 3 })).toBeNull();
    expect(probabilisticSharpe({ sharpe: 0.1, benchmark: Number.NaN, n: 1_000, skew: 0, kurtosis: 3 })).toBeNull();
    expect(probabilisticSharpe({ sharpe: 0.1, benchmark: 0, n: 1_000, skew: 0, kurtosis: -2 })).toBeNull();
  });

  it("the gate helper rejects null, NaN, undefined and sub-threshold values", () => {
    expect(dsrPasses(null, 0.95)).toBe(false);
    expect(dsrPasses(undefined, 0.95)).toBe(false);
    expect(dsrPasses(Number.NaN, 0.95)).toBe(false);
    expect(dsrPasses(0.9499, 0.95)).toBe(false);
    expect(dsrPasses(0.95, 0.95)).toBe(true);
  });

  it("every promotion gate uses the NaN-safe helper, and ML no longer assumes normal moments", () => {
    const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    expect(src("validate.ts")).toContain("!dsrPasses(effectiveDsr?.dsr, 0.95)");
    expect(src("validate.ts")).not.toMatch(/effectiveDsr\.dsr < 0\.95/);
    expect(src("ml2.ts")).toContain("!dsrPasses(dsr.dsr, cfg.minDsr)");
    expect(src("ml2.ts")).not.toMatch(/dsr\.dsr < cfg\.minDsr/);
    expect(src("ml2.ts")).not.toMatch(/skewness\(chosen\) \?\? 0|kurtosis\(chosen\) \?\? 3/);
    expect(src("intelligence.ts")).toContain("!dsrPasses(dsr.dsr, 0.95)");
  });
});
