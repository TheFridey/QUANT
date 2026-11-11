import { defaultFeatureSetSpec, featureSetSpecHash } from "@odin/backtest/ml2";
import { describe, expect, it } from "vitest";
import { shadowBlocker } from "./bridge.js";
import { evaluateUnit, preflightDataset, WalkForwardMismatch, type RawBars, type UnitJob } from "./evaluate.js";
import { normaliseInstrument, planCampaign } from "./spec.js";
import { evidenceStage, prospectiveEvidence, type ProspectiveRow, type StageInput } from "./stages.js";
import { syntheticFxBreakoutBars } from "./synthetic-fixtures.js";

const H = 3_600_000;
const baseSpec = (over: Record<string, unknown> = {}) => ({
  specVersion: "campaign-spec-1",
  name: "unit test campaign",
  synthetic: true,
  datasets: [{ key: "d1", source: { kind: "FILE", path: "x.csv", sha256: "a".repeat(64) }, market: "FX", instrument: "EUR/USD", interval: "1h", asOf: "2026-01-01T00:00:00Z" }],
  hypotheses: [{ kind: "STRATEGY", id: "hz_atr_breakout" }, { kind: "ML2" }],
  validation: { seed: 1 },
  ml: { seed: 1, bootstrapResamples: 50, randomControls: 20, prefixProbes: 2 },
  limits: { maxTrials: 5000, maxRuntimeMsPerUnit: 60_000, maxMemoryMbPerUnit: 512, maxConcurrency: 1, maxAttemptsPerUnit: 2 },
  holdoutPolicy: "WITHHELD_UNLESS_AUTHORIZED",
  ...over,
});

describe("campaign specification", () => {
  it("expands datasets x hypotheses with trial bounds taken from the declared grid", () => {
    const plan = planCampaign(baseSpec());
    expect(plan.units.map((u) => [u.seq, u.hypothesisKind, u.hypothesisId])).toEqual([[0, "STRATEGY", "hz_atr_breakout"], [1, "ML2", "ml2:h8"]]);
    const strategy = plan.units[0]!;
    const grid = (strategy.searchSpace as { grid: Record<string, unknown[]> }).grid;
    const points = Object.values(grid).reduce((n, values) => n * values.length, 1);
    // Every grid point in each of 4 folds, one test per fold, and the full pre-holdout grid.
    expect(strategy.plannedTrials).toBe(points * 4 + 4 + points);
    expect(plan.units[1]!.plannedTrials).toBe(4); // one trial per default learner: base rate, logistic, boosted stumps, random forest
    expect(plan.plannedTrials).toBe(strategy.plannedTrials + 4);
    expect(strategy.lineageKey).toBe("STRATEGY:BREAKOUT");
    expect(plan.units[1]!.lineageKey).toBe("ML2:NET_POSITIVE");
  });

  it("the same declaration hashes the same whatever the key order; any change is a different campaign", () => {
    const a = planCampaign(baseSpec());
    const reordered = Object.fromEntries(Object.entries(baseSpec()).reverse());
    expect(planCampaign(reordered).specHash).toBe(a.specHash);
    expect(planCampaign(baseSpec({ validation: { seed: 2 } })).specHash).not.toBe(a.specHash);
    expect(planCampaign(baseSpec({ limits: { ...baseSpec().limits, maxTrials: 4999 } })).specHash).not.toBe(a.specHash);
  });

  it("has no field through which a result could widen a grid or lower an acceptance rule", () => {
    for (const extra of [{ minDsr: 0.5 }, { grid: { lookback: [1, 2, 3] } }, { maxPbo: 0.9 }, { minOosTrades: 5 }]) expect(() => planCampaign(baseSpec(extra))).toThrow(/CAMPAIGN_SPEC/);
    expect(() => planCampaign(baseSpec({ hypotheses: [{ kind: "STRATEGY", id: "hz_atr_breakout", grid: { atrMult: [0.1] } }] }))).toThrow(/CAMPAIGN_SPEC/);
    expect(() => planCampaign(baseSpec({ validation: { seed: 1, holdoutFraction: 0 } }))).toThrow(/CAMPAIGN_SPEC/);
    expect(() => planCampaign(baseSpec({ holdoutPolicy: "EVALUATE" }))).toThrow(/CAMPAIGN_SPEC/);
  });

  it("cost assumptions may be raised, never lowered below the market default", () => {
    const withCosts = (costOverrides: Record<string, number>) => baseSpec({ datasets: [{ ...baseSpec().datasets[0], costOverrides }] });
    expect(() => planCampaign(withCosts({ feeBpsPerSide: 0 }))).not.toThrow(); // the FX default fee is 0
    expect(() => planCampaign(withCosts({ spreadFull: 0 }))).toThrow(/below the FX default/);
    expect(() => planCampaign(withCosts({ slippagePerSide: 0 }))).toThrow(/may raise cost assumptions, not lower them/);
    expect(() => planCampaign(withCosts({ spreadFull: 50, slippagePerSide: 50 }))).not.toThrow();
  });

  it("refuses unknown hypotheses, duplicates and plans above the declared trial limit before anything runs", () => {
    expect(() => planCampaign(baseSpec({ hypotheses: [{ kind: "STRATEGY", id: "hz_made_up" }] }))).toThrow(/unknown strategy hz_made_up/);
    expect(() => planCampaign(baseSpec({ hypotheses: [{ kind: "ML2" }, { kind: "ML2" }] }))).toThrow(/duplicate hypothesis/);
    expect(() => planCampaign(baseSpec({ datasets: [baseSpec().datasets[0], baseSpec().datasets[0]] }))).toThrow(/duplicate dataset key/);
    expect(() => planCampaign(baseSpec({ limits: { ...baseSpec().limits, maxTrials: 10 } }))).toThrow(/above limits.maxTrials 10/);
    expect(() => planCampaign(baseSpec({ limits: { ...baseSpec().limits, maxConcurrency: 64 } }))).toThrow(/CAMPAIGN_SPEC/);
    expect(() => planCampaign(baseSpec({ datasets: [{ ...baseSpec().datasets[0], asOf: "yesterday" }] }))).toThrow(/asOf/);
  });

  it("normalises instrument spellings to one key", () => {
    for (const spelling of ["EUR_USD", "EUR/USD", "eurusd", "fx:EURUSD", "csv:eur-usd"]) expect(normaliseInstrument(spelling)).toBe("EURUSD");
    expect(normaliseInstrument("XAU_USD")).not.toBe(normaliseInstrument("EUR_USD"));
    expect(() => normaliseInstrument("::")).toThrow();
  });
});

describe("deterministic unit evaluation (synthetic FX fixture)", () => {
  const bars = syntheticFxBreakoutBars({ start: "2024-06-02T22:00:00Z", bars: 2600, seed: 42 });
  const plan = planCampaign(baseSpec());
  const raw = (b = bars, availableAt: number[] | null = null): RawBars => ({ bars: b, availableAt, tickVolumes: null, source: { kind: "FILE", path: "x.csv" } });
  const job = (over: Partial<UnitJob> = {}): UnitJob => ({ mode: "WALK_FORWARD", unit: plan.units[0]!, dataset: plan.spec.datasets[0]!, validation: plan.spec.validation, ml: plan.spec.ml, codeVersion: "abc1234", priorTrials: 100, raw: raw(), ...over });

  it("the same frozen inputs give the same result hash; any input change gives another", () => {
    const a = evaluateUnit(job());
    const b = evaluateUnit(JSON.parse(JSON.stringify(job())) as UnitJob); // through a job file, as the executor does
    expect(a.phase).toBe("WALK_FORWARD");
    expect(b.resultHash).toBe(a.resultHash);
    expect(b.walkForwardHash).toBe(a.walkForwardHash);
    expect(a.trialCount).toBeGreaterThan(0);
    expect(a.trialCount).toBeLessThanOrEqual(plan.units[0]!.plannedTrials);
    expect(evaluateUnit(job({ validation: { ...plan.spec.validation, seed: 2 } })).resultHash).not.toBe(a.resultHash);
    expect(evaluateUnit(job({ codeVersion: "def5678" })).resultHash).not.toBe(a.resultHash);
    const nudged = bars.map((x, i) => (i === 1000 ? { ...x, close: x.close * 1.0001, high: Math.max(x.high, x.close * 1.0001) } : x));
    const c = evaluateUnit(job({ raw: raw(nudged) }));
    expect(c.dataset.contentHash).not.toBe(a.dataset.contentHash);
    expect(c.resultHash).not.toBe(a.resultHash);
    // A walk-forward evaluation never reads the holdout.
    expect(["NOT_REACHED", "WITHHELD"]).toContain(a.holdoutStatus);
    expect((a.summary as { holdout: { evaluated: boolean } }).holdout.evaluated).toBe(false);
  }, 60_000);

  it("bars not available at the declared as-of instant cannot change the result (available-at enforcement)", () => {
    const cut = 2200;
    const asOf = new Date(bars[cut - 1]!.t + H).toISOString(); // the instant bar cut-1 closes
    const dataset = { ...plan.spec.datasets[0]!, asOf };
    const prefixOnly = evaluateUnit(job({ dataset, raw: raw(bars.slice(0, cut)) }));
    const withFuture = evaluateUnit(job({ dataset, raw: raw(bars) }));
    expect(withFuture.dataset.bars).toBe(cut);
    expect(withFuture.dataset.cleaning.notAvailableAtAsOf).toBe(bars.length - cut);
    expect(withFuture.dataset.contentHash).toBe(prefixOnly.dataset.contentHash);
    expect(withFuture.walkForwardHash).toBe(prefixOnly.walkForwardHash);
    // The future bars are in the job but not in the result; only the recorded count of dropped bars differs.
    expect((withFuture.detail as { strategy: { trials: unknown[] } }).strategy.trials).toEqual((prefixOnly.detail as { strategy: { trials: unknown[] } }).strategy.trials);

    // With explicit availability, a bar published late is dropped even though its open time is early.
    const availability = bars.map((x) => x.t + H);
    availability[cut - 1] = Date.parse(asOf) + 1; // one millisecond too late
    const late = preflightDataset(dataset, raw(bars, availability));
    expect(late.identity.bars).toBe(cut - 1);
    // A bar that became available after its own close (but before as-of) is used by nothing that decides at the close.
    const delayed = bars.slice(0, cut).map((x) => x.t + H);
    delayed[500] = bars[500]!.t + 5 * H;
    const rejected = evaluateUnit(job({ dataset, raw: raw(bars.slice(0, cut), delayed) }));
    expect(rejected.verdict).toBe("REJECTED_DATA");
    expect(rejected.reasons.join(" ")).toMatch(/became available after their close/);
  }, 60_000);

  it("refuses bad data before any trial and says why", () => {
    const duplicated = [...bars.slice(0, 10), bars[9]!, ...bars.slice(10)];
    const out = evaluateUnit(job({ raw: raw(duplicated) }));
    expect(out).toMatchObject({ phase: "DATA_REFUSAL", verdict: "REJECTED_DATA", trialCount: 0, walkForwardPassed: false, holdoutStatus: "NOT_REACHED" });
    expect(out.reasons[0]).toMatch(/DUPLICATE_TIMESTAMP/);
    expect(evaluateUnit(job({ raw: raw([]) })).reasons[0]).toMatch(/NO_BARS/);
  });

  it("a holdout evaluation that does not reproduce the authorised walk-forward is discarded", () => {
    expect(() => evaluateUnit(job({ mode: "HOLDOUT", expectedWalkForwardHash: "f".repeat(64) }))).toThrow(WalkForwardMismatch);
  }, 60_000);
});

describe("evidence stages", () => {
  const base: StageInput = { hypothesisKind: "ML2", unitState: "SUCCEEDED", lastError: null, walkForward: null, holdout: null, holdoutAuthorised: false, model: null, prospective: null, shadowBlocker: null };
  const wfPass = { phase: "WALK_FORWARD", verdict: "INSUFFICIENT_EVIDENCE", walkForwardPassed: true, reasons: ["walk-forward passed; holdout withheld"] };
  const holdoutPass = { verdict: "CANDIDATE", holdoutStatus: "EVALUATED", reasons: ["pass"] };
  const sufficient = { sufficient: true, missing: [], predictions: 400, abstained: 0 } as unknown as StageInput["prospective"];

  it("keeps the six states distinct and never calls any of them executable", () => {
    const cases: Array<[Partial<StageInput>, string | null, string]> = [
      [{ unitState: "PENDING" }, null, "QUEUED"],
      [{ unitState: "FAILED", lastError: "RUNTIME_LIMIT" }, null, "FAILED"],
      [{ walkForward: { phase: "DATA_REFUSAL", verdict: "REJECTED_DATA", walkForwardPassed: false, reasons: ["BAR_INTEGRITY"] } }, "HISTORICAL_RESULT", "DATA_REFUSED"],
      [{ walkForward: { phase: "WALK_FORWARD", verdict: "REJECTED_COSTS", walkForwardPassed: false, reasons: ["gross +1.5% turns into net -0.05%"] } }, "HISTORICAL_RESULT", "REJECTED_COSTS"],
      [{ walkForward: wfPass }, "PENDING_HOLDOUT", "WITHHELD"],
      [{ walkForward: wfPass, holdoutAuthorised: true }, "PENDING_HOLDOUT", "AUTHORISED_NOT_EVALUATED"],
      [{ walkForward: wfPass, holdoutIntentOpen: true }, "PENDING_HOLDOUT", "CONSUMED_AWAITING_RESULT"],
      [{ walkForward: wfPass, holdout: { verdict: "REJECTED_OVERFIT", holdoutStatus: "EVALUATED", reasons: ["holdout Brier skill -0.01"] } }, "HOLDOUT_EVALUATED", "HOLDOUT_FAILED"],
      [{ walkForward: wfPass, holdout: { verdict: "HOLDOUT_CONSUMED_RESULT_LOST", holdoutStatus: "CONSUMED_RESULT_LOST", reasons: ["lost"] } }, "HOLDOUT_EVALUATED", "RESULT_LOST"],
      [{ walkForward: wfPass, holdout: holdoutPass }, "HOLDOUT_EVALUATED", "HOLDOUT_PASSED_RESEARCH_ONLY"],
      [{ walkForward: wfPass, holdout: holdoutPass, model: { id: "m", state: "EXPERIMENTAL", stateReason: null } }, "HOLDOUT_EVALUATED", "MODEL_EXPERIMENTAL"],
      [{ walkForward: wfPass, holdout: holdoutPass, model: { id: "m", state: "SHADOW_CANDIDATE", stateReason: null } }, "PROSPECTIVE_OBSERVATION", "NO_PREDICTIONS_YET"],
      [{ walkForward: wfPass, holdout: holdoutPass, model: { id: "m", state: "REJECTED", stateReason: "SUSPENDED_BY_MONITOR: DRIFT" } }, "PROSPECTIVE_OBSERVATION", "OBSERVATION_ENDED_REJECTED"],
      [{ walkForward: wfPass, holdout: holdoutPass, model: { id: "m", state: "SHADOW_CANDIDATE", stateReason: null }, prospective: sufficient }, "SUFFICIENT_PROSPECTIVE_EVIDENCE", "MINIMUMS_MET"],
    ];
    for (const [over, stage, status] of cases) {
      const view = evidenceStage({ ...base, ...over });
      expect([view.stage, view.status], JSON.stringify(over)).toEqual([stage, status]);
      expect(view.executable).toBe(false);
      expect(view.stage).not.toBe("PAPER_EXECUTION_READINESS"); // never granted by research evidence
    }
  });

  it("a rejection shows its reason; a rule-based result that passed its holdout names the missing prospective route", () => {
    const rejected = evidenceStage({ ...base, walkForward: { phase: "WALK_FORWARD", verdict: "REJECTED_COSTS", walkForwardPassed: false, reasons: ["gross +1.5% turns into net -0.05%"] } });
    expect(rejected.why).toBe("gross +1.5% turns into net -0.05%");
    const blocker = shadowBlocker({ hypothesisKind: "STRATEGY", calendar: "FX_24_5", featureSetHash: null, barMs: H });
    const strategy = evidenceStage({ ...base, hypothesisKind: "STRATEGY", walkForward: wfPass, holdout: { verdict: "VALIDATED_CANDIDATE", holdoutStatus: "EVALUATED", reasons: [] }, shadowBlocker: blocker });
    expect(strategy.status).toBe("HOLDOUT_PASSED_RESEARCH_ONLY");
    expect(strategy.missing[0]).toMatch(/rule-based strategies have no prospective scorer/);
    expect(evidenceStage({ ...base, unitState: "PENDING" }).why).toMatch(/unknown, not zero/);
  });

  it("prospective observation is offered only where the shadow service computes the same features", () => {
    const ok = featureSetSpecHash(defaultFeatureSetSpec(H));
    expect(shadowBlocker({ hypothesisKind: "ML2", calendar: "CRYPTO_24_7", featureSetHash: ok, barMs: H })).toBeNull();
    expect(shadowBlocker({ hypothesisKind: "ML2", calendar: "FX_24_5", featureSetHash: ok, barMs: H })).toMatch(/24\/7 grid/);
    expect(shadowBlocker({ hypothesisKind: "ML2", calendar: "CRYPTO_24_7", featureSetHash: featureSetSpecHash(defaultFeatureSetSpec(H, { volume: false })), barMs: H })).toMatch(/default feature set/);
  });
});

describe("prospective evidence", () => {
  /** Hourly decisions with a 4-bar horizon: consecutive outcome windows overlap. Even hours are signals. */
  const rows = (n: number, over: (i: number) => Partial<ProspectiveRow> = () => ({})): ProspectiveRow[] =>
    Array.from({ length: n }, (_, i) => ({ decisionTime: i * H, horizonEndsAt: i * H + 4 * H, status: "PREDICTED" as const, probability: i % 2 === 0 ? 0.97 : 0.03, abstainReasons: [], hashOk: true, outcome: { available: true, net: i % 2 === 0 ? 0.004 : -0.002, positive: i % 2 === 0 }, costBpsApplied: 30, estimatedCostBps: 30, features: null, ...over(i) }));
  const evaluate = (r: ProspectiveRow[], target = 30) => prospectiveEvidence({ rows: r, entryThreshold: 0.55, horizonBars: 4, barMs: H, referenceBrier: 0.2, featureNames: [], now: 10_000 * H, targetEffectiveSignals: target });

  it("counts independent outcomes, not overlapping ones, and waits for the declared observation length", () => {
    const e = evaluate(rows(100));
    expect(e.resolved).toBe(100);
    // One window starts every hour and lasts four: only every fourth outcome is independent.
    expect(e.effectiveOutcomes).toBe(25);
    expect(e.overlapShare).toBeCloseTo(0.75, 12);
    // Signals are the even hours; a signal window blocks the next 4 hours, so every other signal counts.
    expect(e.signals).toBe(50);
    expect(e.effectiveSignals).toBe(25);
    expect(e.observation).toEqual({ targetEffectiveSignals: 30, reached: false, judgedOn: "NOT_YET_JUDGED" });
    expect(e.sufficient).toBe(false);
    expect(e.missing.join(" ")).toMatch(/25 of the 30 independent signals declared at registration/);
    expect(e.costs).toEqual({ meanCostBpsApplied: 30, estimatedCostBps: 30 });
  });

  it("is judged once, on the sample that ends at the declared length; later rows cannot change it", () => {
    const e = evaluate(rows(400));
    // The 30th independent signal is decided at hour 116 (signals count at hours 0, 4, 8, ...).
    expect(e.observation).toEqual({ targetEffectiveSignals: 30, reached: true, judgedOn: "FIXED_SAMPLE" });
    expect(e.effectiveSignals).toBe(30);
    expect(e.effectiveOutcomes).toBe(30);
    expect(e.resolved).toBe(117);
    expect(e.signalsNet!.lower).toBeGreaterThan(0);
    expect(e.netAdvantage!.lower).toBeGreaterThan(0);
    expect(e.missing).toEqual([]);
    expect(e.sufficient).toBe(true);
    // A model that turns bad afterwards is the monitor's business; it cannot rewrite the judged sample, and a
    // model that only turns good afterwards cannot buy a pass by waiting.
    const laterBad = evaluate(rows(1000, (i) => (i > 116 ? { outcome: { available: true, net: -0.05, positive: false } } : {})));
    expect(laterBad.signalsNet).toEqual(e.signalsNet);
    expect(laterBad.sufficient).toBe(true);
    expect(laterBad.predictions).toBe(1000);
    const earlyBad = evaluate(rows(1000, (i) => (i <= 116 && i % 2 === 0 ? { outcome: { available: true, net: -0.004, positive: false } } : {})));
    expect(earlyBad.observation.reached).toBe(true);
    expect(earlyBad.sufficient).toBe(false);
  });

  it("a model whose signals lose money is not sufficient, even when it beats always-enter with confidence", () => {
    // Signals: nine small wins, then one large loss (mean -11 bps). Everything else loses 100 bps, so the
    // signals beat "always enter" by a wide, confident margin while still losing money.
    const losing = rows(800, (i) => (i % 2 === 0 ? { probability: 0.9, outcome: { available: true, net: i % 20 === 0 ? -0.02 : 0.001, positive: i % 20 !== 0 } } : { probability: 0.1, outcome: { available: true, net: -0.01, positive: false } }));
    const e = evaluate(losing);
    expect(e.observation.reached).toBe(true);
    expect(e.netAdvantage!.lower).toBeGreaterThan(0);
    expect(e.meanNetSignals!).toBeLessThan(0);
    expect(e.sufficient).toBe(false);
    expect(e.missing.join(" ")).toMatch(/signals' own net return after costs: interval lower bound -?[0-9.]+ bps is not above 0/);
  });

  it("miscalibrated probabilities are not sufficient", () => {
    const e = evaluate(rows(400, (i) => ({ probability: i % 2 === 0 ? 0.7 : 0.3 })));
    // Probabilities 0.7 / 0.3 against outcomes 1 / 0 are off by 0.3: above the 0.1 limit.
    expect(e.sufficient).toBe(false);
    expect(e.missing.some((m) => /calibration error/.test(m))).toBe(true);
  });

  it("reports what is unknown as null and flags integrity failures", () => {
    const none = evaluate([]);
    expect(none).toMatchObject({ resolved: 0, effectiveOutcomes: 0, meanNetSignals: null, meanNetAll: null, netAdvantage: null, signalsNet: null, calibration: null, overlapShare: null, sufficient: false });
    expect(none.costs.meanCostBpsApplied).toBeNull();
    const open = evaluate(rows(10, () => ({ outcome: null, horizonEndsAt: 20_000 * H })));
    expect(open).toMatchObject({ predictions: 10, resolved: 0, open: 10, meanNetAll: null });
    const tampered = evaluate(rows(400, (i) => ({ hashOk: i !== 7 })));
    expect(tampered.integrityFailures).toBe(1);
    expect(tampered.sufficient).toBe(false);
  });
});
