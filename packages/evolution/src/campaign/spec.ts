import {
  DEFAULT_LEARNERS,
  DEFAULT_ML2_CONFIG,
  DEFAULT_VALIDATION,
  expandGrid,
  EXTRA_FEATURES_VERSION,
  FEATURE_SET_VERSION,
  HORIZON_RUNNER_VERSION,
  HORIZON_STRATEGIES_VERSION,
  horizonBars,
  horizonStrategySpecs,
  LABELS_VERSION,
  MARKET_CONFIG_VERSION,
  MARKET_CONFIGS,
  marketConfigHash,
  ML2_PROTOCOL_VERSION,
  type MarketId,
  type MarketResearchConfig,
} from "@odin/backtest/research";
import { z } from "zod";
import { canonicalHash, canonicalJson, sha256Hex } from "../genesis/canonical.js";

/**
 * OPERATION EVIDENCE campaign specification (pure). A campaign declares, before anything runs, the datasets, the
 * hypotheses, the validation policy, the cost assumptions and the limits. The specification is immutable: its
 * canonical JSON is hashed and the hash identifies the campaign. Nothing here reads a result, so a disappointing
 * outcome cannot widen a grid or lower a threshold: grids come from the pinned strategy library, acceptance
 * rules from the pinned validator, and neither is a field of the specification.
 */

export const CAMPAIGN_SPEC_VERSION = "campaign-spec-1";
export const CAMPAIGN_RUNNER_VERSION = "campaign-runner-1.0.0";

export const INTERVALS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as const;
export type CampaignInterval = keyof typeof INTERVALS;

/** Hard ceilings. A specification may ask for less, never more. */
export const CAMPAIGN_LIMIT_BOUNDS = {
  maxTrials: 200_000,
  maxRuntimeMsPerUnit: 3_600_000,
  maxMemoryMbPerUnit: 8_192,
  maxConcurrency: 4,
  maxAttemptsPerUnit: 5,
  maxBarsPerDataset: 200_000,
  datasets: 20,
  hypotheses: 40,
  units: 400,
} as const;

const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
const isoInstant = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s) && Number.isFinite(Date.parse(s)), "must be an ISO-8601 UTC instant");
const marketId = z.enum(Object.keys(MARKET_CONFIGS) as [MarketId, ...MarketId[]]);

const datasetSchema = z
  .object({
    key: slug,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("WAREHOUSE"), datasetId: z.string().min(1).max(64) }).strict(),
      /** A local CSV (time,open,high,low,close,volume[,available_at]); the declared SHA-256 must match the file. */
      z.object({ kind: z.literal("FILE"), path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    ]),
    market: marketId,
    instrument: z.string().min(1).max(64),
    interval: z.enum(Object.keys(INTERVALS) as [CampaignInterval, ...CampaignInterval[]]),
    /** Only bars available at or before this instant are used. Fixes the dataset for every retry and rerun. */
    asOf: isoInstant,
    /** Explicit cost assumptions replacing the market defaults (recorded with every result). */
    costOverrides: z.object({ feeBpsPerSide: z.number().min(0).max(1_000).optional(), spreadFull: z.number().min(0).max(10_000).optional(), slippagePerSide: z.number().min(0).max(10_000).optional() }).strict().optional(),
  })
  .strict();

const hypothesisSchema = z.discriminatedUnion("kind", [
  /** One HORIZON strategy family at its pinned, declared grid. */
  z.object({ kind: z.literal("STRATEGY"), id: slug }).strict(),
  /** GENESIS ML 2.0 with the market labels at the market primary horizon (its first declared horizon). */
  z.object({ kind: z.literal("ML2") }).strict(),
]);

export const campaignSpecSchema = z
  .object({
    specVersion: z.literal(CAMPAIGN_SPEC_VERSION),
    name: z.string().min(3).max(120),
    description: z.string().max(2_000).optional(),
    /** True when any dataset is a constructed fixture. Shown wherever the campaign is shown; never evidence of an edge. */
    synthetic: z.boolean(),
    datasets: z.array(datasetSchema).min(1).max(CAMPAIGN_LIMIT_BOUNDS.datasets),
    hypotheses: z.array(hypothesisSchema).min(1).max(CAMPAIGN_LIMIT_BOUNDS.hypotheses),
    validation: z
      .object({
        folds: z.int().min(2).max(10).default(DEFAULT_VALIDATION.folds),
        holdoutFraction: z.number().min(0.1).max(0.4).default(DEFAULT_VALIDATION.holdoutFraction),
        seed: z.int().min(0).max(2_147_483_647),
      })
      .strict(),
    ml: z
      .object({
        seed: z.int().min(0).max(2_147_483_647),
        /** Resampling effort only; none of these is an acceptance threshold. */
        bootstrapResamples: z.int().min(20).max(5_000).default(DEFAULT_ML2_CONFIG.bootstrapResamples),
        randomControls: z.int().min(10).max(5_000).default(DEFAULT_ML2_CONFIG.randomControls),
        prefixProbes: z.int().min(1).max(64).default(DEFAULT_ML2_CONFIG.prefixProbes),
      })
      .strict(),
    limits: z
      .object({
        maxTrials: z.int().min(1).max(CAMPAIGN_LIMIT_BOUNDS.maxTrials),
        maxRuntimeMsPerUnit: z.int().min(1_000).max(CAMPAIGN_LIMIT_BOUNDS.maxRuntimeMsPerUnit),
        maxMemoryMbPerUnit: z.int().min(128).max(CAMPAIGN_LIMIT_BOUNDS.maxMemoryMbPerUnit),
        maxConcurrency: z.int().min(1).max(CAMPAIGN_LIMIT_BOUNDS.maxConcurrency),
        maxAttemptsPerUnit: z.int().min(1).max(CAMPAIGN_LIMIT_BOUNDS.maxAttemptsPerUnit),
      })
      .strict(),
    /** The only supported policy: a holdout is read only under a recorded operator authorisation for one frozen result. */
    holdoutPolicy: z.literal("WITHHELD_UNLESS_AUTHORIZED"),
  })
  .strict();

export type CampaignSpec = z.infer<typeof campaignSpecSchema>;
export type CampaignDataset = CampaignSpec["datasets"][number];
export type CampaignHypothesis = CampaignSpec["hypotheses"][number];

export class CampaignSpecError extends Error {
  constructor(message: string) {
    super(`CAMPAIGN_SPEC: ${message}`);
    this.name = "CampaignSpecError";
  }
}

/** The market configuration a dataset is studied under, with its declared cost overrides applied and recorded. */
export function marketFor(dataset: Pick<CampaignDataset, "market" | "costOverrides">): MarketResearchConfig {
  const base = MARKET_CONFIGS[dataset.market];
  const o = dataset.costOverrides;
  if (!o || (o.feeBpsPerSide === undefined && o.spreadFull === undefined && o.slippagePerSide === undefined)) return base;
  // An override may make the study harder, never easier: a cost below the market default would lower the bar
  // a hypothesis has to clear in walk-forward and in its holdout.
  for (const [name, value, floor] of [["feeBpsPerSide", o.feeBpsPerSide, base.cost.feeBpsPerSide], ["spreadFull", o.spreadFull, base.cost.spreadFull], ["slippagePerSide", o.slippagePerSide, base.cost.slippagePerSide]] as const) {
    if (value !== undefined && value < floor) throw new CampaignSpecError(`costOverrides.${name} ${value} is below the ${dataset.market} default ${floor}; a campaign may raise cost assumptions, not lower them`);
  }
  return {
    ...base,
    cost: {
      ...base.cost,
      feeBpsPerSide: o.feeBpsPerSide ?? base.cost.feeBpsPerSide,
      spreadFull: o.spreadFull ?? base.cost.spreadFull,
      slippagePerSide: o.slippagePerSide ?? base.cost.slippagePerSide,
      assumptions: [...base.cost.assumptions, `Campaign override: fee ${o.feeBpsPerSide ?? "default"} bps/side, spread ${o.spreadFull ?? "default"}, slippage ${o.slippagePerSide ?? "default"} (${base.cost.unit})`],
    },
  };
}

export type PlannedUnit = {
  seq: number;
  datasetKey: string;
  hypothesisKind: "STRATEGY" | "ML2";
  hypothesisId: string;
  /** Upper bound on the trials the unit can run: the declared grid is never widened, only de-duplicated. */
  plannedTrials: number;
  /** Declared search space: the strategy grid as pinned in the library, or the ML learner list. */
  searchSpace: unknown;
  searchSpaceHash: string;
  /** ML2 only: label horizon in bars. */
  horizonBars: number | null;
  /** Name-independent lineage for holdout accounting. */
  lineageKey: string;
  unitSpecHash: string;
};

export function campaignVersions() {
  return {
    campaignRunner: CAMPAIGN_RUNNER_VERSION,
    horizonRunner: HORIZON_RUNNER_VERSION,
    strategies: HORIZON_STRATEGIES_VERSION,
    marketConfig: MARKET_CONFIG_VERSION,
    ml2Protocol: ML2_PROTOCOL_VERSION,
    features: FEATURE_SET_VERSION,
    extraFeatures: EXTRA_FEATURES_VERSION,
    labels: LABELS_VERSION,
  };
}

/**
 * Validates a specification and expands it into units (dataset x hypothesis) with their trial upper bounds.
 * Refuses unknown strategies or horizons, duplicate keys, and any plan above the declared or hard limits.
 */
export function planCampaign(raw: unknown): { spec: CampaignSpec; specCanonical: string; specHash: string; units: PlannedUnit[]; plannedTrials: number } {
  const parsed = campaignSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CampaignSpecError(`${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
  }
  const spec = parsed.data;
  const keys = new Set<string>();
  for (const d of spec.datasets) {
    if (keys.has(d.key)) throw new CampaignSpecError(`duplicate dataset key ${d.key}`);
    keys.add(d.key);
  }
  const hypothesisIds = new Set<string>();
  const versions = campaignVersions();
  const units: PlannedUnit[] = [];
  for (const dataset of spec.datasets) {
    const market = marketFor(dataset);
    const barMs = INTERVALS[dataset.interval];
    // The grids depend on the market and bar size only; regimeAt is irrelevant to which grid is declared.
    const strategies = horizonStrategySpecs({ market, instrument: dataset.instrument, barMs, regimeAt: () => undefined });
    for (const hypothesis of spec.hypotheses) {
      let unit: Omit<PlannedUnit, "seq" | "unitSpecHash">;
      if (hypothesis.kind === "STRATEGY") {
        const strategy = strategies.find((s) => s.id === hypothesis.id);
        if (!strategy) throw new CampaignSpecError(`dataset ${dataset.key}: unknown strategy ${hypothesis.id} for market ${dataset.market} at ${dataset.interval} (known: ${strategies.map((s) => s.id).join(", ")})`);
        const points = expandGrid(strategy.grid).length;
        const searchSpace = { strategyId: strategy.id, strategyVersion: strategy.version, family: strategy.family, grid: strategy.grid, horizonParams: strategy.horizonParams, points };
        unit = {
          datasetKey: dataset.key,
          hypothesisKind: "STRATEGY",
          hypothesisId: strategy.id,
          // Every grid point in every fold (TRAIN), one TEST per fold, and the full pre-holdout grid (PBO).
          plannedTrials: points * spec.validation.folds + spec.validation.folds + points,
          searchSpace,
          searchSpaceHash: canonicalHash(searchSpace),
          horizonBars: null,
          lineageKey: `STRATEGY:${strategy.family}`,
        };
      } else {
        const hours = market.horizonsTradingHours[0]!;
        const bars = horizonBars(market, hours, barMs);
        const searchSpace = { protocol: ML2_PROTOCOL_VERSION, target: "NET_POSITIVE", horizonTradingHours: hours, horizonBars: bars, learners: DEFAULT_LEARNERS };
        unit = {
          datasetKey: dataset.key,
          hypothesisKind: "ML2",
          hypothesisId: `ml2:h${hours}`,
          plannedTrials: DEFAULT_LEARNERS.length,
          searchSpace,
          searchSpaceHash: canonicalHash(searchSpace),
          horizonBars: bars,
          // One lineage for every ML 2.0 study of the target: horizon, bar size, folds, seed and learner are tuning choices.
          lineageKey: "ML2:NET_POSITIVE",
        };
      }
      const id = `${unit.datasetKey}|${unit.hypothesisId}`;
      if (hypothesisIds.has(id)) throw new CampaignSpecError(`duplicate hypothesis ${unit.hypothesisId} on dataset ${dataset.key}`);
      hypothesisIds.add(id);
      const unitSpecHash = canonicalHash({ dataset, hypothesis: { kind: unit.hypothesisKind, id: unit.hypothesisId }, searchSpaceHash: unit.searchSpaceHash, marketConfigHash: marketConfigHash(market), validation: spec.validation, ml: spec.ml, versions });
      units.push({ ...unit, seq: units.length, unitSpecHash });
    }
  }
  if (units.length > CAMPAIGN_LIMIT_BOUNDS.units) throw new CampaignSpecError(`${units.length} units exceed the hard limit of ${CAMPAIGN_LIMIT_BOUNDS.units}`);
  const plannedTrials = units.reduce((n, u) => n + u.plannedTrials, 0);
  if (plannedTrials > spec.limits.maxTrials) throw new CampaignSpecError(`declared grids need up to ${plannedTrials} trials, above limits.maxTrials ${spec.limits.maxTrials}; narrow the campaign or raise the declared limit before running`);
  const specCanonical = canonicalJson(spec);
  return { spec, specCanonical, specHash: sha256Hex(specCanonical), units, plannedTrials };
}

/** Upper-case letters and digits only, so EUR_USD, EUR/USD, eurusd and fx:EURUSD are one instrument. */
export function normaliseInstrument(instrument: string): string {
  // A registry or file prefix (fx:, commodity:, csv:) names a venue or source, not the instrument.
  const cleaned = instrument.slice(instrument.lastIndexOf(":") + 1).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) throw new CampaignSpecError(`instrument ${JSON.stringify(instrument)} has no letters or digits`);
  return cleaned;
}
