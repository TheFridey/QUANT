import {
  createMemoryHoldoutGate,
  excludeWeekendStubBars,
  HorizonRefusal,
  marketConfigHash,
  runHorizonStudy,
  validateResearchBars,
  validationCostBpsPerSide,
  type HoldoutStatus,
  type HorizonMlResult,
  type HorizonStrategyResult,
  type Ml2Report,
  type ResearchBar,
} from "@odin/backtest/research";
import { canonicalHash, canonicalJson, roundNumbers, sha256Hex } from "../genesis/canonical.js";
import { campaignVersions, CAMPAIGN_LIMIT_BOUNDS, INTERVALS, marketFor, normaliseInstrument, type CampaignDataset, type CampaignSpec } from "./spec.js";

/**
 * OPERATION EVIDENCE deterministic unit evaluation (pure: no clock, no I/O, no network, no database).
 * The same job always yields the same `resultHash`. The executor runs this in a child process with the network
 * blocked; everything the result depends on is in the job.
 */

export type RawBars = { bars: ResearchBar[]; availableAt: number[] | null; tickVolumes: Array<number | null> | null; source: Record<string, string | number | boolean | null> };

export type DatasetIdentity = {
  key: string;
  source: RawBars["source"];
  market: string;
  instrument: string;
  /** Normalised instrument used for holdout accounting. */
  instrumentKey: string;
  interval: string;
  barMs: number;
  calendar: string;
  /** Bar alignment: open time of the first bar; every bar sits on the calendar grid anchored there. */
  alignment: { firstOpen: string | null; grid: string };
  asOf: string;
  availabilityPolicy: string;
  cleaning: { notAvailableAtAsOf: number; weekendStubsExcluded: Array<{ t: string; reason: string }>; rule: string };
  bars: number;
  firstT: string | null;
  lastT: string | null;
  /** SHA-256 over every used bar (time, OHLCV, availability). */
  contentHash: string;
};

export type Preflight = { ok: true; bars: ResearchBar[]; availableAt: number[] | undefined; identity: DatasetIdentity } | { ok: false; identity: DatasetIdentity; reasons: string[] };

const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());

/** Cheap integrity checks before any trial runs. Applies the declared as-of cut and the recorded cleaning rule. */
export function preflightDataset(dataset: CampaignDataset, raw: RawBars): Preflight {
  const market = marketFor(dataset);
  const barMs = INTERVALS[dataset.interval];
  const asOf = Date.parse(dataset.asOf);
  const hasAvailability = raw.availableAt !== null;
  const keep: number[] = [];
  raw.bars.forEach((b, i) => {
    if ((hasAvailability ? raw.availableAt![i]! : b.t + barMs) <= asOf) keep.push(i);
  });
  const stubs = excludeWeekendStubBars(
    keep.map((i) => raw.bars[i]!),
    { barMs, calendar: market.calendar, tickVolumes: raw.tickVolumes ? keep.map((i) => raw.tickVolumes![i] ?? null) : undefined, availableAt: hasAvailability ? keep.map((i) => raw.availableAt![i]!) : undefined },
  );
  const bars = stubs.bars;
  const availableAt = stubs.availableAt;
  const h = bars.map((b, i) => `${b.t}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume ?? ""}|${availableAt ? availableAt[i] : ""}`).join(";");
  const identity: DatasetIdentity = {
    key: dataset.key,
    source: raw.source,
    market: dataset.market,
    instrument: dataset.instrument,
    instrumentKey: normaliseInstrument(dataset.instrument),
    interval: dataset.interval,
    barMs,
    calendar: market.calendar,
    alignment: { firstOpen: iso(bars[0]?.t), grid: `${market.calendar} session grid at ${dataset.interval}` },
    asOf: dataset.asOf,
    availabilityPolicy: hasAvailability ? "per-bar available_at; a bar is used only if available_at <= asOf" : "bar close (open + interval) <= asOf",
    cleaning: {
      notAvailableAtAsOf: raw.bars.length - keep.length,
      weekendStubsExcluded: stubs.excluded.map((e) => ({ t: new Date(e.t).toISOString(), reason: e.reason })),
      rule: "FX_24_5 only: off-session bars with <= 10 ticks (or <= 5 bps range without a tick count) are excluded and listed; every other bar is kept and validated",
    },
    bars: bars.length,
    firstT: iso(bars[0]?.t),
    lastT: iso(bars.at(-1)?.t),
    contentHash: sha256Hex(h),
  };
  const reasons: string[] = [];
  if (bars.length === 0) reasons.push("NO_BARS: no bar is available at the declared asOf");
  if (bars.length > CAMPAIGN_LIMIT_BOUNDS.maxBarsPerDataset) reasons.push(`TOO_MANY_BARS: ${bars.length} > ${CAMPAIGN_LIMIT_BOUNDS.maxBarsPerDataset}`);
  const issues = bars.length ? validateResearchBars(bars, { barMs, calendar: market.calendar, asOf, availableAt }) : [];
  if (issues.length) reasons.push(`BAR_INTEGRITY: ${issues.length} issue(s) under the ${market.calendar} calendar; first: ${issues.slice(0, 3).map((i) => `#${i.index} ${i.code} ${i.detail}`).join("; ")}`);
  return reasons.length ? { ok: false, identity, reasons } : { ok: true, bars, availableAt, identity };
}

export type UnitJob = {
  mode: "WALK_FORWARD" | "HOLDOUT";
  unit: { hypothesisKind: "STRATEGY" | "ML2"; hypothesisId: string; horizonBars: number | null; searchSpace: unknown; searchSpaceHash: string; lineageKey: string };
  dataset: CampaignDataset;
  validation: CampaignSpec["validation"];
  ml: CampaignSpec["ml"];
  codeVersion: string;
  /** Frozen in the unit's trial reservation. */
  priorTrials: number;
  raw: RawBars;
  /** HOLDOUT mode: the walk-forward hash the authorisation was given for; the re-computation must reproduce it. */
  expectedWalkForwardHash?: string;
};

export type UnitEvaluation = {
  phase: "DATA_REFUSAL" | "WALK_FORWARD" | "HOLDOUT";
  verdict: string;
  reasons: string[];
  walkForwardPassed: boolean;
  holdoutStatus: HoldoutStatus;
  trialCount: number;
  priorTrials: number;
  dataset: DatasetIdentity;
  provenance: Record<string, unknown>;
  summary: Record<string, unknown>;
  detail: Record<string, unknown>;
  /** Hash of everything computed before the holdout; identical in WALK_FORWARD and HOLDOUT mode. */
  walkForwardHash: string | null;
  /** Bars whose outcomes the holdout would read: [start, end). Computed from positions only. */
  holdoutPeriod: { start: string; end: string } | null;
  resultHash: string;
};

/** JSON-safe copy: non-finite numbers become null and undefined members disappear, as JSON.stringify does. */
const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function resultHashOf(e: Pick<UnitEvaluation, "phase" | "verdict" | "reasons" | "walkForwardPassed" | "holdoutStatus" | "trialCount" | "priorTrials" | "dataset" | "provenance" | "summary" | "detail">): string {
  return canonicalHash(roundNumbers(jsonSafe({ phase: e.phase, verdict: e.verdict, reasons: e.reasons, walkForwardPassed: e.walkForwardPassed, holdoutStatus: e.holdoutStatus, trialCount: e.trialCount, priorTrials: e.priorTrials, dataset: e.dataset, provenance: e.provenance, summary: e.summary, detail: e.detail })));
}

export class WalkForwardMismatch extends Error {
  constructor(expected: string, actual: string) {
    super(`WALK_FORWARD_MISMATCH: the re-computed walk-forward (${actual.slice(0, 12)}) differs from the authorised result (${expected.slice(0, 12)}); the holdout evaluation is discarded`);
    this.name = "WalkForwardMismatch";
  }
}

export function evaluateUnit(job: UnitJob): UnitEvaluation {
  const market = marketFor(job.dataset);
  const pre = preflightDataset(job.dataset, job.raw);
  const provenanceBase = {
    codeVersion: job.codeVersion,
    versions: campaignVersions(),
    marketConfigHash: marketConfigHash(market),
    costAssumptions: market.cost.assumptions,
    seeds: { validation: job.validation.seed, ml: job.ml.seed },
    validation: job.validation,
    ml: job.ml,
    searchSpace: job.unit.searchSpace,
    searchSpaceHash: job.unit.searchSpaceHash,
    lineageKey: job.unit.lineageKey,
    acceptance: "Rules and thresholds are those of the pinned validator and ML 2.0 protocol at codeVersion; none is a campaign parameter",
  };
  const finish = (e: Omit<UnitEvaluation, "resultHash">): UnitEvaluation => {
    const safe = jsonSafe(e);
    return { ...safe, resultHash: resultHashOf(safe) };
  };
  if (!pre.ok) {
    return finish({ phase: "DATA_REFUSAL", verdict: "REJECTED_DATA", reasons: pre.reasons, walkForwardPassed: false, holdoutStatus: "NOT_REACHED", trialCount: 0, priorTrials: job.priorTrials, dataset: pre.identity, provenance: provenanceBase, summary: { refused: true }, detail: {}, walkForwardHash: null, holdoutPeriod: null });
  }
  const { bars, availableAt, identity } = pre;
  const barMs = identity.barMs;
  const holdoutMode = job.mode === "HOLDOUT";
  // HOLDOUT mode is entered only after the consume intent is committed; this gate allows exactly one read.
  const gate = holdoutMode ? createMemoryHoldoutGate() : undefined;
  let mlFull: Ml2Report | null = null;
  let report: ReturnType<typeof runHorizonStudy>;
  try {
    report = runHorizonStudy({
      bars,
      barMs,
      barAvailableAt: availableAt,
      market,
      instrument: job.dataset.instrument,
      datasetKey: `${identity.instrumentKey}|${job.dataset.interval}`,
      codeVersion: job.codeVersion,
      priorTrials: job.priorTrials,
      holdoutGate: gate,
      validation: { folds: job.validation.folds, holdoutFraction: job.validation.holdoutFraction, seed: job.validation.seed },
      strategies: job.unit.hypothesisKind === "STRATEGY" ? [job.unit.hypothesisId] : [],
      ml: job.unit.hypothesisKind === "ML2"
        ? { enabled: true, horizons: "PRIMARY", config: { folds: job.validation.folds, holdoutFraction: job.validation.holdoutFraction, seed: job.ml.seed, bootstrapResamples: job.ml.bootstrapResamples, randomControls: job.ml.randomControls, prefixProbes: job.ml.prefixProbes } }
        : { enabled: false },
      onMlReport: (_h, r) => {
        mlFull = r;
      },
    });
  } catch (error) {
    if (!(error instanceof HorizonRefusal)) throw error;
    return finish({ phase: "DATA_REFUSAL", verdict: "REJECTED_DATA", reasons: [error.message], walkForwardPassed: false, holdoutStatus: "NOT_REACHED", trialCount: 0, priorTrials: job.priorTrials, dataset: identity, provenance: provenanceBase, summary: { refused: true }, detail: {}, walkForwardHash: null, holdoutPeriod: null });
  }
  const provenance = { ...provenanceBase, validationCostBpsPerSide: validationCostBpsPerSide(market, job.dataset.instrument, bars, barMs), costIsProxy: true, thresholds: report.thresholds };
  const holdoutStartIndex = Math.floor(bars.length * (1 - job.validation.holdoutFraction));
  const lastClose = bars.at(-1)!.t + barMs;

  if (job.unit.hypothesisKind === "STRATEGY") {
    const s: HorizonStrategyResult | undefined = report.strategies[0];
    if (!s) throw new Error(`strategy ${job.unit.hypothesisId} is not defined for market ${job.dataset.market} at ${job.dataset.interval}`);
    const preHoldoutTrials = s.trials.filter((t) => t.window !== "HOLDOUT");
    const walkForwardHash = canonicalHash(roundNumbers(jsonSafe({ trials: preHoldoutTrials, oos: s.oos, dsr: s.dsr, dsrProgramme: s.dsrProgramme, pbo: s.pbo, costSensitivity: s.costSensitivity, selectedParamsByFold: s.selectedParamsByFold, walkForwardPassed: s.walkForwardPassed })));
    if (holdoutMode && job.expectedWalkForwardHash !== walkForwardHash) throw new WalkForwardMismatch(job.expectedWalkForwardHash ?? "none", walkForwardHash);
    const holdoutPeriod = bars[holdoutStartIndex] ? { start: new Date(bars[holdoutStartIndex]!.t).toISOString(), end: new Date(lastClose).toISOString() } : null;
    return finish({
      phase: holdoutMode ? "HOLDOUT" : "WALK_FORWARD",
      verdict: s.verdict,
      reasons: s.reasons,
      walkForwardPassed: s.walkForwardPassed,
      holdoutStatus: s.holdout.status,
      trialCount: s.trialCount,
      priorTrials: job.priorTrials,
      dataset: identity,
      provenance: { ...provenance, gridAsRun: s.gridAsRun, gridScaleFactor: s.gridScaleFactor, strategyVersion: s.version, family: s.family },
      summary: { kind: "STRATEGY", id: s.id, family: s.family, oos: s.oos, controls: s.controls, dsr: s.dsr, dsrProgramme: s.dsrProgramme, pbo: s.pbo, costSensitivity: s.costSensitivity, holdout: holdoutMode ? { evaluated: s.holdout.evaluated, netReturn: s.holdout.netReturn } : { evaluated: false, netReturn: null }, holdoutPeriod, walkForwardHash },
      detail: { strategy: holdoutMode ? s : { ...s, trials: preHoldoutTrials } },
      walkForwardHash,
      holdoutPeriod,
    });
  }

  const m: HorizonMlResult | undefined = report.ml[0];
  if (!m) throw new Error("ML 2.0 did not run");
  if ("refused" in m) {
    return finish({ phase: "DATA_REFUSAL", verdict: "REJECTED_DATA", reasons: [m.refused], walkForwardPassed: false, holdoutStatus: "NOT_REACHED", trialCount: 0, priorTrials: job.priorTrials, dataset: identity, provenance, summary: { refused: true, kind: "ML2" }, detail: {}, walkForwardHash: null, holdoutPeriod: null });
  }
  const full = mlFull as Ml2Report | null;
  const walkForwardPassed = m.holdout.status !== "NOT_REACHED" || /^final model could not be fitted/.test(m.holdout.reason ?? "");
  const walkForwardHash = canonicalHash(roundNumbers(jsonSafe({ trials: m.trials, championTrialId: m.championTrialId, champion: m.champion, trialCount: m.trialCount, walkForwardPassed })));
  if (holdoutMode && job.expectedWalkForwardHash !== walkForwardHash) throw new WalkForwardMismatch(job.expectedWalkForwardHash ?? "none", walkForwardHash);
  const span = full?.holdoutSpan;
  const holdoutPeriod = span && span.firstT !== null && span.lastT !== null
    ? { start: new Date(span.firstT).toISOString(), end: new Date(lastClose).toISOString() }
    : bars[holdoutStartIndex] ? { start: new Date(bars[holdoutStartIndex]!.t).toISOString(), end: new Date(lastClose).toISOString() } : null;
  // In HOLDOUT mode the gate is consumed even when the final model cannot be fitted: the period is spent either way.
  const holdoutStatus: HoldoutStatus = holdoutMode && walkForwardPassed ? "EVALUATED" : m.holdout.status;
  const champ = full && m.championTrialId ? full.walkForward[m.championTrialId] : undefined;
  const artefact = holdoutMode && m.verdict === "CANDIDATE" && full && m.championTrialId ? full.finalArtefacts[m.championTrialId] ?? null : null;
  return finish({
    phase: holdoutMode ? "HOLDOUT" : "WALK_FORWARD",
    verdict: m.verdict,
    reasons: m.reasons,
    walkForwardPassed,
    holdoutStatus,
    trialCount: m.trialCount,
    priorTrials: job.priorTrials,
    dataset: identity,
    provenance: { ...provenance, labelSpec: full?.labelSpec ?? null, labelSpecHash: full?.labelSpecHash ?? null, featureSetHash: full?.featureSet.hash ?? null, featureSet: full ? { name: full.featureSet.spec.name, version: full.featureSet.spec.version, features: full.featureSet.spec.features } : null, causality: full?.causality ?? null, mlData: full?.data ?? null },
    summary: { kind: "ML2", id: job.unit.hypothesisId, horizonBars: m.horizonBars, horizonTradingHours: m.horizonTradingHours, championTrialId: m.championTrialId, champion: m.champion, walkForwardBrier: champ?.brier ?? null, holdout: holdoutMode && full?.holdout.evaluated ? { evaluated: true, rows: full.holdout.rows, brierSkill: full.holdout.champion.brierSkill, ece: full.holdout.champion.ece, signals: full.holdout.champion.signals, expectancy: full.holdout.champion.expectancy } : { evaluated: false }, holdoutPeriod, walkForwardHash, drift: full ? { brierDecay: full.drift.brierDecay } : null, deployment: full?.deployment ?? null },
    detail: { ml: m, model: artefact && full ? { artefact, artefactCanonical: canonicalJson(artefact), family: artefact.family, walkForwardBrier: champ?.brier ?? null, labelSpec: full.labelSpec, featureSetHash: full.featureSet.hash, calendar: full.calendar, barMs } : null },
    walkForwardHash,
    holdoutPeriod,
  });
}
