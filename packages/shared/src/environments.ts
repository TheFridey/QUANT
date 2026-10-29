import { z } from "zod";

/**
 * Explicit trading environments — account/ledger/orders/metrics MUST NOT mix.
 * FIXTURE never feeds MARKET_DATA_PAPER or EXTERNAL_DEMO accounts.
 */
export const TRADING_ENVIRONMENTS = [
  "FIXTURE",
  "REPLAY",
  "MARKET_DATA_PAPER",
  "EXTERNAL_DEMO",
] as const;
export type TradingEnvironment = (typeof TRADING_ENVIRONMENTS)[number];

export const DATA_ORIGINS = [
  "LIVE_FEED",
  "DELAYED_FEED",
  "FIXTURE_SEQUENCE",
  "REPLAY_STORE",
  "PROVIDER_DEMO",
  "SANDBOX_BROKER",
] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

export const PROVIDER_READINESS = [
  "MISSING_CREDENTIALS",
  "NOT_IMPLEMENTED",
  "INVALID_CONFIGURATION",
  "AUTH_FAILED",
  "MISSING_ENTITLEMENT",
  "CONNECTING",
  "READY",
] as const;
export type ProviderReadiness = (typeof PROVIDER_READINESS)[number];

export const tradingEnvironmentSchema = z.enum(TRADING_ENVIRONMENTS);
export const dataOriginSchema = z.enum(DATA_ORIGINS);
export const providerReadinessSchema = z.enum(PROVIDER_READINESS);

/** Default paper-first session: market-driven Solana paper — not fixtures. */
export const DEFAULT_TRADING_ENVIRONMENT: TradingEnvironment = "MARKET_DATA_PAPER";

export function accountIdForEnvironment(env: TradingEnvironment, base = "primary"): string {
  if (env === "MARKET_DATA_PAPER" && base === "primary") return "primary";
  return `${base}:${env.toLowerCase()}`;
}

export function isFixtureEnvironment(env: TradingEnvironment): boolean {
  return env === "FIXTURE";
}

export function isReplayEnvironment(env: TradingEnvironment): boolean {
  return env === "REPLAY";
}

/**
 * Resolve which paper account owns metrics / funnel / equity snapshots.
 * REPLAY and FIXTURE never share the MARKET_DATA_PAPER primary ledger.
 */
export function metricsAccountIdFor(
  env: TradingEnvironment | string | null | undefined,
  base = "primary",
): string {
  const resolved = (TRADING_ENVIRONMENTS as readonly string[]).includes(env ?? "")
    ? (env as TradingEnvironment)
    : DEFAULT_TRADING_ENVIRONMENT;
  return accountIdForEnvironment(resolved, base);
}

/** True when a funnel/equity/report row's accountId may be included for this env. */
export function metricsAccountMatches(
  rowAccountId: string | null | undefined,
  env: TradingEnvironment | string | null | undefined,
): boolean {
  const expected = metricsAccountIdFor(env);
  if (!rowAccountId || rowAccountId === "primary") {
    // Legacy rows defaulted to primary — only visible to MARKET_DATA_PAPER.
    return expected === "primary";
  }
  return rowAccountId === expected;
}

export function assertEnvironmentIsolation(
  observationOrigin: DataOrigin,
  accountEnvironment: TradingEnvironment,
): { ok: true } | { ok: false; reason: string } {
  if (observationOrigin === "FIXTURE_SEQUENCE" && accountEnvironment !== "FIXTURE") {
    return {
      ok: false,
      reason: `Fixture quotes cannot enter ${accountEnvironment} account/metrics`,
    };
  }
  if (observationOrigin === "REPLAY_STORE" && accountEnvironment !== "REPLAY") {
    return {
      ok: false,
      reason: `Replay observations cannot enter ${accountEnvironment} account/metrics`,
    };
  }
  if (
    (observationOrigin === "PROVIDER_DEMO" || observationOrigin === "SANDBOX_BROKER") &&
    accountEnvironment !== "EXTERNAL_DEMO"
  ) {
    return {
      ok: false,
      reason: `External demo provenance cannot enter ${accountEnvironment} account`,
    };
  }
  return { ok: true };
}
