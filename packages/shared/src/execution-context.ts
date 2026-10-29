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
 * Immutable account/environment execution context resolved once per cycle (R03).
 * All ledger, reservation, protection, and reporting writes must use this context —
 * never fall back across environments.
 */
export type ExecutionContext = {
  accountId: string;
  tradingEnvironment: TradingEnvironment;
  dataMode: DataMode;
  /** Metrics / funnel / equity stream for this environment (never mixes fixtures into paper). */
  metricsAccountId: string;
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
}): ExecutionContext {
  const tradingEnvironment = resolveTradingEnvironment(input.config.tradingEnvironment);
  const base = input.baseAccountId ?? "primary";
  const accountId = accountIdForEnvironment(tradingEnvironment, base);
  return {
    accountId,
    tradingEnvironment,
    dataMode: input.dataMode,
    metricsAccountId: metricsAccountIdFor(tradingEnvironment, base),
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
