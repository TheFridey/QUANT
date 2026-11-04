import { buildTradeLabels } from "@odin/backtest/ml2";
import { describe, expect, it } from "vitest";
import { prepareModelRegistration } from "./model-registry.js";
import { assessShadowHealth, checkPredictionTiming, parseShadowSpec, predictionRecordHash, predictLatestBar, resolvePrediction } from "./shadow.js";
import { computeLeaderboardRow, type LeaderboardInputRow } from "./shadow-leaderboard.js";
import { clampBudget, shadowBudgetFromEnv, shadowEnabled, SHADOW_BUDGET_CEILING } from "./shadow-config.js";
import { fixtureArtefact, fixtureRegistration, HOUR, syntheticBars } from "./test-fixtures.js";

const lastOpen = Date.parse("2026-11-04T10:00:00Z");
const decisionTime = lastOpen + HOUR;

function setup(kind: "base" | "logistic" = "logistic", nullPolicy?: "DROP_ROW" | "IMPUTE_TRAIN_MEDIAN") {
  const artefact = fixtureArtefact({ trainedThroughTime: lastOpen - 10 * HOUR, kind, nullPolicy });
  const reg = prepareModelRegistration(fixtureRegistration({ family: "shadow", version: "1", artefact }));
  const model = { id: "mv_1", validation: reg.data.validation, trainingProtocol: reg.data.trainingProtocol };
  return { artefact: reg.artefact, model, spec: parseShadowSpec(model), labelSpec: reg.data.labelDefinition };
}

describe("GENESIS shadow prediction timing", () => {
  const t = { decisionBarOpenTime: lastOpen, barMs: HOUR, horizonBars: 2 };
  it("predicts only after the decision bar closes, promptly, and before the horizon ends", () => {
    expect(checkPredictionTiming({ ...t, predictedAt: decisionTime - 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/^BEFORE_DECISION/) });
    expect(checkPredictionTiming({ ...t, predictedAt: decisionTime })).toEqual({ ok: true });
    expect(checkPredictionTiming({ ...t, predictedAt: decisionTime + HOUR })).toEqual({ ok: true });
    expect(checkPredictionTiming({ ...t, predictedAt: decisionTime + HOUR + 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/^LATE/) });
    expect(checkPredictionTiming({ ...t, horizonBars: 1, barMs: 2 * HOUR, predictedAt: lastOpen + 4 * HOUR })).toMatchObject({ ok: false, reason: expect.stringMatching(/^AFTER_HORIZON/) });
    expect(checkPredictionTiming({ ...t, predictedAt: decisionTime + 61_000, maxLatencyMs: 60_000 })).toMatchObject({ ok: false });
  });
});

describe("GENESIS shadow predictLatestBar", () => {
  const bars = syntheticBars(600, lastOpen);

  it("records a hashed prediction for the latest closed bar using only bars up to it", () => {
    const { artefact, model, spec, labelSpec } = setup();
    const out = predictLatestBar({ model, artefact, labelSpec, spec, instrumentKey: "TEST:GENESIS", bars, now: new Date(decisionTime + 5_000) });
    expect(out.kind).toBe("RECORD");
    if (out.kind !== "RECORD") return;
    const r = out.record;
    expect(r.status).toBe("PREDICTED");
    expect(r.decisionBarOpenTime.getTime()).toBe(lastOpen);
    expect(r.horizonEndsAt.getTime()).toBe(lastOpen + 3 * HOUR);
    expect(r.probability).toBeGreaterThan(0);
    expect(r.probability).toBeLessThan(1);
    expect(r.estimatedCostBps).toBe(30);
    expect(r.expectedNetReturn).toBeCloseTo(r.probability! * 0.01 + (1 - r.probability!) * -0.008, 12);
    expect(out.recordHash).toBe(predictionRecordHash(r));
    expect(predictionRecordHash({ ...r, probability: r.probability! + 1e-9 })).not.toBe(out.recordHash);
    // Appending later bars cannot change a prediction for the same decision bar (point-in-time features).
    const again = predictLatestBar({ model, artefact, labelSpec, spec, instrumentKey: "TEST:GENESIS", bars: bars.slice(0, -1), now: new Date(decisionTime - HOUR + 5_000) });
    expect(again.kind).toBe("RECORD");
  });

  it("skips unclosed, late or invalid bars and abstains on stale models", () => {
    const { artefact, model, spec, labelSpec } = setup();
    const base = { model, artefact, labelSpec, spec, instrumentKey: "TEST:GENESIS" };
    expect(predictLatestBar({ ...base, bars, now: new Date(decisionTime - 1) })).toMatchObject({ kind: "SKIP" });
    expect(predictLatestBar({ ...base, bars, now: new Date(decisionTime + HOUR + 1) })).toMatchObject({ kind: "SKIP", reason: expect.stringMatching(/^LATE/) });
    const disordered = [...bars.slice(0, -2), bars[bars.length - 1]!, bars[bars.length - 2]!];
    expect(predictLatestBar({ ...base, bars: disordered, now: new Date(decisionTime + 5_000) })).toMatchObject({ kind: "SKIP", reason: expect.stringMatching(/^BAD_BARS/) });
    const stale = predictLatestBar({ ...base, spec: { ...spec, maxStalenessMs: HOUR }, bars, now: new Date(decisionTime + 5_000) });
    expect(stale).toMatchObject({ kind: "RECORD", record: { status: "ABSTAINED", probability: null, abstainReasons: [expect.stringMatching(/^STALE/)] } });
  });

  it("refuses models without a shadow spec or with an unsupported target", () => {
    expect(() => parseShadowSpec({ trainingProtocol: {} })).toThrow(/NO_SHADOW_SPEC/);
    expect(() => parseShadowSpec({ trainingProtocol: { target: "TARGET_BEFORE_STOP", shadow: { barMs: HOUR, instrumentKeys: ["x"] } } })).toThrow(/TARGET_UNSUPPORTED/);
  });
});

describe("GENESIS shadow resolver", () => {
  const labelSpec = { horizon: 2, feeBpsPerSide: 10, slippageBpsPerSide: 5, stopPct: null, targetPct: null };
  const prediction = { id: "sp_1", decisionBarOpenTime: new Date(lastOpen), barMs: HOUR, horizonBars: 2, horizonEndsAt: new Date(lastOpen + 3 * HOUR) };
  const window = syntheticBars(3, lastOpen + 2 * HOUR);

  it("waits for the horizon, then resolves with the same labels as research", () => {
    expect(resolvePrediction({ prediction, labelSpec, bars: window, now: new Date(lastOpen + 3 * HOUR - 1) })).toEqual({ kind: "PENDING", reason: "HORIZON_NOT_ENDED" });
    const r = resolvePrediction({ prediction, labelSpec, bars: window, now: new Date(lastOpen + 3 * HOUR) });
    expect(r.kind).toBe("OUTCOME");
    if (r.kind !== "OUTCOME") return;
    const label = buildTradeLabels(window, labelSpec, { barMs: HOUR })[0]!;
    expect(r.outcome).toMatchObject({ hypotheticalFillAvailable: true, realisedNetReturn: label.netReturn, positive: label.netReturn > 0, mae: label.mae, mfe: label.mfe, costBpsApplied: 30, source: "HYPOTHETICAL_SHADOW" });
    expect(r.outcome.resolvedAt.getTime()).toBeGreaterThanOrEqual(prediction.horizonEndsAt.getTime());
  });

  it("refuses bars from before the decision bar or not yet closed", () => {
    const early = syntheticBars(4, lastOpen + 2 * HOUR);
    expect(resolvePrediction({ prediction, labelSpec, bars: early, now: new Date(lastOpen + 4 * HOUR) })).toMatchObject({ kind: "PENDING", reason: expect.stringMatching(/^SOURCE_VIOLATION/) });
    expect(resolvePrediction({ prediction, labelSpec, bars: window, now: new Date(lastOpen + 3 * HOUR - 1 + 1) })).toMatchObject({ kind: "OUTCOME" });
  });

  it("with a gap, waits for the grace period, then records no hypothetical fill", () => {
    const gap = [window[0]!, window[2]!];
    expect(resolvePrediction({ prediction, labelSpec, bars: gap, now: new Date(lastOpen + 4 * HOUR) })).toEqual({ kind: "PENDING", reason: "AWAITING_BARS" });
    const r = resolvePrediction({ prediction, labelSpec, bars: gap, now: new Date(lastOpen + 5 * HOUR) });
    expect(r).toMatchObject({ kind: "OUTCOME", outcome: { hypotheticalFillAvailable: false, realisedNetReturn: null, positive: null } });
  });
});

describe("GENESIS shadow health monitor", () => {
  const calibrated = Array.from({ length: 200 }, (_, i) => ({ probability: 0.5, positive: i % 2 === 0 }));
  const features = (shift: number) => Array.from({ length: 100 }, (_, i) => ({ f: i / 100 + shift }));
  const base = { referenceBrier: 0.25, referenceFeatures: [], recentFeatures: [], featureNames: ["f"], recentStatuses: [] as Array<"PREDICTED" | "ABSTAINED"> };

  it("keeps a calibrated model and suspends on miscalibration, Brier decay, drift or abstention", () => {
    expect(assessShadowHealth({ ...base, resolved: calibrated }).degrade).toBe(false);
    const overconfident = calibrated.map((r) => ({ ...r, probability: 0.9 }));
    const bad = assessShadowHealth({ ...base, resolved: overconfident });
    expect(bad.degrade).toBe(true);
    expect(bad.reasons.join(";")).toMatch(/CALIBRATION/);
    expect(bad.reasons.join(";")).toMatch(/BRIER_DECAY/);
    expect(assessShadowHealth({ ...base, resolved: [], referenceFeatures: features(0), recentFeatures: features(0) }).degrade).toBe(false);
    expect(assessShadowHealth({ ...base, resolved: [], referenceFeatures: features(0), recentFeatures: features(5) }).reasons[0]).toMatch(/^DRIFT/);
    const abstaining = Array.from({ length: 60 }, (_, i) => (i < 40 ? "ABSTAINED" : "PREDICTED") as "PREDICTED" | "ABSTAINED");
    expect(assessShadowHealth({ ...base, resolved: [], recentStatuses: abstaining }).reasons[0]).toMatch(/^ABSTENTION/);
  });

  it("does not judge calibration below the minimum number of outcomes", () => {
    expect(assessShadowHealth({ ...base, resolved: calibrated.slice(0, 10).map((r) => ({ ...r, probability: 0.99 })) }).degrade).toBe(false);
  });
});

describe("GENESIS shadow leaderboard maths", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  const rows: LeaderboardInputRow[] = Array.from({ length: 100 }, (_, i) => {
    const signal = i % 4 === 0;
    return { decisionTime: now - (200 - i) * HOUR, horizonEndsAt: now - (197 - i) * HOUR, status: "PREDICTED", probability: signal ? 0.7 : 0.4, abstainReasons: [], hashOk: true, outcome: { available: true, net: signal ? 0.02 : -0.01, positive: signal } };
  });

  it("computes coverage, calibration and the signal-minus-always-enter advantage with a CI", () => {
    const extra: LeaderboardInputRow[] = [
      { decisionTime: now - HOUR, horizonEndsAt: now + HOUR, status: "ABSTAINED", probability: null, abstainReasons: ["STALE: old"], hashOk: true, outcome: null },
      { decisionTime: now - HOUR, horizonEndsAt: now - 10 * HOUR, status: "PREDICTED", probability: 0.5, abstainReasons: [], hashOk: true, outcome: null },
      { decisionTime: now - HOUR, horizonEndsAt: now, status: "PREDICTED", probability: 0.5, abstainReasons: [], hashOk: false, outcome: null },
    ];
    const row = computeLeaderboardRow({ rows: [...rows, ...extra], entryThreshold: 0.55, horizonBars: 2, now, graceMs: 2 * HOUR });
    expect(row.predictions).toBe(101);
    expect(row.abstained).toBe(1);
    expect(row.coverage).toBeCloseTo(101 / 102, 12);
    expect(row.resolved).toBe(100);
    expect(row.overdue).toBe(1);
    expect(row.signals).toBe(25);
    expect(row.meanNetSignals).toBeCloseTo(0.02, 12);
    expect(row.meanNetAll).toBeCloseTo(0.25 * 0.02 + 0.75 * -0.01, 12);
    expect(row.netAdvantage!.estimate).toBeCloseTo(0.02 - (0.25 * 0.02 + 0.75 * -0.01), 12);
    expect(row.netAdvantage!.lower).toBeLessThanOrEqual(row.netAdvantage!.estimate);
    expect(row.netAdvantage!.upper).toBeGreaterThanOrEqual(row.netAdvantage!.estimate);
    expect(row.netAdvantage!.blockLength).toBe(2);
    expect(row.calibration!.baseRate).toBeCloseTo(0.25, 12);
    expect(row.calibration!.brier).toBeCloseTo(0.25 * 0.09 + 0.75 * 0.16, 12);
    expect(row.failureReasons).toMatchObject({ STALE: 1, OVERDUE_OUTCOME: 1, RECORD_HASH_MISMATCH: 1 });
  });

  it("withholds the advantage when evidence is thin", () => {
    const row = computeLeaderboardRow({ rows: rows.slice(0, 20), entryThreshold: 0.55, horizonBars: 2, now, graceMs: 0 });
    expect(row.netAdvantage).toBeNull();
    expect(row.netAdvantageNote).toMatch(/INSUFFICIENT_EVIDENCE/);
  });
});

describe("GENESIS shadow configuration", () => {
  it("is disabled unless the flag is exactly true, and budgets are clamped", () => {
    expect(shadowEnabled({})).toBe(false);
    expect(shadowEnabled({ GENESIS_SHADOW_ENABLED: "1" })).toBe(false);
    expect(shadowEnabled({ GENESIS_SHADOW_ENABLED: "TRUE" })).toBe(false);
    expect(shadowEnabled({ GENESIS_SHADOW_ENABLED: "true" })).toBe(true);
    expect(shadowBudgetFromEnv({ GENESIS_SHADOW_MAX_PREDICTIONS: "999999", GENESIS_SHADOW_MAX_MS: "-5" })).toMatchObject({ maxPredictions: SHADOW_BUDGET_CEILING.maxPredictions, maxMs: 20_000 });
    expect(clampBudget({ maxModels: 1e9 }).maxModels).toBe(SHADOW_BUDGET_CEILING.maxModels);
  });
});
