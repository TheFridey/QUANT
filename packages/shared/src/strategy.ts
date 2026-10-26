import { z } from "zod";
import { d } from "./money.js";

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

export const strategyConfigSchema = z
  .object({
    startingBalanceUsd: decimalString,
    feeBps: decimalString,
    maxSlippageBps: decimalString,
    minLiquidityUsd: decimalString,
    minVolume24hUsd: decimalString,
    entryM5ChangePct: decimalString,
    maxEntryM5ChangePct: decimalString,
    minH1ChangePct: decimalString,
    exitM5ChangePct: decimalString,
    stopLossPct: decimalString,
    takeProfitPct: decimalString,
    maxPositions: z.number().int(),
    maxPositionPctEquity: decimalString,
    maxDailyLossPct: decimalString,
    maxParticipationPctLiquidity: decimalString,
    minOrderNotionalUsd: decimalString,
    allowDelayedExits: z.boolean(),
    flattenOnEmergency: z.boolean(),
    universeLimit: z.number().int(),
    liveMaxAgeMs: z.number().int(),
    delayedMaxAgeMs: z.number().int(),
    /** Max equity risked per trade from stop distance (institutional default 0.5%). */
    maxRiskPerTradePct: decimalString,
    /** Cap on sum of open position market values as % of equity (default 20%). */
    maxAggregateExposurePct: decimalString,
    /** Max drawdown from high-water mark equity (default 10%). */
    maxTotalDrawdownPct: decimalString,
    /** Max estimated price impact in bps (defaults aligned with maxSlippageBps). */
    maxPriceImpactBps: decimalString,
    /** Simulated paper order latency before fill eligibility. */
    paperLatencyMs: z.number().int(),
    /** Half-spread estimate applied to mid for paper fills (bps). */
    spreadBpsEstimate: decimalString,
    /** Pending paper order expiry window. */
    orderExpiryMs: z.number().int(),
    /** Minimum observations required before historical pulse indicators compute. */
    pulseMinObservations: z.number().int(),
    /** Max pair age in hours for discovery (null = no max). Stored as decimal string hours or empty. */
    discoveryMaxPairAgeHours: decimalString.nullable(),
    discoveryMinPairAgeMinutes: decimalString,
  })
  .strict()
  .superRefine((value, ctx) => {
    const bounds: Array<[keyof typeof value, string, string]> = [
      ["startingBalanceUsd", "1", "1000000000"],
      ["feeBps", "0", "500"],
      ["maxSlippageBps", "1", "1000"],
      ["minLiquidityUsd", "0", "1000000000000"],
      ["minVolume24hUsd", "0", "1000000000000"],
      ["entryM5ChangePct", "0", "100"],
      ["maxEntryM5ChangePct", "0.1", "100"],
      ["minH1ChangePct", "-100", "100"],
      ["exitM5ChangePct", "-100", "100"],
      ["stopLossPct", "0.1", "100"],
      ["takeProfitPct", "0.1", "1000"],
      ["maxPositionPctEquity", "0.1", "100"],
      ["maxDailyLossPct", "0.1", "100"],
      ["maxParticipationPctLiquidity", "0.01", "5"],
      ["minOrderNotionalUsd", "1", "1000000"],
      ["maxRiskPerTradePct", "0.01", "25"],
      ["maxAggregateExposurePct", "0.1", "100"],
      ["maxTotalDrawdownPct", "0.1", "100"],
      ["maxPriceImpactBps", "1", "1000"],
      ["spreadBpsEstimate", "0", "500"],
      ["discoveryMinPairAgeMinutes", "0", "10080"],
    ];
    for (const [key, min, max] of bounds) {
      const raw = value[key];
      if (typeof raw !== "string" || !inRange(raw, min, max)) {
        ctx.addIssue({ code: "custom", path: [key], message: `Must be between ${min} and ${max}` });
      }
    }
    if (value.discoveryMaxPairAgeHours !== null) {
      if (!inRange(value.discoveryMaxPairAgeHours, "0.1", "8760")) {
        ctx.addIssue({
          code: "custom",
          path: ["discoveryMaxPairAgeHours"],
          message: "Must be between 0.1 and 8760 when set",
        });
      }
    }
    if (value.maxPositions < 1 || value.maxPositions > 10) {
      ctx.addIssue({ code: "custom", path: ["maxPositions"], message: "Must be from 1 to 10" });
    }
    if (value.universeLimit < 1 || value.universeLimit > 30) {
      ctx.addIssue({ code: "custom", path: ["universeLimit"], message: "Must be from 1 to 30" });
    }
    if (value.liveMaxAgeMs < 5000 || value.liveMaxAgeMs > 300000) {
      ctx.addIssue({ code: "custom", path: ["liveMaxAgeMs"], message: "Must be from 5000 to 300000" });
    }
    if (value.delayedMaxAgeMs <= value.liveMaxAgeMs || value.delayedMaxAgeMs > 3600000) {
      ctx.addIssue({
        code: "custom",
        path: ["delayedMaxAgeMs"],
        message: "Must be greater than liveMaxAgeMs and at most 3600000",
      });
    }
    if (value.paperLatencyMs < 0 || value.paperLatencyMs > 60_000) {
      ctx.addIssue({ code: "custom", path: ["paperLatencyMs"], message: "Must be from 0 to 60000" });
    }
    if (value.orderExpiryMs < 1000 || value.orderExpiryMs > 3_600_000) {
      ctx.addIssue({ code: "custom", path: ["orderExpiryMs"], message: "Must be from 1000 to 3600000" });
    }
    if (value.pulseMinObservations < 2 || value.pulseMinObservations > 500) {
      ctx.addIssue({ code: "custom", path: ["pulseMinObservations"], message: "Must be from 2 to 500" });
    }
    if (d(value.maxEntryM5ChangePct).lt(value.entryM5ChangePct)) {
      ctx.addIssue({
        code: "custom",
        path: ["maxEntryM5ChangePct"],
        message: "Must be at least the entry threshold",
      });
    }
  });

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export const strategyPatchSchema = z
  .object({
    startingBalanceUsd: decimalString.optional(),
    feeBps: decimalString.optional(),
    maxSlippageBps: decimalString.optional(),
    minLiquidityUsd: decimalString.optional(),
    minVolume24hUsd: decimalString.optional(),
    entryM5ChangePct: decimalString.optional(),
    maxEntryM5ChangePct: decimalString.optional(),
    minH1ChangePct: decimalString.optional(),
    exitM5ChangePct: decimalString.optional(),
    stopLossPct: decimalString.optional(),
    takeProfitPct: decimalString.optional(),
    maxPositions: z.number().int().optional(),
    maxPositionPctEquity: decimalString.optional(),
    maxDailyLossPct: decimalString.optional(),
    maxParticipationPctLiquidity: decimalString.optional(),
    minOrderNotionalUsd: decimalString.optional(),
    allowDelayedExits: z.boolean().optional(),
    flattenOnEmergency: z.boolean().optional(),
    universeLimit: z.number().int().optional(),
    liveMaxAgeMs: z.number().int().optional(),
    delayedMaxAgeMs: z.number().int().optional(),
    maxRiskPerTradePct: decimalString.optional(),
    maxAggregateExposurePct: decimalString.optional(),
    maxTotalDrawdownPct: decimalString.optional(),
    maxPriceImpactBps: decimalString.optional(),
    paperLatencyMs: z.number().int().optional(),
    spreadBpsEstimate: decimalString.optional(),
    orderExpiryMs: z.number().int().optional(),
    pulseMinObservations: z.number().int().optional(),
    discoveryMaxPairAgeHours: decimalString.nullable().optional(),
    discoveryMinPairAgeMinutes: decimalString.optional(),
  })
  .strict();

/** Institutional paper defaults. Missing keys on older configs merge from here. */
export const DEFAULT_STRATEGY: StrategyConfig = {
  startingBalanceUsd: "100.00000000",
  feeBps: "30",
  maxSlippageBps: "150",
  minLiquidityUsd: "25000",
  minVolume24hUsd: "50000",
  entryM5ChangePct: "2",
  maxEntryM5ChangePct: "25",
  minH1ChangePct: "0",
  exitM5ChangePct: "-1.5",
  stopLossPct: "3",
  takeProfitPct: "5",
  maxPositions: 4,
  maxPositionPctEquity: "5",
  maxDailyLossPct: "3",
  maxParticipationPctLiquidity: "1",
  minOrderNotionalUsd: "5",
  allowDelayedExits: true,
  flattenOnEmergency: false,
  universeLimit: 12,
  liveMaxAgeMs: 45000,
  delayedMaxAgeMs: 180000,
  maxRiskPerTradePct: "0.5",
  maxAggregateExposurePct: "20",
  maxTotalDrawdownPct: "10",
  maxPriceImpactBps: "150",
  paperLatencyMs: 0,
  spreadBpsEstimate: "5",
  orderExpiryMs: 60_000,
  pulseMinObservations: 5,
  discoveryMaxPairAgeHours: null,
  discoveryMinPairAgeMinutes: "0",
};

export function parseStrategyConfig(value: unknown): StrategyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return strategyConfigSchema.parse(DEFAULT_STRATEGY);
  }
  const stored = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  return strategyConfigSchema.parse({ ...DEFAULT_STRATEGY, ...stored });
}

export function mergeStrategy(current: StrategyConfig, patch: unknown): StrategyConfig {
  const parsedPatch = strategyPatchSchema.parse(patch);
  return strategyConfigSchema.parse({ ...current, ...parsedPatch });
}

function inRange(value: string, min: string, max: string): boolean {
  try {
    const parsed = d(value);
    return parsed.gte(min) && parsed.lte(max);
  } catch {
    return false;
  }
}
