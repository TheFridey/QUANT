import { describe, expect, it } from "vitest";
import { seededRng } from "../stats.js";
import { auditPrefixInvariance, buildDefaultFeatureRows, causalViolations, computeExtraFeatures, defaultFeatureSetSpec, EXTRA_FEATURE_NAMES, featureSetSpecHash, validateResearchBars, type CausalFeatureRow } from "./feature-set.js";
import { buildTradeLabels, netOfCost, type LabelSpec } from "./labels.js";
import { ML_PROTOCOL_VERSION } from "./ml.js";
import { aucScore, blockBootstrapInterval, blockBootstrapSample, innerCalibrationSplit, purgedWalkForwardSplits, type SplitRow } from "./ml2-eval.js";
import { applyCalibrator, fitIsotonicCalibrator, fitPlattCalibrator, fitRandomForest, predictForest } from "./ml2-learners.js";
import { buildMl2Dataset, createMemoryHoldoutGate, DEFAULT_ML2_CONFIG, ML2_PROTOCOL_VERSION, ml2Abstention, runMlPipeline, type Ml2Input } from "./ml2.js";
import type { ResearchBar } from "./simulate.js";

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

/**
 * Synthetic planted signal (test fixture only): a volume spike on bar i (random, 10% of bars) is followed by
 * three bars of +0.6% drift; otherwise drift is −0.25%/bar, so always-enter and buy-and-hold lose. Only the
 * spike bar's volume reveals the signal, through point-in-time volume features.
 */
function volumeSpikeSeries(n: number, seed: number): ResearchBar[] {
  const rng = seededRng(seed);
  const bars: ResearchBar[] = [];
  let p = 100;
  let boost = 0;
  for (let i = 0; i < n; i += 1) {
    const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
    const open = p;
    p = p * Math.exp((boost > 0 ? 0.006 : -0.0025) + 0.006 * z);
    if (boost > 0) boost -= 1;
    const spike = rng() < 0.1;
    if (spike) boost = 3;
    bars.push({ t: i * H, open, high: Math.max(open, p) * 1.001, low: Math.min(open, p) * 0.999, close: p, volume: (spike ? 5 : 1) * (1 + 0.3 * rng()) });
  }
  return bars;
}

const bar = (i: number, o: number, h: number, l: number, c: number): ResearchBar => ({ t: i * H, open: o, high: h, low: l, close: c, volume: 1 });
const SPEC: LabelSpec = { horizon: 6, feeBpsPerSide: 5, slippageBpsPerSide: 5 };

describe("executable labels (GENESIS-4)", () => {
  it("enters at the next open, exits at the horizon close, pays costs on both sides and records the purge boundary", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 102, 103, 101, 102), bar(2, 102, 104, 101, 103), bar(3, 103, 106, 102, 105), bar(4, 105, 106, 104, 105)];
    const labels = buildTradeLabels(bars, { horizon: 2, feeBpsPerSide: 10, slippageBpsPerSide: 10 }, { barMs: H });
    const l = labels[0]!;
    expect(l.entryIndex).toBe(1);
    expect(l.entryPrice).toBe(102);
    expect(l.exitIndex).toBe(2);
    expect(l.exitPrice).toBe(103);
    expect(l.endIndex).toBe(2);
    expect(l.decisionTime).toBe(H);
    expect(l.netReturn).toBeCloseTo((103 * (1 - 0.002)) / (102 * (1 + 0.002)) - 1, 12);
    expect(l.mfe).toBeCloseTo(104 / 102 - 1, 12);
    expect(l.mae).toBeCloseTo(101 / 102 - 1, 12);
    expect(labels[2]).not.toBeNull();
    expect(labels[3]).toBeNull(); // window runs past the data
  });

  it("assumes the stop first when one bar touches both stop and target, and exits a gap through the stop at the open", () => {
    const both = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 106, 94, 100), bar(3, 100, 100, 100, 100)];
    const l = buildTradeLabels(both, { horizon: 2, feeBpsPerSide: 0, slippageBpsPerSide: 0, stopPct: 0.05, targetPct: 0.05 }, { barMs: H })[0]!;
    expect(l.exitReason).toBe("STOP");
    expect(l.exitPrice).toBeCloseTo(95, 12);
    expect(l.targetBeforeStop).toBe(0);
    const gap = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 90, 91, 89, 90), bar(3, 90, 90, 90, 90)];
    const g = buildTradeLabels(gap, { horizon: 2, feeBpsPerSide: 0, slippageBpsPerSide: 0, stopPct: 0.05, targetPct: 0.05 }, { barMs: H })[0]!;
    expect(g.exitPrice).toBe(90);
    expect(g.endIndex).toBe(2); // excursions and volatility still read the whole horizon
    const target = [bar(0, 100, 100, 100, 100), bar(1, 100, 106, 99, 105), bar(2, 105, 105, 105, 105), bar(3, 105, 105, 105, 105)];
    const t = buildTradeLabels(target, { horizon: 2, feeBpsPerSide: 0, slippageBpsPerSide: 0, stopPct: 0.05, targetPct: 0.05 }, { barMs: H })[0]!;
    expect(t.exitReason).toBe("TARGET");
    expect(t.exitPrice).toBeCloseTo(105, 12); // never better than the target
    expect(t.targetBeforeStop).toBe(1);
  });

  it("does not let a label span a gap in the bar grid", () => {
    const bars = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1), bar(3, 1, 1, 1, 1), bar(4, 1, 1, 1, 1), bar(5, 1, 1, 1, 1)];
    const labels = buildTradeLabels(bars, { horizon: 2, feeBpsPerSide: 0, slippageBpsPerSide: 0 }, { barMs: H });
    expect(labels[0]).toBeNull();
    expect(labels[1]).toBeNull();
    expect(labels[2]).not.toBeNull();
  });
});

describe("feature-set versioning and causality (GENESIS-4)", () => {
  it("hashes the spec and its definitions with sha256, and any change alters the hash", () => {
    const a = defaultFeatureSetSpec(H);
    expect(featureSetSpecHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(featureSetSpecHash(a)).toBe(featureSetSpecHash(defaultFeatureSetSpec(H)));
    expect(featureSetSpecHash({ ...a, features: [...a.features].reverse() })).not.toBe(featureSetSpecHash(a));
    expect(featureSetSpecHash({ ...a, nullPolicy: "IMPUTE_TRAIN_MEDIAN" })).not.toBe(featureSetSpecHash(a));
    expect(defaultFeatureSetSpec(86_400_000).features.some((f) => f.startsWith("hour_"))).toBe(false);
  });

  it("extra OHLCV features are point-in-time (prefix-invariant)", () => {
    const bars = series(400, 3, () => 0);
    const full = computeExtraFeatures(bars, { barMs: H });
    for (const k of [120, 250, 399]) expect(computeExtraFeatures(bars.slice(0, k + 1), { barMs: H })[k]).toEqual(full[k]);
    expect(EXTRA_FEATURE_NAMES.every((f) => full[399]![f] !== null)).toBe(true);
  });

  it("flags values available after the decision time", () => {
    const rows: CausalFeatureRow[] = [{ index: 0, t: 0, availableAt: H, values: { a: 1, b: 2 }, featureAvailableAt: { b: 3 * H } }];
    const v = causalViolations(rows, ["a", "b"], () => H);
    expect(v).toEqual([{ index: 0, feature: "b", availableAt: 3 * H, decisionTime: H }]);
  });

  it("detects invalid timestamps and duplicated bars", () => {
    const ok = series(10, 4, () => 0);
    expect(validateResearchBars(ok, { barMs: H })).toEqual([]);
    const dup = [...ok.slice(0, 5), ok[4]!, ...ok.slice(5)];
    expect(validateResearchBars(dup, { barMs: H }).map((i) => i.code)).toContain("DUPLICATE_TIMESTAMP");
    const unordered = [ok[0]!, ok[2]!, ok[1]!, ...ok.slice(3)];
    expect(validateResearchBars(unordered, { barMs: H }).map((i) => i.code)).toContain("UNORDERED");
    const misaligned = ok.map((b, i) => (i === 3 ? { ...b, t: b.t + 1234 } : b));
    expect(validateResearchBars(misaligned, { barMs: H }).map((i) => i.code)).toContain("MISALIGNED");
    const nan = ok.map((b, i) => (i === 2 ? { ...b, t: Number.NaN } : b));
    expect(validateResearchBars(nan, { barMs: H }).map((i) => i.code)).toContain("NON_FINITE_TIME");
    expect(validateResearchBars(ok, { barMs: H, asOf: 5 * H }).map((i) => i.code)).toContain("NOT_YET_CLOSED");
  });
});

describe("purged and embargoed walk-forward (GENESIS-4)", () => {
  const rows: SplitRow[] = Array.from({ length: 1000 }, (_, i) => ({ index: i, endIndex: i + 10 }));

  it("purges every training row whose label window reaches the test window (overlapping labels)", () => {
    const folds = purgedWalkForwardSplits(rows, { scheme: "EXPANDING", folds: 4, embargoBars: 0 });
    expect(folds).toHaveLength(4);
    for (const f of folds) {
      expect(f.purged).toBe(10);
      for (const p of f.train) expect(rows[p]!.endIndex).toBeLessThan(f.testStartIndex);
      for (const p of f.train) expect(p).toBeLessThan(f.test[0]!);
    }
  });

  it("embargoes rows after every earlier test window, and the rolling scheme caps the training window", () => {
    const emb = 25;
    const folds = purgedWalkForwardSplits(rows, { scheme: "EXPANDING", folds: 4, embargoBars: emb });
    for (const f of folds) {
      for (const earlier of folds.filter((g) => g.fold < f.fold)) {
        for (const p of f.train) expect(rows[p]!.index > earlier.testEndIndex && rows[p]!.index <= earlier.testEndIndex + emb).toBe(false);
      }
    }
    expect(folds[0]!.embargoed).toBe(0);
    expect(folds[2]!.embargoed).toBe(emb);
    const rolling = purgedWalkForwardSplits(rows, { scheme: "ROLLING", folds: 4, embargoBars: 0, rollingTrainRows: 150 });
    for (const f of rolling) expect(f.train.length).toBeLessThanOrEqual(150);
  });

  it("purges the inner fit split against the calibration split", () => {
    const train = Array.from({ length: 400 }, (_, i) => i);
    const s = innerCalibrationSplit(rows, train, 0.25);
    expect(s.cal).toHaveLength(100);
    expect(Math.max(...s.fit.map((p) => rows[p]!.endIndex))).toBeLessThan(rows[s.cal[0]!]!.index);
    expect(s.purged).toBe(10);
  });
});

describe("block bootstrap (GENESIS-4)", () => {
  it("refuses a block shorter than the label horizon", () => {
    expect(() => blockBootstrapInterval(100, () => 0, { blockLength: 3, minBlockLength: 6 })).toThrow(/block length/);
  });

  it("moving blocks are contiguous runs of the block length; stationary blocks average it", () => {
    const rng = seededRng(5);
    const s = blockBootstrapSample(200, 10, "MOVING", rng);
    expect(s).toHaveLength(200);
    for (let b = 0; b < 200; b += 10) for (let k = 1; k < 10; k += 1) expect(s[b + k]).toBe(s[b]! + k);
    const st = blockBootstrapSample(20_000, 10, "STATIONARY", seededRng(6));
    let runs = 1;
    for (let i = 1; i < st.length; i += 1) if (st[i] !== (st[i - 1]! + 1) % 20_000) runs += 1;
    expect(st.length / runs).toBeGreaterThan(8);
    expect(st.length / runs).toBeLessThan(12);
  });

  it("gives a wider interval than an iid resample on overlapping (serially dependent) observations", () => {
    // Overlapping 20-bar sums of iid noise: strongly autocorrelated, like overlapping labels.
    const rng = seededRng(8);
    const e = Array.from({ length: 2020 }, () => rng() - 0.5);
    const xs = Array.from({ length: 2000 }, (_, i) => e.slice(i, i + 20).reduce((a, b) => a + b, 0));
    const meanAt = (pos: number[]) => pos.reduce((a, i) => a + xs[i]!, 0) / pos.length;
    const iid = blockBootstrapInterval(xs.length, meanAt, { blockLength: 1, resamples: 400, seed: 1 })!;
    const block = blockBootstrapInterval(xs.length, meanAt, { blockLength: 40, minBlockLength: 20, resamples: 400, seed: 1 })!;
    expect(block.upper - block.lower).toBeGreaterThan(2 * (iid.upper - iid.lower));
  });
});

describe("learners and calibration (GENESIS-4)", () => {
  it("random forest is deterministic per seed and learns a separable signal", () => {
    const rng = seededRng(9);
    const Z = Array.from({ length: 600 }, () => [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]);
    const y = Z.map((z) => (z[0]! > 0 ? 1 : 0));
    const a = fitRandomForest(Z, y, { seed: 3, trees: 10, minLeaf: 10 });
    const b = fitRandomForest(Z, y, { seed: 3, trees: 10, minLeaf: 10 });
    const c = fitRandomForest(Z, y, { seed: 4, trees: 10, minLeaf: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(aucScore(Z.map((z) => predictForest(a, z)), y)!).toBeGreaterThan(0.9);
    expect(() => fitRandomForest(Z, y, { trees: 0 })).toThrow(/invalid forest/);
  });

  it("Platt and isotonic calibration repair a miscalibrated score on fresh data", () => {
    const rng = seededRng(10);
    const draw = (n: number) => {
      const truth = Array.from({ length: n }, () => 0.1 + 0.8 * rng());
      const y = truth.map((p) => (rng() < p ? 1 : 0));
      // Over-confident raw score: logit scaled ×3.
      const raw = truth.map((p) => 1 / (1 + Math.exp(-3 * Math.log(p / (1 - p)))));
      return { y, raw };
    };
    const ece = (p: number[], y: number[]) => {
      let e = 0;
      for (let b = 0; b < 10; b += 1) {
        const idx = p.map((_, i) => i).filter((i) => p[i]! >= b / 10 && (b === 9 ? p[i]! <= 1 : p[i]! < (b + 1) / 10));
        if (!idx.length) continue;
        e += (idx.length / p.length) * Math.abs(idx.reduce((s, i) => s + p[i]!, 0) / idx.length - idx.reduce((s, i) => s + y[i]!, 0) / idx.length);
      }
      return e;
    };
    const fit = draw(4000);
    const test = draw(4000);
    const platt = fitPlattCalibrator(fit.raw, fit.y);
    const iso = fitIsotonicCalibrator(fit.raw, fit.y);
    expect(platt.method).toBe("PLATT");
    const before = ece(test.raw, test.y);
    expect(before).toBeGreaterThan(0.08);
    expect(ece(test.raw.map((p) => applyCalibrator(platt, p)), test.y)).toBeLessThan(0.03);
    expect(ece(test.raw.map((p) => applyCalibrator(iso, p)), test.y)).toBeLessThan(0.04);
  });
});

describe("ML Engine 2.0 pipeline (GENESIS-4)", () => {
  const noise = series(5000, 21, () => 0);
  const planted = volumeSpikeSeries(7000, 31);
  const PLANTED_SPEC: LabelSpec = { horizon: 3, feeBpsPerSide: 5, slippageBpsPerSide: 5 };
  const input = (bars: ResearchBar[], extra: Partial<Ml2Input> = {}): Ml2Input => ({ bars, barMs: H, labelSpec: bars === planted ? PLANTED_SPEC : SPEC, ...extra });

  it("keeps the v1 protocol available and versions the new one", () => {
    expect(ML_PROTOCOL_VERSION).toBe("ml-wf-1.0.0");
    expect(ML2_PROTOCOL_VERSION).toBe("ml-wf-2.0.0");
  });

  it("refuses duplicated bars and invalid timestamps", () => {
    const dup = [...noise.slice(0, 600), noise[599]!, ...noise.slice(600, 1200)];
    expect(() => runMlPipeline(input(dup))).toThrow(/REFUSED: .*DUPLICATE_TIMESTAMP/);
    const bad = noise.slice(0, 1200).map((b, i) => (i === 700 ? { ...b, t: b.t + 17 } : b));
    expect(() => runMlPipeline(input(bad))).toThrow(/REFUSED: .*MISALIGNED/);
  });

  it("leakage injection: refuses a feature whose availability is after the decision time", () => {
    const bars = noise.slice(0, 1500);
    const builder = (b: readonly ResearchBar[]) =>
      buildDefaultFeatureRows(b, { barMs: H }).map((r) => ({ ...r, values: { ...r.values, leak: 0 }, featureAvailableAt: { leak: r.availableAt + 6 * H } }));
    const spec = { ...defaultFeatureSetSpec(H), features: [...defaultFeatureSetSpec(H).features, "leak"] };
    expect(() => runMlPipeline(input(bars, { featureBuilder: builder, featureSet: spec }))).toThrow(/REFUSED: .*available after the decision time/);
  });

  it("leakage injection: refuses a future-reading feature even when its availability metadata lies", () => {
    const bars = noise.slice(0, 1500);
    const builder = (b: readonly ResearchBar[]) =>
      buildDefaultFeatureRows(b, { barMs: H }).map((r) => ({ ...r, values: { ...r.values, leak: b[r.index + 6] ? Math.log(b[r.index + 6]!.close / b[r.index]!.close) : null } }));
    const spec = { ...defaultFeatureSetSpec(H), features: [...defaultFeatureSetSpec(H).features, "leak"] };
    const audit = auditPrefixInvariance(bars, builder, ["leak"], [900, 1200]);
    expect(audit.violations.length).toBeGreaterThan(0);
    expect(() => runMlPipeline(input(bars, { featureBuilder: builder, featureSet: spec }))).toThrow(/REFUSED: feature leak changes when later bars are removed/);
  });

  it("spreads 12 prefix-audit probes over the whole series and catches look-ahead confined to the first half", () => {
    const bars = noise.slice(0, 1500);
    const ds = buildMl2Dataset(input(bars));
    expect(ds.probes).toHaveLength(12);
    expect(Math.min(...ds.probes)).toBeLessThan(bars.length / 4);
    expect(Math.max(...ds.probes)).toBe(bars.length - 2);
    // Reads the next bar only before bar 700: invisible to probes placed only in the second half.
    const builder = (b: readonly ResearchBar[]) =>
      buildDefaultFeatureRows(b, { barMs: H }).map((r) => ({ ...r, values: { ...r.values, early_leak: r.index < 700 ? (b[r.index + 1]?.close ?? null) : b[r.index]!.close } }));
    const spec = { ...defaultFeatureSetSpec(H), features: [...defaultFeatureSetSpec(H).features, "early_leak"] };
    expect(() => runMlPipeline(input(bars, { featureBuilder: builder, featureSet: spec }))).toThrow(/REFUSED: feature early_leak changes when later bars are removed/);
  });

  it("fits preprocessing on each fold's inner training rows only (parameters differ by fold, never see test rows)", () => {
    const report = runMlPipeline(input(noise));
    const ds = buildMl2Dataset(input(noise));
    const holdoutStart = Math.floor(ds.rows.length * (1 - DEFAULT_ML2_CONFIG.holdoutFraction));
    const firstHoldout = ds.rows[holdoutStart]!.index;
    const pre = ds.rows.slice(0, holdoutStart).filter((r) => r.endIndex < firstHoldout);
    const splits = purgedWalkForwardSplits(pre, { scheme: "EXPANDING", folds: DEFAULT_ML2_CONFIG.folds, embargoBars: report.data.embargoBars, rollingTrainRows: null });
    const used = report.folds.filter((f) => f.preprocessor);
    expect(used.length).toBeGreaterThanOrEqual(3);
    for (const f of used) {
      const split = splits.find((s) => s.fold === f.fold)!;
      const inner = innerCalibrationSplit(pre, split.train, DEFAULT_ML2_CONFIG.calFraction);
      const fitRows = inner.fit.map((p) => pre[p]!);
      const m0 = fitRows.reduce((s, r) => s + r.x[0]!, 0) / fitRows.length;
      expect(f.preprocessor!.mean[0]).toBeCloseTo(m0, 10);
      expect(f.preprocessor!.rows).toBe(fitRows.length);
      expect(f.lastFitEndIndex!).toBeLessThan(f.testStartIndex);
    }
    expect(new Set(used.map((f) => f.preprocessor!.mean[0])).size).toBe(used.length);
  }, 120_000);

  it("returns NO_SKILL or INSUFFICIENT_EVIDENCE on pure noise, never reads the holdout, and records every trial", () => {
    const gate = createMemoryHoldoutGate();
    const report = runMlPipeline(input(noise, { holdout: { gate, key: "noise" }, priorTrialCount: 1594 }));
    expect(["NO_SKILL", "INSUFFICIENT_EVIDENCE"]).toContain(report.verdict);
    expect(report.holdout.evaluated).toBe(false);
    expect(gate.consumed.size).toBe(0);
    expect(report.trialCount).toBe(4);
    expect(report.programmeTrialCount).toBe(1598);
    expect(report.trials.map((t) => t.family)).toEqual(["BASE_RATE", "LOGISTIC_L2", "BOOSTED_STUMPS", "RANDOM_FOREST"]);
  }, 120_000);

  it("finds a planted, cost-surviving signal, evaluates the holdout exactly once, and is deterministic", () => {
    const gate = createMemoryHoldoutGate();
    const a = runMlPipeline(input(planted, { holdout: { gate, key: "planted" } }));
    const wf = a.walkForward[a.championTrialId!]!;
    expect(wf.brierSkill!).toBeGreaterThan(0);
    expect(wf.aucCi!.lower).toBeGreaterThan(0.5);
    expect(wf.expectancy.map((e) => e.costMultiplier)).toEqual([1, 2, 3]);
    expect(wf.expectancy[1]!.ci!.lower).toBeGreaterThan(0);
    expect(wf.expectancy[0]!.alwaysEnter!).toBeLessThan(0);
    expect(wf.randomControl.pValue!).toBeLessThanOrEqual(0.05);
    expect(a.verdict).toBe("CANDIDATE");
    expect(a.holdout.evaluated).toBe(true);
    expect(gate.consumed.has("planted")).toBe(true);
    // Second look at the same holdout is refused.
    const again = runMlPipeline(input(planted, { holdout: { gate, key: "planted" } }));
    expect(again.holdout.evaluated).toBe(false);
    expect(again.verdict).toBe("INSUFFICIENT_EVIDENCE");
    // Same seed, same artefacts and report.
    expect(again.artefacts).toEqual(a.artefacts);
    expect(JSON.stringify(again.walkForward)).toBe(JSON.stringify(a.walkForward));
    // A different seed changes the forest artefact only.
    const other = runMlPipeline(input(planted, { config: { seed: 2 } }));
    const forest = (r: typeof a) => r.artefacts.find((x) => x.family === "RANDOM_FOREST")!.hash;
    const logistic = (r: typeof a) => r.artefacts.find((x) => x.family === "LOGISTIC_L2")!.hash;
    expect(forest(other)).not.toBe(forest(a));
    expect(logistic(other)).toBe(logistic(a));
  }, 240_000);

  it("the same signal under heavy costs is not a candidate", () => {
    const heavy = runMlPipeline({ bars: planted, barMs: H, labelSpec: { horizon: 3, feeBpsPerSide: 25, slippageBpsPerSide: 15 }, holdout: { gate: createMemoryHoldoutGate(), key: "heavy" } });
    expect(["REJECTED_COSTS", "SKILL_NOT_ECONOMIC"]).toContain(heavy.verdict);
    const wf = heavy.walkForward[heavy.championTrialId!]!;
    // Expectancy falls monotonically with the cost multiplier.
    expect(wf.expectancy[0]!.mean!).toBeGreaterThan(wf.expectancy[1]!.mean!);
    expect(wf.expectancy[1]!.mean!).toBeGreaterThan(wf.expectancy[2]!.mean!);
  }, 120_000);

  it("records a failing configuration in the trial ledger instead of dropping it", () => {
    const report = runMlPipeline(input(noise, { learners: [{ family: "BASE_RATE" }, { family: "LOGISTIC_L2" }, { family: "RANDOM_FOREST", params: { trees: 0 } }] }));
    const forest = report.trials.find((t) => t.family === "RANDOM_FOREST")!;
    expect(forest.status).toBe("FAILED");
    expect(forest.error).toMatch(/invalid forest/);
    expect(report.trialCount).toBe(3);
  }, 120_000);

  it("abstains on a stale training cutoff or drift", () => {
    const report = runMlPipeline(input(noise));
    const art = Object.values(report.finalArtefacts).find((a) => a.family === "LOGISTIC_L2")!;
    const fresh = ml2Abstention({ artefact: art, asOf: art.trainedThroughTime + H, maxStalenessMs: 7 * 86_400_000 });
    expect(fresh.abstain).toBe(false);
    const stale = ml2Abstention({ artefact: art, asOf: art.trainedThroughTime + 30 * 86_400_000, maxStalenessMs: 7 * 86_400_000 });
    expect(stale.reasons.join()).toMatch(/STALE/);
    const drift = ml2Abstention({ artefact: art, asOf: art.trainedThroughTime, maxStalenessMs: 7 * 86_400_000, drift: [{ feature: "vol_m", psi: 0.6 }], maxPsi: 0.25 });
    expect(drift.reasons.join()).toMatch(/DRIFT/);
    const decay = ml2Abstention({ artefact: art, asOf: art.trainedThroughTime, maxStalenessMs: 7 * 86_400_000, brierDecay: 0.05, maxBrierDecay: 0.02 });
    expect(decay.reasons.join()).toMatch(/BRIER_DECAY/);
  }, 120_000);

  it("net-of-cost arithmetic matches the label definition", () => {
    expect(netOfCost(0.01, 0.001)).toBeCloseTo((1.01 * 0.999) / 1.001 - 1, 14);
  });
});
