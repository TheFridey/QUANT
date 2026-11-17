/**
 * OPERATION AURUM: GOLD_ONLY operational profile. **Pure, unwired and inactive by default.**
 *
 * Default-deny allowlist for AURUM order admission. The only instrument that can ever be TRADEABLE is
 * the configured gold spread-bet product's reference instrument. Every other instrument is at most
 * OBSERVATIONAL_ONLY (context for research, never executable). Unlisted instruments are DISABLED.
 *
 * Wiring this into the order path (planner, risk, settlement) is PCR-AURUM-01 (protected). Until then
 * nothing calls it and the legacy engine is unchanged. See docs/aurum/SCOPE.md.
 */

import { AURUM_GENERIC_GOLD_DFB_V1, type SpreadBetProductSpec } from "./spread-bet.js";

export const AURUM_INSTRUMENT_ROLES = ["TRADEABLE", "OBSERVATIONAL_ONLY", "RESEARCH_ONLY", "ARCHIVED", "DISABLED"] as const;
export type AurumInstrumentRole = (typeof AURUM_INSTRUMENT_ROLES)[number];

export const AURUM_ORDER_ACTIONS = [
  "OPEN_LONG",
  "OPEN_SHORT",
  "REDUCE_LONG",
  "REDUCE_SHORT",
  "CLOSE_LONG",
  "CLOSE_SHORT",
  "CANCEL_ORDER",
] as const;
export type AurumOrderAction = (typeof AURUM_ORDER_ACTIONS)[number];

export const OPENING_ACTIONS: readonly AurumOrderAction[] = ["OPEN_LONG", "OPEN_SHORT"];

export type AurumProfile = {
  id: "GOLD_ONLY";
  /** Operator activation. Ships false. When false, opening actions are refused; exits and cancels are not. */
  active: boolean;
  /** Exactly one product, by spec id. */
  tradeableProductId: string;
  /** Reference instrument of that product (must be commodity:XAUUSD). */
  tradeableInstrumentId: string;
  /** Account the profile may book against. Never the legacy `primary` account. */
  accountId: string;
  /** Explicit roles for non-tradeable instruments. Anything absent is DISABLED. */
  roles: Readonly<Record<string, Exclude<AurumInstrumentRole, "TRADEABLE">>>;
};

export const AURUM_GOLD_INSTRUMENT_ID = "commodity:XAUUSD";
export const LEGACY_ACCOUNT_ID = "primary";

export const AURUM_GOLD_ONLY_PROFILE: AurumProfile = Object.freeze({
  id: "GOLD_ONLY",
  active: false,
  tradeableProductId: "aurum-generic-gold-dfb-gbp-v1",
  tradeableInstrumentId: AURUM_GOLD_INSTRUMENT_ID,
  accountId: "aurum",
  roles: Object.freeze({
    // Context candidates for AURUM MACRO / Family J research. Never executable.
    "fx:EURUSD": "OBSERVATIONAL_ONLY",
    "fx:GBPUSD": "OBSERVATIONAL_ONLY",
    "fx:USDJPY": "OBSERVATIONAL_ONLY",
    "etf:SPY": "OBSERVATIONAL_ONLY",
    "etf:QQQ": "OBSERVATIONAL_ONLY",
    "commodity:WTI": "OBSERVATIONAL_ONLY",
    "index:SPX": "RESEARCH_ONLY",
    "index:NDX": "RESEARCH_ONLY",
    "index:FTSE": "RESEARCH_ONLY",
    "index:DJI": "RESEARCH_ONLY",
    // Legacy Solana universe: history preserved, nothing new in AURUM.
    "solana:spot:universe": "ARCHIVED",
  }),
}) as AurumProfile;

export const AURUM_SCOPE_REASONS = [
  "INVALID_PROFILE",
  "UNKNOWN_ACTION",
  "INSTRUMENT_NOT_TRADEABLE",
  "PRODUCT_NOT_TRADEABLE",
  "LEGACY_ACCOUNT_REFUSED",
  "ACCOUNT_NOT_AURUM",
  "AURUM_PROFILE_INACTIVE",
] as const;
export type AurumScopeReason = (typeof AURUM_SCOPE_REASONS)[number];

/** Registered spread-bet products. A profile may only name one of these, and it must reference gold. */
const PRODUCT_REGISTRY: Readonly<Record<string, SpreadBetProductSpec>> = Object.freeze({
  [AURUM_GENERIC_GOLD_DFB_V1.id]: AURUM_GENERIC_GOLD_DFB_V1,
});

/** Legacy if it is `primary` or `primary:*` after trimming and case-folding. */
function isLegacyAccount(accountId: unknown): boolean {
  if (typeof accountId !== "string") return true;
  const norm = accountId.trim().toLowerCase();
  return norm === LEGACY_ACCOUNT_ID || norm.startsWith(`${LEGACY_ACCOUNT_ID}:`);
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function profileValid(p: AurumProfile): boolean {
  if (!p || p.id !== "GOLD_ONLY") return false;
  if (p.tradeableInstrumentId !== AURUM_GOLD_INSTRUMENT_ID) return false;
  if (typeof p.tradeableProductId !== "string" || !Object.prototype.hasOwnProperty.call(PRODUCT_REGISTRY, p.tradeableProductId)) return false;
  if (PRODUCT_REGISTRY[p.tradeableProductId]!.referenceInstrumentId !== AURUM_GOLD_INSTRUMENT_ID) return false;
  if (typeof p.accountId !== "string" || !ACCOUNT_ID_PATTERN.test(p.accountId) || isLegacyAccount(p.accountId)) return false;
  if (!p.roles || typeof p.roles !== "object") return false;
  // A role table can never smuggle in a second tradeable instrument.
  for (const role of Object.values(p.roles ?? {})) {
    if (!AURUM_INSTRUMENT_ROLES.includes(role) || (role as string) === "TRADEABLE") return false;
  }
  if (Object.prototype.hasOwnProperty.call(p.roles ?? {}, p.tradeableInstrumentId)) return false;
  return typeof p.active === "boolean";
}

/** Role of an instrument under the profile. Exact-match only; unknown, empty or Solana pair ids are DISABLED. */
export function aurumInstrumentRole(profile: AurumProfile, instrumentId: string | null | undefined): AurumInstrumentRole {
  if (!profileValid(profile) || typeof instrumentId !== "string") return "DISABLED";
  if (instrumentId === profile.tradeableInstrumentId) return "TRADEABLE";
  const role = Object.prototype.hasOwnProperty.call(profile.roles, instrumentId) ? profile.roles[instrumentId] : undefined;
  return role ?? "DISABLED";
}

/**
 * Default-deny order admission for AURUM. Only the configured gold product on the AURUM account can
 * pass. Opening actions additionally need the profile to be active. Exits and cancels on the gold
 * product stay available while inactive so a position can always be protected or closed.
 */
export function assessAurumOrderScope(input: {
  profile: AurumProfile;
  accountId: string;
  instrumentId: string | null | undefined;
  productId: string | null | undefined;
  action: string;
}): { allowed: true } | { allowed: false; reasons: AurumScopeReason[] } {
  const reasons: AurumScopeReason[] = [];
  const { profile } = input;
  if (!profileValid(profile)) return { allowed: false, reasons: ["INVALID_PROFILE"] };
  if (!(AURUM_ORDER_ACTIONS as readonly string[]).includes(input.action)) reasons.push("UNKNOWN_ACTION");
  if (isLegacyAccount(input.accountId)) {
    reasons.push("LEGACY_ACCOUNT_REFUSED");
  } else if (input.accountId !== profile.accountId) {
    reasons.push("ACCOUNT_NOT_AURUM");
  }
  if (aurumInstrumentRole(profile, input.instrumentId) !== "TRADEABLE") reasons.push("INSTRUMENT_NOT_TRADEABLE");
  if (input.productId !== profile.tradeableProductId) reasons.push("PRODUCT_NOT_TRADEABLE");
  if (!profile.active && (OPENING_ACTIONS as readonly string[]).includes(input.action)) reasons.push("AURUM_PROFILE_INACTIVE");
  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons };
}
