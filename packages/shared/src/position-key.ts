/**
 * Structured position identity — never recover account/instrument by splitting on the first colon.
 * Display keys remain `${accountId}:${instrumentId}` but parsing requires the known accountId.
 */

import { accountIdForEnvironment, TRADING_ENVIRONMENTS } from "./environments.js";

export type PositionIdentity = {
  accountId: string;
  instrumentId: string;
  lifecycleId?: string | null;
};

/** Known env account ids — used to reject ambiguous shorter prefixes (primary vs primary:fixture). */
function knownAccountIds(base = "primary"): string[] {
  return [
    base,
    ...TRADING_ENVIRONMENTS.map((env) => accountIdForEnvironment(env, base)),
  ];
}

/** Build the canonical display/storage key for a position. */
export function buildPositionKey(accountId: string, instrumentId: string): string {
  return `${accountId}:${instrumentId}`;
}

/**
 * Extract instrument id given the owning account id.
 * Returns null when the key is not prefixed by that account (exact, colon-delimited).
 * Also returns null when a longer known account id is a better prefix match — so
 * `primary` never steals `primary:fixture:etf:SPY` via first-colon heuristics.
 */
export function instrumentIdFromPositionKey(
  positionKey: string,
  accountId: string,
): string | null {
  const prefix = `${accountId}:`;
  if (!positionKey.startsWith(prefix)) return null;
  for (const known of knownAccountIds()) {
    if (known === accountId) continue;
    if (known.length > accountId.length && positionKey.startsWith(`${known}:`)) {
      return null;
    }
  }
  const instrumentId = positionKey.slice(prefix.length);
  return instrumentId.length > 0 ? instrumentId : null;
}

/**
 * Parse a position key when the account id is known. Prefer this over delimiter heuristics.
 */
export function parsePositionKey(
  positionKey: string,
  accountId: string,
): PositionIdentity | null {
  const instrumentId = instrumentIdFromPositionKey(positionKey, accountId);
  if (!instrumentId) return null;
  return { accountId, instrumentId };
}

/** Exact key equality — no suffix / first-colon fallback matching. */
export function positionKeysEqual(a: string, b: string): boolean {
  return a === b;
}
