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
      ["minH1ChangePct", "-100", "100"],
      ["exitM5ChangePct", "-100", "100"],
      ["stopLossPct", "0.1", "100"],
      ["takeProfitPct", "0.1", "1000"],
      ["maxPositionPctEquity", "0.1", "100"],
      ["maxDailyLossPct", "0.1", "100"],
      ["maxParticipationPctLiquidity", "0.01", "5"],
      ["minOrderNotionalUsd", "1", "1000000"],
    ];
    for (const [key, min, max] of bounds) {
      const raw = value[key];
      if (typeof raw !== "string" || !inRange(raw, min, max)) {
        ctx.addIssue({ code: "custom", path: [key], message: `Must be between ${min} and ${max}` });
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
  })
  .strict();

export const DEFAULT_STRATEGY: StrategyConfig = {
  startingBalanceUsd: "100.00000000",
  feeBps: "30",
  maxSlippageBps: "150",
  minLiquidityUsd: "25000",
  minVolume24hUsd: "50000",
  entryM5ChangePct: "2",
  minH1ChangePct: "0",
  exitM5ChangePct: "-1.5",
  stopLossPct: "3",
  takeProfitPct: "5",
  maxPositions: 3,
  maxPositionPctEquity: "25",
  maxDailyLossPct: "10",
  maxParticipationPctLiquidity: "1",
  minOrderNotionalUsd: "5",
  allowDelayedExits: true,
  flattenOnEmergency: false,
  universeLimit: 12,
  liveMaxAgeMs: 45000,
  delayedMaxAgeMs: 180000,
};

export function parseStrategyConfig(value: unknown): StrategyConfig {
  return strategyConfigSchema.parse(value);
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
