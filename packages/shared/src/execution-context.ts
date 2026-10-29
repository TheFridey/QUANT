import {
  accountIdForEnvironment,
  DEFAULT_TRADING_ENVIRONMENT,
  metricsAccountIdFor,
  TRADING_ENVIRONMENTS,
  type TradingEnvironment,
} from "./environments.js";
import type { DataMode } from "./freshness.js";
import type { StrategyConfig } from "./strategy.js";

/**
 * Immutable account/environment/config execution context pinned at cycle/intent creation (D01).
 * All ledger, reservation, protection, and reporting writes must use this context —
 * never re-resolve from live global engine config mid-cycle.
 */
export type ExecutionContext = {
  accountId: string;
  tradingEnvironment: TradingEnvironment;
  dataMode: DataMode;
  /** Metrics / funnel / equity stream for this environment (never mixes fixtures into paper). */
  metricsAccountId: string;
  /** Optional strategy/config revision snapshot identity. */
  configRevision?: string | null;
  /** Optional strategy identity stamp at pin time. */
  strategyRevision?: string | null;
  /** Optional risk policy revision. */
  riskRevision?: string | null;
};

/** Durable payload stored on CycleRun / manual intents. */
export type PinnedExecutionContext = ExecutionContext & {
  pinnedAt: string;
};

export function resolveTradingEnvironment(
  value: string | null | undefined,
): TradingEnvironment {
  if ((TRADING_ENVIRONMENTS as readonly string[]).includes(value ?? "")) {
    return value as TradingEnvironment;
  }
  return DEFAULT_TRADING_ENVIRONMENT;
}

/**
 * Resolve one immutable execution context from engine config + worker data mode.
 * MARKET_DATA_PAPER maps to account id `primary`; other envs use `primary:<env>`.
 */
export function resolveExecutionContext(input: {
  config: Pick<StrategyConfig, "tradingEnvironment"> | StrategyConfig;
  dataMode: DataMode;
  baseAccountId?: string;
  configRevision?: string | null;
  strategyRevision?: string | null;
  riskRevision?: string | null;
}): ExecutionContext {
  const tradingEnvironment = resolveTradingEnvironment(input.config.tradingEnvironment);
  const base = input.baseAccountId ?? "primary";
  const accountId = accountIdForEnvironment(tradingEnvironment, base);
  return {
    accountId,
    tradingEnvironment,
    dataMode: input.dataMode,
    metricsAccountId: metricsAccountIdFor(tradingEnvironment, base),
    configRevision: input.configRevision ?? null,
    strategyRevision: input.strategyRevision ?? null,
    riskRevision: input.riskRevision ?? null,
  };
}

/** Snapshot a context for durable cycle pinning. */
export function pinExecutionContext(
  ctx: ExecutionContext,
  at: Date = new Date(),
): PinnedExecutionContext {
  return {
    ...ctx,
    pinnedAt: at.toISOString(),
  };
}

/**
 * Load a previously pinned context. Rejects malformed / incomplete payloads
 * rather than silently falling back to live global config.
 */
export function loadPinnedExecutionContext(
  raw: unknown,
): { ok: true; ctx: ExecutionContext } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "MISSING_PINNED_CONTEXT" };
  }
  const row = raw as Record<string, unknown>;
  const tradingEnvironment = resolveTradingEnvironment(
    typeof row.tradingEnvironment === "string" ? row.tradingEnvironment : null,
  );
  if (typeof row.accountId !== "string" || row.accountId.length === 0) {
    return { ok: false, reason: "MISSING_PINNED_ACCOUNT" };
  }
  if (typeof row.dataMode !== "string" || row.dataMode.length === 0) {
    return { ok: false, reason: "MISSING_PINNED_DATA_MODE" };
  }
  const expectedAccount = accountIdForEnvironment(tradingEnvironment);
  // Allow explicit baseAccountId variants already stored; only reject empty.
  if (
    row.accountId !== expectedAccount &&
    !String(row.accountId).startsWith("primary")
  ) {
    return { ok: false, reason: "PINNED_ACCOUNT_ENV_MISMATCH" };
  }
  return {
    ok: true,
    ctx: {
      accountId: row.accountId,
      tradingEnvironment,
      dataMode: row.dataMode as DataMode,
      metricsAccountId:
        typeof row.metricsAccountId === "string"
          ? row.metricsAccountId
          : metricsAccountIdFor(tradingEnvironment),
      configRevision: typeof row.configRevision === "string" ? row.configRevision : null,
      strategyRevision: typeof row.strategyRevision === "string" ? row.strategyRevision : null,
      riskRevision: typeof row.riskRevision === "string" ? row.riskRevision : null,
    },
  };
}

/** Refuse cross-environment economic writes at the execution boundary. */
export function assertExecutionAccount(
  ctx: ExecutionContext,
  accountId: string,
): { ok: true } | { ok: false; reason: string } {
  if (accountId !== ctx.accountId) {
    return {
      ok: false,
      reason: `Cross-environment write refused: expected ${ctx.accountId}, got ${accountId}`,
    };
  }
  return { ok: true };
}

/**
 * Compare a live resolution against a pinned context — used to detect mid-cycle
 * environment/config switches that must not redirect economic writes.
 */
export function executionContextMatches(
  pinned: ExecutionContext,
  live: ExecutionContext,
): { ok: true } | { ok: false; reason: string } {
  if (pinned.accountId !== live.accountId) {
    return { ok: false, reason: "ACCOUNT_DRIFT" };
  }
  if (pinned.tradingEnvironment !== live.tradingEnvironment) {
    return { ok: false, reason: "ENVIRONMENT_DRIFT" };
  }
  if (
    pinned.configRevision &&
    live.configRevision &&
    pinned.configRevision !== live.configRevision
  ) {
    return { ok: false, reason: "CONFIG_REVISION_DRIFT" };
  }
  return { ok: true };
}
