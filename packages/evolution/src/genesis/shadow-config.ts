/**
 * GENESIS shadow configuration from the environment. Disabled unless GENESIS_SHADOW_ENABLED is exactly
 * "true". Every budget is clamped to a hard ceiling, so a mistyped value cannot make a cycle unbounded.
 */
export const GENESIS_SHADOW_FLAG = "GENESIS_SHADOW_ENABLED";

export type ShadowBudget = {
  /** Models processed per cycle. */
  maxModels: number;
  /** Prediction rows (PREDICTED or ABSTAINED) written per cycle. */
  maxPredictions: number;
  /** Outcomes resolved per cycle. */
  maxResolutions: number;
  /** Wall-clock budget of one cycle; no new unit of work starts after it. */
  maxMs: number;
};

export const DEFAULT_SHADOW_BUDGET: ShadowBudget = { maxModels: 5, maxPredictions: 200, maxResolutions: 500, maxMs: 20_000 };
export const SHADOW_BUDGET_CEILING: ShadowBudget = { maxModels: 20, maxPredictions: 1_000, maxResolutions: 2_000, maxMs: 60_000 };

export function shadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GENESIS_SHADOW_FLAG] === "true";
}

function bounded(raw: string | undefined, fallback: number, ceiling: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(ceiling, Math.floor(n));
}

export function shadowBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): ShadowBudget {
  return {
    maxModels: bounded(env.GENESIS_SHADOW_MAX_MODELS, DEFAULT_SHADOW_BUDGET.maxModels, SHADOW_BUDGET_CEILING.maxModels),
    maxPredictions: bounded(env.GENESIS_SHADOW_MAX_PREDICTIONS, DEFAULT_SHADOW_BUDGET.maxPredictions, SHADOW_BUDGET_CEILING.maxPredictions),
    maxResolutions: bounded(env.GENESIS_SHADOW_MAX_RESOLUTIONS, DEFAULT_SHADOW_BUDGET.maxResolutions, SHADOW_BUDGET_CEILING.maxResolutions),
    maxMs: bounded(env.GENESIS_SHADOW_MAX_MS, DEFAULT_SHADOW_BUDGET.maxMs, SHADOW_BUDGET_CEILING.maxMs),
  };
}

/** Repeat interval of the worker job: default 5 minutes, never under 1 minute. */
export function shadowEveryMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GENESIS_SHADOW_TICK_MS ?? 300_000);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : 300_000;
}

export function clampBudget(budget: Partial<ShadowBudget>): ShadowBudget {
  const out = { ...DEFAULT_SHADOW_BUDGET };
  for (const key of Object.keys(out) as Array<keyof ShadowBudget>) {
    const v = budget[key];
    if (v !== undefined && Number.isFinite(v) && v >= 1) out[key] = Math.min(SHADOW_BUDGET_CEILING[key], Math.floor(v));
  }
  return out;
}
