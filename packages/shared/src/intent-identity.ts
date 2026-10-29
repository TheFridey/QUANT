import { createHash } from "node:crypto";
import { canonicalJson } from "./ids.js";

/**
 * Canonical trade intent identity (Stages 2–4).
 *
 * One TradeIntent row per independent economic intent. The idempotency key is
 * deterministic: a retry of the same intent (same cycle, owner, instrument,
 * action) maps to the same key and therefore the same clientOrderId, while two
 * owners acting on the same symbol in the same cycle never collide.
 */

export const TRADE_INTENT_SOURCES = [
  "STRATEGY",
  "OPERATOR",
  "PROTECTION",
  "ACCOUNT_FLATTEN",
  "NET_CLOSE",
  "RECOVERY",
] as const;
export type TradeIntentSource = (typeof TRADE_INTENT_SOURCES)[number];

export const TRADE_INTENT_ACTIONS = ["ENTER", "EXIT", "REDUCE", "CLOSE_NET", "FLATTEN"] as const;
export type TradeIntentAction = (typeof TRADE_INTENT_ACTIONS)[number];

export const TRADE_INTENT_STATUSES = [
  "PROPOSED",
  "DEFERRED",
  "REJECTED",
  "ADMITTED",
  "SUBMITTED",
  "PENDING",
  "FILLED",
  "PARTIALLY_FILLED",
  "CANCELLED",
  "EXPIRED",
  "UNKNOWN",
] as const;
export type TradeIntentStatus = (typeof TRADE_INTENT_STATUSES)[number];

/** Order.ownerScope — who owns the economic consequence of a fill. */
export const ORDER_OWNER_SCOPES = [
  "STRATEGY",
  "OPERATOR",
  "PROTECTION",
  "ACCOUNT_FLATTEN",
  "NET_CLOSE",
  "LEGACY",
] as const;
export type OrderOwnerScope = (typeof ORDER_OWNER_SCOPES)[number];

/** Bucket id for quantity that cannot be attributed to a strategy. Never reported as strategy performance. */
export const UNATTRIBUTED_INSTANCE_ID = "stratinst_unattributed";

/** Bucket id for operator-ticket BUYs (manual ownership). Not strategy performance. */
export const MANUAL_INSTANCE_ID = "stratinst_manual";

export type IntentIdentityParts = {
  cycleId: string;
  accountId: string;
  source: TradeIntentSource;
  /** Strategy instance for STRATEGY intents; operator intent id / protection leg id / flatten request id otherwise. */
  ownerRef: string;
  pairAddress: string;
  action: TradeIntentAction;
};

export function intentIdempotencyKey(parts: IntentIdentityParts): string {
  return canonicalJson({
    v: 1,
    cycleId: parts.cycleId,
    accountId: parts.accountId,
    source: parts.source,
    ownerRef: parts.ownerRef,
    pairAddress: parts.pairAddress,
    action: parts.action,
  });
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Buffer, chars: number): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

function digest(key: string, chars: number): string {
  return base32(createHash("sha256").update(key).digest(), chars);
}

export function intentIdFor(idempotencyKey: string): string {
  return `int_${digest(idempotencyKey, 26)}`;
}

/**
 * Broker-safe client order id: lowercase [a-z2-7] + "q1-" prefix, 29 chars.
 * Fits Alpaca (≤128) and OANDA clientExtensions (≤128) limits; 130 bits of hash
 * makes accidental collision negligible. TradeIntent.clientOrderId persists the
 * mapping, so the original identity is always recoverable from the DB.
 */
export function clientOrderIdFor(idempotencyKey: string): string {
  return `q1-${digest(idempotencyKey, 26)}`;
}

export const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Stable hash of a strategy configuration for provenance (canonical serialization). */
export function configHashOf(config: unknown): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}
