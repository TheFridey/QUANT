import {
  buildDefaultFeatureRows,
  buildTradeLabels,
  calibration,
  defaultFeatureSetSpec,
  featureSetSpecHash,
  ml2Abstention,
  predictMl2,
  psi,
  validateResearchBars,
  type LabelSpec,
  type Ml2Artefact,
  type ResearchBar,
} from "@odin/backtest/ml2";
import { Prisma, toJson, type PrismaClient } from "@odin/shared/db";
import { z } from "zod";
import { canonicalHash } from "./canonical.js";
import { canTransitionModel, SHADOW_STATES, type ModelState } from "./model-lifecycle.js";
import { loadModel, ModelRegistryError, modelStates, transitionModel, type LoadedModel } from "./model-registry.js";
import { clampBudget, shadowBudgetFromEnv, shadowEnabled, type ShadowBudget } from "./shadow-config.js";

/**
 * GENESIS Phase 6 shadow predictions. Research only: a cycle reads closed bars, runs registered SHADOW_*
 * models' `predictMl2`, and appends ShadowPrediction / ShadowOutcome / ModelLifecycleEvent rows. It never
 * creates orders, trade intents, fills or ledger entries, and never writes EngineControl, risk configuration,
 * strategy instances or execution permissions. Its import graph has no path to order or execution code
 * (shadow-imports.test.ts). Outcomes are hypothetical (`HYPOTHETICAL_SHADOW`) and never mixed with paper fills.
 */

export const SHADOW_MONITOR_ACTOR = "genesis-shadow-monitor";
/** Ceiling on prediction latency after the decision bar closes; the database enforces the same ceiling. */
export const MAX_DECISION_LATENCY_MS = 3_600_000;
const MAX_HORIZON_BARS = 10_000;
/** Matured predictions older than this (by horizon end) are no longer retried by the resolver. */
export const RESOLVER_LOOKBACK_MS = 30 * 86_400_000;

/** Closed bars only: every bar returned satisfies `t + barMs <= asOf`. */
export type ShadowBarSource = {
  /** Most recent closed bars, ascending by open time, at most `limit`. */
  latestBars(instrumentKey: string, barMs: number, asOf: Date, limit: number): Promise<ResearchBar[]>;
  /** Closed bars with open time in [fromOpen, toOpen], ascending. */
  barsBetween(instrumentKey: string, barMs: number, fromOpen: Date, toOpen: Date, asOf: Date): Promise<ResearchBar[]>;
};

// ---------------------------------------------------------------------------------------------------------
// Model shadow specification (read from trainingProtocol.shadow and validation)
// ---------------------------------------------------------------------------------------------------------

const shadowSpecSchema = z.object({
  barMs: z.int().positive(),
  instrumentKeys: z.array(z.string().min(1).max(200)).min(1).max(20),
  entryThreshold: z.number().min(0).max(1).optional(),
  lookbackBars: z.int().min(50).max(5_000).optional(),
  maxStalenessMs: z.number().positive().optional(),
  maxAbsZ: z.number().positive().optional(),
});

export type ShadowSpec = { barMs: number; instrumentKeys: string[]; entryThreshold: number; lookbackBars: number; maxStalenessMs: number; maxAbsZ: number };

const payoffSchema = z.object({ meanNetIfPositive: z.number(), meanNetIfNotPositive: z.number() });

export function parseShadowSpec(model: { trainingProtocol: unknown }): ShadowSpec {
  const protocol = (model.trainingProtocol ?? {}) as Record<string, unknown>;
  const target = protocol.target;
  if (target !== undefined && target !== "NET_POSITIVE") throw new ModelRegistryError("TARGET_UNSUPPORTED", `shadow supports target NET_POSITIVE only (model target ${String(target)})`);
  const parsed = shadowSpecSchema.safeParse(protocol.shadow);
  if (!parsed.success) throw new ModelRegistryError("NO_SHADOW_SPEC", `trainingProtocol.shadow is missing or invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  const s = parsed.data;
  return { barMs: s.barMs, instrumentKeys: s.instrumentKeys, entryThreshold: s.entryThreshold ?? 0.55, lookbackBars: s.lookbackBars ?? 600, maxStalenessMs: s.maxStalenessMs ?? 30 * 86_400_000, maxAbsZ: s.maxAbsZ ?? 6 };
}

/** Shadow uses the registered default feature builder only; a model trained on any other feature set is refused. */
export function checkShadowFeatureSet(artefact: Ml2Artefact, barMs: number): void {
  const expected = featureSetSpecHash(defaultFeatureSetSpec(barMs));
  if (artefact.featureSetHash !== expected) throw new ModelRegistryError("FEATURE_SET_UNSUPPORTED", `artefact feature set ${artefact.featureSetHash.slice(0, 12)} is not the default ${expected.slice(0, 12)} for barMs ${barMs}`);
}

export function roundTripCostBps(spec: LabelSpec): number {
  return 2 * (spec.feeBpsPerSide + spec.slippageBpsPerSide);
}

// ---------------------------------------------------------------------------------------------------------
// Prediction (pure)
// ---------------------------------------------------------------------------------------------------------

export type PredictionRecord = {
  modelVersionId: string;
  instrumentKey: string;
  status: "PREDICTED" | "ABSTAINED";
  predictedAt: Date;
  decisionBarOpenTime: Date;
  decisionTime: Date;
  barMs: number;
  horizonBars: number;
  horizonEndsAt: Date;
  features: Record<string, number | null>;
  featureHash: string;
  probability: number | null;
  expectedNetReturn: number | null;
  confidenceBasis: string;
  estimatedCostBps: number;
  abstainReasons: string[];
  inputHash: string;
};

/** SHA-256 of the canonical prediction record (every field except id and createdAt). */
export function predictionRecordHash(r: PredictionRecord): string {
  return canonicalHash({
    modelVersionId: r.modelVersionId,
    instrumentKey: r.instrumentKey,
    status: r.status,
    predictedAt: r.predictedAt,
    decisionBarOpenTime: r.decisionBarOpenTime,
    decisionTime: r.decisionTime,
    barMs: r.barMs,
    horizonBars: r.horizonBars,
    horizonEndsAt: r.horizonEndsAt,
    features: r.features,
    featureHash: r.featureHash,
    probability: r.probability,
    expectedNetReturn: r.expectedNetReturn,
    confidenceBasis: r.confidenceBasis,
    estimatedCostBps: r.estimatedCostBps,
    abstainReasons: r.abstainReasons,
    inputHash: r.inputHash,
  });
}

export type TimingCheck = { ok: true } | { ok: false; reason: string };

/**
 * A prediction is taken after the decision bar closes, within `maxLatencyMs` (≤ one bar and ≤ one hour) of
 * that close, and strictly before its horizon ends. Mirrors the ShadowPrediction_timing CHECK.
 */
export function checkPredictionTiming(input: { decisionBarOpenTime: number; barMs: number; horizonBars: number; predictedAt: number; maxLatencyMs?: number }): TimingCheck {
  const decisionTime = input.decisionBarOpenTime + input.barMs;
  const horizonEndsAt = input.decisionBarOpenTime + (input.horizonBars + 1) * input.barMs;
  const latency = Math.min(input.barMs, MAX_DECISION_LATENCY_MS, input.maxLatencyMs ?? MAX_DECISION_LATENCY_MS);
  if (!(input.barMs > 0) || !Number.isInteger(input.horizonBars) || input.horizonBars < 1 || input.horizonBars > MAX_HORIZON_BARS) return { ok: false, reason: "BAD_HORIZON" };
  if (input.predictedAt < decisionTime) return { ok: false, reason: "BEFORE_DECISION: the decision bar has not closed" };
  if (input.predictedAt >= horizonEndsAt) return { ok: false, reason: "AFTER_HORIZON: the outcome is already known" };
  if (input.predictedAt > decisionTime + latency) return { ok: false, reason: `LATE: ${input.predictedAt - decisionTime} ms after the decision (max ${latency})` };
  return { ok: true };
}

export type PredictOutcome = { kind: "RECORD"; record: PredictionRecord; recordHash: string } | { kind: "SKIP"; reason: string };

/**
 * Builds the prediction (or abstention) of one model for the latest closed bar of `bars`. Features are
 * computed from `bars` only (each row reads bars[0..i]); the decision bar is the last bar.
 */
export function predictLatestBar(input: {
  model: { id: string; validation: unknown };
  artefact: Ml2Artefact;
  labelSpec: LabelSpec;
  spec: ShadowSpec;
  instrumentKey: string;
  bars: readonly ResearchBar[];
  now: Date;
  maxLatencyMs?: number;
}): PredictOutcome {
  const { artefact, spec, bars } = input;
  const nowMs = input.now.getTime();
  if (bars.length < 2) return { kind: "SKIP", reason: "NO_BARS" };
  const issues = validateResearchBars(bars, { barMs: spec.barMs, asOf: nowMs });
  if (issues.length) return { kind: "SKIP", reason: `BAD_BARS: ${issues[0]!.code} at ${issues[0]!.index}` };
  const decision = bars[bars.length - 1]!;
  if (decision.t + spec.barMs > nowMs) return { kind: "SKIP", reason: "BEFORE_DECISION: the decision bar has not closed" };
  const horizonBars = input.labelSpec.horizon;
  const timing = checkPredictionTiming({ decisionBarOpenTime: decision.t, barMs: spec.barMs, horizonBars, predictedAt: nowMs, maxLatencyMs: input.maxLatencyMs });
  if (!timing.ok) return { kind: "SKIP", reason: timing.reason };

  const rows = buildDefaultFeatureRows(bars, { barMs: spec.barMs });
  const row = rows[rows.length - 1];
  const decisionTime = decision.t + spec.barMs;
  if (!row || row.t !== decision.t) return { kind: "SKIP", reason: "NO_FEATURE_ROW" };
  if (row.availableAt > decisionTime || Object.values(row.featureAvailableAt ?? {}).some((t) => t > decisionTime)) {
    return { kind: "SKIP", reason: "CAUSALITY: a feature is not available at the decision time" };
  }
  const features: Record<string, number | null> = {};
  const x: number[] = [];
  for (const name of artefact.features) {
    const v = row.values[name];
    const value = typeof v === "number" && Number.isFinite(v) ? v : null;
    features[name] = value;
    x.push(value === null ? Number.NaN : value);
  }
  const reasons: string[] = [];
  const missing = artefact.features.filter((n) => features[n] === null);
  if (missing.length && artefact.preprocessor.nullPolicy === "DROP_ROW") reasons.push(`MISSING_FEATURE: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
  const abstention = ml2Abstention({ artefact, asOf: decisionTime, maxStalenessMs: spec.maxStalenessMs, x, maxAbsZ: spec.maxAbsZ });
  reasons.push(...abstention.reasons);
  let probability: number | null = null;
  if (!reasons.length) {
    const p = predictMl2(artefact, x);
    if (Number.isFinite(p) && p >= 0 && p <= 1) probability = p;
    else reasons.push("NON_FINITE_PREDICTION");
  }
  const payoff = payoffSchema.safeParse((input.model.validation as Record<string, unknown> | null)?.shadowPayoff);
  const expectedNetReturn = probability !== null && payoff.success ? probability * payoff.data.meanNetIfPositive + (1 - probability) * payoff.data.meanNetIfNotPositive : null;
  const confidenceBasis = `calibrated P(net > 0) via ${artefact.calibrator.method}; ${payoff.success ? "expected net from validation.shadowPayoff (walk-forward conditional means)" : "no expected net (validation.shadowPayoff absent)"}`;
  const record: PredictionRecord = {
    modelVersionId: input.model.id,
    instrumentKey: input.instrumentKey,
    status: probability === null ? "ABSTAINED" : "PREDICTED",
    predictedAt: new Date(nowMs),
    decisionBarOpenTime: new Date(decision.t),
    decisionTime: new Date(decisionTime),
    barMs: spec.barMs,
    horizonBars,
    horizonEndsAt: new Date(decision.t + (horizonBars + 1) * spec.barMs),
    features,
    featureHash: canonicalHash(features),
    probability,
    expectedNetReturn,
    confidenceBasis,
    estimatedCostBps: roundTripCostBps(input.labelSpec),
    abstainReasons: probability === null ? reasons : [],
    inputHash: canonicalHash(bars.map((b) => ({ t: b.t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null }))),
  };
  return { kind: "RECORD", record, recordHash: predictionRecordHash(record) };
}

// ---------------------------------------------------------------------------------------------------------
// Resolution (pure)
// ---------------------------------------------------------------------------------------------------------

export type OutcomeRecord = {
  predictionId: string;
  resolvedAt: Date;
  hypotheticalFillAvailable: boolean;
  realisedNetReturn: number | null;
  positive: boolean | null;
  mae: number | null;
  mfe: number | null;
  exitReason: "HORIZON" | "STOP" | "TARGET" | null;
  costBpsApplied: number;
  source: "HYPOTHETICAL_SHADOW";
  barsHash: string;
};

export function outcomeRecordHash(o: OutcomeRecord): string {
  return canonicalHash({ ...o });
}

export type ResolveResult = { kind: "OUTCOME"; outcome: OutcomeRecord; recordHash: string } | { kind: "PENDING"; reason: string };

/**
 * Resolves one prediction from bars observed after its decision bar. `bars` must be the decision bar and the
 * `horizonBars` bars after it (open times decisionBarOpenTime + k·barMs, k = 0..horizonBars), all closed at
 * `now`; any bar outside that window, or not yet closed, is refused. With a gap, the outcome waits up to
 * `graceBars` bars after the horizon and is then recorded as having no hypothetical fill.
 */
export function resolvePrediction(input: {
  prediction: { id: string; decisionBarOpenTime: Date; barMs: number; horizonBars: number; horizonEndsAt: Date };
  labelSpec: LabelSpec;
  bars: readonly ResearchBar[];
  now: Date;
  graceBars?: number;
}): ResolveResult {
  const p = input.prediction;
  const start = p.decisionBarOpenTime.getTime();
  const nowMs = input.now.getTime();
  if (nowMs < p.horizonEndsAt.getTime()) return { kind: "PENDING", reason: "HORIZON_NOT_ENDED" };
  if (input.labelSpec.horizon !== p.horizonBars) return { kind: "PENDING", reason: "LABEL_HORIZON_MISMATCH" };
  const lastOpen = start + p.horizonBars * p.barMs;
  for (const b of input.bars) {
    if (b.t < start || b.t > lastOpen) return { kind: "PENDING", reason: `SOURCE_VIOLATION: bar ${new Date(b.t).toISOString()} outside the resolution window` };
    if (b.t + p.barMs > nowMs) return { kind: "PENDING", reason: "SOURCE_VIOLATION: bar not closed" };
  }
  const barsHash = canonicalHash(input.bars.map((b) => ({ t: b.t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null })));
  const cost = roundTripCostBps(input.labelSpec);
  const complete = input.bars.length === p.horizonBars + 1 && input.bars.every((b, k) => b.t === start + k * p.barMs);
  const unavailable = (): ResolveResult => {
    const outcome: OutcomeRecord = { predictionId: p.id, resolvedAt: new Date(nowMs), hypotheticalFillAvailable: false, realisedNetReturn: null, positive: null, mae: null, mfe: null, exitReason: null, costBpsApplied: cost, source: "HYPOTHETICAL_SHADOW", barsHash };
    return { kind: "OUTCOME", outcome, recordHash: outcomeRecordHash(outcome) };
  };
  if (!complete) {
    const grace = (input.graceBars ?? p.horizonBars) * p.barMs;
    return nowMs >= p.horizonEndsAt.getTime() + grace ? unavailable() : { kind: "PENDING", reason: "AWAITING_BARS" };
  }
  const label = buildTradeLabels(input.bars, input.labelSpec, { barMs: p.barMs })[0] ?? null;
  if (!label) return unavailable();
  if (label.knownAt !== p.horizonEndsAt.getTime()) return { kind: "PENDING", reason: "SOURCE_VIOLATION: label window differs from horizon" };
  const outcome: OutcomeRecord = {
    predictionId: p.id,
    resolvedAt: new Date(nowMs),
    hypotheticalFillAvailable: true,
    realisedNetReturn: label.netReturn,
    positive: label.positive === 1,
    mae: label.mae,
    mfe: label.mfe,
    exitReason: label.exitReason,
    costBpsApplied: cost,
    source: "HYPOTHETICAL_SHADOW",
    barsHash,
  };
  return { kind: "OUTCOME", outcome, recordHash: outcomeRecordHash(outcome) };
}

// ---------------------------------------------------------------------------------------------------------
// Health monitoring (pure)
// ---------------------------------------------------------------------------------------------------------

export type MonitorConfig = { minResolved: number; window: number; maxEce: number; maxBrierDecay: number; maxPsi: number; psiWindow: number; maxAbstainShare: number };

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = { minResolved: 50, window: 200, maxEce: 0.1, maxBrierDecay: 0.02, maxPsi: 0.25, psiWindow: 100, maxAbstainShare: 0.5 };

export type HealthAssessment = { degrade: boolean; reasons: string[]; metrics: { resolved: number; brier: number | null; ece: number | null; referenceBrier: number | null; maxPsi: number | null; abstainShare: number | null } };

/**
 * Degraded evidence: shadow ECE above `maxEce`, shadow Brier above the walk-forward reference by more than
 * `maxBrierDecay`, any feature PSI (earliest vs latest shadow window) above `maxPsi`, or abstentions above
 * `maxAbstainShare` of recent rows. Below `minResolved` outcomes only drift and abstention are judged.
 */
export function assessShadowHealth(input: {
  resolved: Array<{ probability: number; positive: boolean }>;
  referenceBrier: number | null;
  referenceFeatures: Array<Record<string, number | null>>;
  recentFeatures: Array<Record<string, number | null>>;
  featureNames: string[];
  recentStatuses: Array<"PREDICTED" | "ABSTAINED">;
  config?: Partial<MonitorConfig>;
}): HealthAssessment {
  const c = { ...DEFAULT_MONITOR_CONFIG, ...input.config };
  const reasons: string[] = [];
  let brier: number | null = null;
  let ece: number | null = null;
  const window = input.resolved.slice(-c.window);
  if (window.length >= c.minResolved) {
    const cal = calibration(window.map((r) => r.probability), window.map((r) => (r.positive ? 1 : 0)));
    brier = cal.brier;
    ece = cal.ece;
    if (ece > c.maxEce) reasons.push(`CALIBRATION: shadow ECE ${ece.toFixed(4)} > ${c.maxEce} over ${window.length} outcomes`);
    if (input.referenceBrier !== null && brier - input.referenceBrier > c.maxBrierDecay) {
      reasons.push(`BRIER_DECAY: shadow Brier ${brier.toFixed(4)} exceeds walk-forward ${input.referenceBrier.toFixed(4)} by more than ${c.maxBrierDecay}`);
    }
  }
  let maxPsi: number | null = null;
  if (input.referenceFeatures.length >= c.psiWindow && input.recentFeatures.length >= c.psiWindow) {
    const drifted: string[] = [];
    for (const name of input.featureNames) {
      const ref = input.referenceFeatures.map((f) => f[name]).filter((v): v is number => typeof v === "number");
      const rec = input.recentFeatures.map((f) => f[name]).filter((v): v is number => typeof v === "number");
      const value = psi(ref, rec);
      if (value === null) continue;
      maxPsi = Math.max(maxPsi ?? 0, value);
      if (value > c.maxPsi) drifted.push(`${name} ${value.toFixed(3)}`);
    }
    if (drifted.length) reasons.push(`DRIFT: PSI above ${c.maxPsi} on ${drifted.slice(0, 5).join(", ")}`);
  }
  let abstainShare: number | null = null;
  if (input.recentStatuses.length >= c.minResolved) {
    abstainShare = input.recentStatuses.filter((s) => s === "ABSTAINED").length / input.recentStatuses.length;
    if (abstainShare > c.maxAbstainShare) reasons.push(`ABSTENTION: ${(abstainShare * 100).toFixed(1)}% of the last ${input.recentStatuses.length} rows abstained (> ${c.maxAbstainShare * 100}%)`);
  }
  return { degrade: reasons.length > 0, reasons, metrics: { resolved: window.length, brier, ece, referenceBrier: input.referenceBrier, maxPsi, abstainShare } };
}

// ---------------------------------------------------------------------------------------------------------
// Database cycle
// ---------------------------------------------------------------------------------------------------------

export type ShadowCycleDeps = {
  bars: ShadowBarSource;
  now?: () => Date;
  budget?: Partial<ShadowBudget>;
  maxLatencyMs?: number;
  monitor?: Partial<MonitorConfig>;
  /** Restrict the cycle to these model ids (tests, operator tooling). */
  modelIds?: string[];
};

export type ShadowCycleResult = {
  status: "RAN";
  models: string[];
  predicted: number;
  abstained: number;
  duplicates: number;
  skipped: Array<{ modelVersionId: string; instrumentKey: string | null; reason: string }>;
  resolved: number;
  unavailable: number;
  pending: Array<{ predictionId: string; reason: string }>;
  suspended: Array<{ modelVersionId: string; from: ModelState; reasons: string[] }>;
  failed: Array<{ modelVersionId: string; reason: string }>;
  stoppedEarly: null | "MAX_MS" | "MAX_PREDICTIONS" | "MAX_RESOLUTIONS";
  elapsedMs: number;
};

/** Worker entry point: does nothing unless GENESIS_SHADOW_ENABLED is exactly "true". */
export async function runShadowTick(prisma: PrismaClient, deps: Omit<ShadowCycleDeps, "budget"> & { env?: NodeJS.ProcessEnv }): Promise<ShadowCycleResult | { status: "DISABLED" }> {
  const env = deps.env ?? process.env;
  if (!shadowEnabled(env)) return { status: "DISABLED" };
  return runShadowCycle(prisma, { ...deps, budget: shadowBudgetFromEnv(env) });
}

/**
 * One bounded shadow cycle: predict for SHADOW_* models (at most `maxModels`, `maxPredictions`), resolve
 * matured predictions (at most `maxResolutions`), then judge each processed model's health. No new unit of
 * work starts once `maxMs` has elapsed.
 */
export async function runShadowCycle(prisma: PrismaClient, deps: ShadowCycleDeps): Promise<ShadowCycleResult> {
  const budget = clampBudget(deps.budget ?? {});
  const started = performance.now();
  const overTime = () => performance.now() - started >= budget.maxMs;
  const clock = deps.now ?? (() => new Date());
  const result: ShadowCycleResult = { status: "RAN", models: [], predicted: 0, abstained: 0, duplicates: 0, skipped: [], resolved: 0, unavailable: 0, pending: [], suspended: [], failed: [], stoppedEarly: null, elapsedMs: 0 };

  const states = await modelStates(prisma, deps.modelIds);
  const active = [...states.entries()].filter(([, s]) => SHADOW_STATES.includes(s.state)).map(([id]) => id);
  const ordered = active.length ? await prisma.modelVersion.findMany({ where: { id: { in: active } }, select: { id: true }, orderBy: { createdAt: "asc" } }) : [];

  modelLoop: for (const { id } of ordered.slice(0, budget.maxModels)) {
    if (overTime()) {
      result.stoppedEarly = "MAX_MS";
      break;
    }
    let loaded: LoadedModel;
    let spec: ShadowSpec;
    try {
      loaded = await loadModel(prisma, id);
      spec = parseShadowSpec(loaded.model);
      checkShadowFeatureSet(loaded.artefact, spec.barMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failed.push({ modelVersionId: id, reason });
      await failModel(prisma, id, states.get(id)!.state, `SHADOW_UNRUNNABLE: ${reason}`);
      continue;
    }
    result.models.push(id);
    for (const instrumentKey of spec.instrumentKeys) {
      if (result.predicted + result.abstained >= budget.maxPredictions) {
        result.stoppedEarly = "MAX_PREDICTIONS";
        break modelLoop;
      }
      if (overTime()) {
        result.stoppedEarly = "MAX_MS";
        break modelLoop;
      }
      const now = clock();
      const bars = await deps.bars.latestBars(instrumentKey, spec.barMs, now, spec.lookbackBars);
      const decision = bars[bars.length - 1];
      if (decision) {
        const exists = await prisma.shadowPrediction.findUnique({
          where: { modelVersionId_instrumentKey_decisionBarOpenTime: { modelVersionId: id, instrumentKey, decisionBarOpenTime: new Date(decision.t) } },
          select: { id: true },
        });
        if (exists) {
          result.duplicates += 1;
          continue;
        }
      }
      const out = predictLatestBar({ model: loaded.model, artefact: loaded.artefact, labelSpec: loaded.labelSpec, spec, instrumentKey, bars, now: clock(), maxLatencyMs: deps.maxLatencyMs });
      if (out.kind === "SKIP") {
        result.skipped.push({ modelVersionId: id, instrumentKey, reason: out.reason });
        continue;
      }
      try {
        await prisma.shadowPrediction.create({ data: { ...out.record, features: toJson(out.record.features), recordHash: out.recordHash } });
        if (out.record.status === "PREDICTED") result.predicted += 1;
        else result.abstained += 1;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") result.duplicates += 1;
        else result.skipped.push({ modelVersionId: id, instrumentKey, reason: `INSERT_REFUSED: ${error instanceof Error ? error.message.split("\n").slice(-1)[0] : String(error)}` });
      }
    }
  }

  if (!result.stoppedEarly) {
    const resolution = await resolveShadowPredictions(prisma, { bars: deps.bars, now: clock(), maxResolutions: budget.maxResolutions, overTime, modelIds: deps.modelIds });
    result.resolved = resolution.resolved;
    result.unavailable = resolution.unavailable;
    result.pending = resolution.pending;
    result.stoppedEarly = resolution.stoppedEarly;
  }

  for (const id of result.models) {
    const suspension = await monitorShadowModel(prisma, id, deps.monitor);
    if (suspension) result.suspended.push(suspension);
  }
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}

async function failModel(prisma: PrismaClient, id: string, from: ModelState, reason: string): Promise<void> {
  try {
    await transitionModel(prisma, { modelVersionId: id, to: "FAILED", actor: SHADOW_MONITOR_ACTOR, reason: reason.slice(0, 2000), evidence: { reason }, expectedFrom: from });
  } catch {
    // Another writer moved the model first; the next cycle re-reads its state.
  }
}

/** Resolves matured PREDICTED rows (horizon ended, no outcome yet) from bars observed after the decision. */
export async function resolveShadowPredictions(
  prisma: PrismaClient,
  input: { bars: ShadowBarSource; now: Date; maxResolutions: number; overTime?: () => boolean; graceBars?: number; modelIds?: string[]; lookbackMs?: number },
): Promise<{ resolved: number; unavailable: number; pending: Array<{ predictionId: string; reason: string }>; stoppedEarly: null | "MAX_MS" | "MAX_RESOLUTIONS"; excludedModels: string[] }> {
  // Bounded window: the scan does not grow with resolved history, and stuck rows eventually age out.
  const since = new Date(input.now.getTime() - (input.lookbackMs ?? RESOLVER_LOOKBACK_MS));
  const where = { status: "PREDICTED", outcome: { is: null }, horizonEndsAt: { lte: input.now, gte: since }, ...(input.modelIds ? { modelVersionId: { in: input.modelIds } } : {}) } satisfies Prisma.ShadowPredictionWhereInput;
  const out = { resolved: 0, unavailable: 0, pending: [] as Array<{ predictionId: string; reason: string }>, stoppedEarly: null as null | "MAX_MS" | "MAX_RESOLUTIONS", excludedModels: [] as string[] };
  if (input.maxResolutions < 1) return out;

  // Fair share per model, interleaved round-robin, so one model whose rows never resolve (integrity failure,
  // refused inserts, missing bars) cannot starve the others. FAILED models (integrity) are left out.
  const withDue = await prisma.shadowPrediction.findMany({ where, distinct: ["modelVersionId"], select: { modelVersionId: true }, orderBy: { modelVersionId: "asc" } });
  const states = await modelStates(prisma, withDue.map((m) => m.modelVersionId));
  let ids = withDue.map((m) => m.modelVersionId).filter((id) => states.get(id)?.state !== "FAILED");
  if (ids.length > input.maxResolutions) {
    const offset = Math.floor(input.now.getTime() / 60_000) % ids.length;
    ids = [...ids.slice(offset), ...ids.slice(0, offset)].slice(0, input.maxResolutions);
  }
  if (!ids.length) return out;
  const cap = Math.max(1, Math.ceil(input.maxResolutions / ids.length));
  const queues = await Promise.all(ids.map((id) => prisma.shadowPrediction.findMany({ where: { ...where, modelVersionId: id }, orderBy: [{ horizonEndsAt: "asc" }, { id: "asc" }], take: cap })));
  const due: (typeof queues)[number] = [];
  for (let round = 0; round < cap; round += 1) for (const q of queues) if (q[round]) due.push(q[round]!);

  const labelSpecs = new Map<string, LabelSpec | null>();
  const excluded = new Set<string>();
  const exclude = async (modelVersionId: string, reason: string) => {
    if (excluded.has(modelVersionId)) return;
    excluded.add(modelVersionId);
    out.excludedModels.push(modelVersionId);
    // Integrity failures retire the model from shadow (FAILED, history kept), so its rows leave the queue.
    const head = states.get(modelVersionId);
    if (head && canTransitionModel(head.state, "FAILED")) await failModel(prisma, modelVersionId, head.state, `INTEGRITY: ${reason}`);
  };
  let attempted = 0;
  for (const p of due) {
    if (excluded.has(p.modelVersionId)) continue;
    if (attempted >= input.maxResolutions) {
      out.stoppedEarly = "MAX_RESOLUTIONS";
      break;
    }
    if (input.overTime?.()) {
      out.stoppedEarly = "MAX_MS";
      break;
    }
    attempted += 1;
    if (predictionRecordHash({ ...p, status: p.status as PredictionRecord["status"], features: p.features as Record<string, number | null> }) !== p.recordHash) {
      out.pending.push({ predictionId: p.id, reason: "RECORD_HASH_MISMATCH" });
      await exclude(p.modelVersionId, `prediction ${p.id} record hash mismatch`);
      continue;
    }
    if (!labelSpecs.has(p.modelVersionId)) {
      try {
        labelSpecs.set(p.modelVersionId, (await loadModel(prisma, p.modelVersionId)).labelSpec);
      } catch (error) {
        labelSpecs.set(p.modelVersionId, null);
        out.pending.push({ predictionId: p.id, reason: "MODEL_INTEGRITY" });
        await exclude(p.modelVersionId, error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    const labelSpec = labelSpecs.get(p.modelVersionId);
    if (!labelSpec) continue;
    const now = input.now;
    const bars = await input.bars.barsBetween(p.instrumentKey, p.barMs, p.decisionBarOpenTime, new Date(p.decisionBarOpenTime.getTime() + p.horizonBars * p.barMs), now);
    const r = resolvePrediction({ prediction: p, labelSpec, bars, now, graceBars: input.graceBars });
    if (r.kind === "PENDING") {
      out.pending.push({ predictionId: p.id, reason: r.reason });
      continue;
    }
    try {
      await prisma.shadowOutcome.create({ data: { ...r.outcome, recordHash: r.recordHash } });
      if (r.outcome.hypotheticalFillAvailable) out.resolved += 1;
      else out.unavailable += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        out.pending.push({ predictionId: p.id, reason: `INSERT_REFUSED: ${error instanceof Error ? error.message.split("\n").slice(-1)[0] : String(error)}` });
      }
    }
  }
  return out;
}

/**
 * Judges one SHADOW_* model and, when its evidence has degraded, moves it to REJECTED through a lifecycle
 * event (history retained; predictions and outcomes are never deleted). Never promotes anything.
 */
export async function monitorShadowModel(prisma: PrismaClient, modelVersionId: string, config?: Partial<MonitorConfig>): Promise<{ modelVersionId: string; from: ModelState; reasons: string[] } | null> {
  const c = { ...DEFAULT_MONITOR_CONFIG, ...config };
  const states = await modelStates(prisma, [modelVersionId]);
  const head = states.get(modelVersionId);
  if (!head || !SHADOW_STATES.includes(head.state)) return null;
  const model = await prisma.modelVersion.findUnique({ where: { id: modelVersionId }, select: { validation: true, artefact: true } });
  if (!model) return null;
  const resolvedRows = await prisma.shadowOutcome.findMany({
    where: { hypotheticalFillAvailable: true, prediction: { modelVersionId } },
    select: { positive: true, prediction: { select: { probability: true, decisionTime: true } } },
    orderBy: { prediction: { decisionTime: "desc" } },
    take: c.window,
  });
  const resolved = resolvedRows
    .reverse()
    .filter((r) => r.prediction.probability !== null && r.positive !== null)
    .map((r) => ({ probability: r.prediction.probability!, positive: r.positive! }));
  const reference = await prisma.shadowPrediction.findMany({ where: { modelVersionId, status: "PREDICTED" }, select: { features: true }, orderBy: { decisionTime: "asc" }, take: c.psiWindow });
  const recentPredicted = await prisma.shadowPrediction.findMany({ where: { modelVersionId, status: "PREDICTED" }, select: { features: true }, orderBy: { decisionTime: "desc" }, take: c.psiWindow });
  const recent = await prisma.shadowPrediction.findMany({ where: { modelVersionId }, select: { status: true }, orderBy: { decisionTime: "desc" }, take: c.window });
  const validation = (model.validation ?? {}) as Record<string, unknown>;
  const referenceBrier = typeof validation.walkForwardBrier === "number" ? validation.walkForwardBrier : null;
  const featureNames = Array.isArray((model.artefact as { features?: unknown }).features) ? ((model.artefact as { features: string[] }).features) : [];
  // The PSI windows must not overlap, or drift is understated.
  const totalPredicted = await prisma.shadowPrediction.count({ where: { modelVersionId, status: "PREDICTED" } });
  const assessment = assessShadowHealth({
    resolved,
    referenceBrier,
    referenceFeatures: totalPredicted >= 2 * c.psiWindow ? reference.map((r) => r.features as Record<string, number | null>) : [],
    recentFeatures: totalPredicted >= 2 * c.psiWindow ? recentPredicted.map((r) => r.features as Record<string, number | null>) : [],
    featureNames,
    recentStatuses: recent.map((r) => r.status as "PREDICTED" | "ABSTAINED"),
    config: c,
  });
  if (!assessment.degrade) return null;
  try {
    await transitionModel(prisma, {
      modelVersionId,
      to: "REJECTED",
      actor: SHADOW_MONITOR_ACTOR,
      reason: `SUSPENDED_BY_MONITOR: ${assessment.reasons.join("; ")}`.slice(0, 2000),
      evidence: { ...assessment.metrics, reasons: assessment.reasons, config: c },
      expectedFrom: head.state,
    });
  } catch (error) {
    if (error instanceof ModelRegistryError && (error.code === "STATE_CHANGED" || error.code === "CONCURRENT_TRANSITION")) return null;
    throw error;
  }
  return { modelVersionId, from: head.state, reasons: assessment.reasons };
}
