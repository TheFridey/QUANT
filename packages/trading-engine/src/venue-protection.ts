import type { ProtectionOrigin } from "./protection.js";

/**
 * Venue-native protection (Alpaca bracket / OANDA stop-loss orders).
 * Desired state is local intent; ack state is only updated from broker responses.
 * Never invent ACK success without a venue payload.
 */

export type VenueProtectionCapability = {
  providerId: "alpaca_paper" | "oanda_practice";
  /** Whether docs/API support native stop / take-profit / OCO-style brackets. */
  supportsNativeStop: boolean;
  supportsNativeTakeProfit: boolean;
  supportsNativeOco: boolean;
  /** Doc reference for operators. */
  docsUrl: string;
  notes: string;
};

export type ProtectionAckState =
  | "DESIRED_ONLY"
  | "SUBMITTED"
  | "ACKED"
  | "REJECTED"
  | "CANCELLED"
  | "UNKNOWN";

export type VenueProtectionDesire = {
  id: string;
  providerId: "alpaca_paper" | "oanda_practice";
  instrumentId: string;
  origin: ProtectionOrigin;
  stopPrice: string | null;
  takeProfitPrice: string | null;
  qty: string;
  /** Last successfully confirmed (acked) stop — retained on amendment failure. */
  lastConfirmedStopPrice: string | null;
  lastConfirmedTakeProfitPrice: string | null;
  ackState: ProtectionAckState;
  venueOrderId: string | null;
  lastError: string | null;
};

export const ALPACA_BRACKET_CAPABILITY: VenueProtectionCapability = {
  providerId: "alpaca_paper",
  supportsNativeStop: true,
  supportsNativeTakeProfit: true,
  supportsNativeOco: true,
  docsUrl: "https://docs.alpaca.markets/docs/trading-api#bracket-orders",
  notes:
    "Alpaca paper supports bracket (entry + take-profit + stop-loss) and OCO. Desired≠acked until broker ACK.",
};

export const OANDA_STOP_CAPABILITY: VenueProtectionCapability = {
  providerId: "oanda_practice",
  supportsNativeStop: true,
  supportsNativeTakeProfit: true,
  supportsNativeOco: false,
  docsUrl: "https://developer.oanda.com/rest-live-v20/order-ep/",
  notes:
    "OANDA practice supports STOP_LOSS / TAKE_PROFIT orders attached to trades. No single OCO endpoint — engine tracks desired vs ack per leg.",
};

export function venueProtectionCapability(
  providerId: "alpaca_paper" | "oanda_practice",
): VenueProtectionCapability {
  return providerId === "alpaca_paper" ? ALPACA_BRACKET_CAPABILITY : OANDA_STOP_CAPABILITY;
}

/** Create a local desired-only protection record (not yet submitted). */
export function desireVenueProtection(input: {
  id: string;
  providerId: "alpaca_paper" | "oanda_practice";
  instrumentId: string;
  stopPrice: string | null;
  takeProfitPrice: string | null;
  qty: string;
}): VenueProtectionDesire {
  const cap = venueProtectionCapability(input.providerId);
  if (!cap.supportsNativeStop && input.stopPrice) {
    throw new Error(`${input.providerId} does not support native stops`);
  }
  return {
    id: input.id,
    providerId: input.providerId,
    instrumentId: input.instrumentId,
    origin: "VENUE_NATIVE",
    stopPrice: input.stopPrice,
    takeProfitPrice: input.takeProfitPrice,
    qty: input.qty,
    lastConfirmedStopPrice: null,
    lastConfirmedTakeProfitPrice: null,
    ackState: "DESIRED_ONLY",
    venueOrderId: null,
    lastError: null,
  };
}

/**
 * Apply venue ACK. Only transitions DESIRED_ONLY/SUBMITTED → ACKED with venue ids.
 * Rejects invented success: missing venueOrderId → REJECTED.
 */
export function applyVenueProtectionAck(
  desire: VenueProtectionDesire,
  response:
    | { ok: true; venueOrderId: string; stopPrice?: string | null; takeProfitPrice?: string | null }
    | { ok: false; error: string },
): VenueProtectionDesire {
  if (!response.ok) {
    return {
      ...desire,
      ackState: "REJECTED",
      lastError: response.error,
      // Keep last confirmed protection prices — amendment/submit failure must not wipe them.
    };
  }
  if (!response.venueOrderId) {
    return {
      ...desire,
      ackState: "REJECTED",
      lastError: "MISSING_VENUE_ORDER_ID",
    };
  }
  const confirmedStop = response.stopPrice ?? desire.stopPrice;
  const confirmedTp = response.takeProfitPrice ?? desire.takeProfitPrice;
  return {
    ...desire,
    ackState: "ACKED",
    venueOrderId: response.venueOrderId,
    lastError: null,
    lastConfirmedStopPrice: confirmedStop,
    lastConfirmedTakeProfitPrice: confirmedTp,
    stopPrice: confirmedStop,
    takeProfitPrice: confirmedTp,
  };
}

/**
 * Attempt amendment of stop/TP. On failure, restore last confirmed prices and leave ACKED
 * (or prior ack) — never clear confirmed protection because amend failed.
 */
export function amendVenueProtectionDesire(
  desire: VenueProtectionDesire,
  next: { stopPrice?: string | null; takeProfitPrice?: string | null },
  outcome: { ok: true; venueOrderId?: string } | { ok: false; error: string },
): VenueProtectionDesire {
  if (!outcome.ok) {
    return {
      ...desire,
      stopPrice: desire.lastConfirmedStopPrice ?? desire.stopPrice,
      takeProfitPrice: desire.lastConfirmedTakeProfitPrice ?? desire.takeProfitPrice,
      lastError: outcome.error,
      // Stay on prior ack when we still have confirmed protection.
      ackState:
        desire.lastConfirmedStopPrice || desire.lastConfirmedTakeProfitPrice
          ? desire.ackState === "DESIRED_ONLY"
            ? "DESIRED_ONLY"
            : "ACKED"
          : "REJECTED",
    };
  }
  const stop = next.stopPrice !== undefined ? next.stopPrice : desire.stopPrice;
  const tp = next.takeProfitPrice !== undefined ? next.takeProfitPrice : desire.takeProfitPrice;
  return {
    ...desire,
    stopPrice: stop,
    takeProfitPrice: tp,
    lastConfirmedStopPrice: stop,
    lastConfirmedTakeProfitPrice: tp,
    venueOrderId: outcome.venueOrderId ?? desire.venueOrderId,
    ackState: "ACKED",
    lastError: null,
  };
}

/** Mark submitted (in-flight) without inventing ACK. */
export function markVenueProtectionSubmitted(desire: VenueProtectionDesire): VenueProtectionDesire {
  return { ...desire, ackState: "SUBMITTED", lastError: null };
}

/**
 * Build Alpaca bracket order body fields from desired protection.
 * Caller must only POST when readiness=READY; this never claims success.
 */
export function alpacaBracketOrderFields(desire: VenueProtectionDesire): {
  order_class: "bracket";
  take_profit: { limit_price: string } | undefined;
  stop_loss: { stop_price: string } | undefined;
} {
  return {
    order_class: "bracket",
    take_profit: desire.takeProfitPrice ? { limit_price: desire.takeProfitPrice } : undefined,
    stop_loss: desire.stopPrice ? { stop_price: desire.stopPrice } : undefined,
  };
}

/**
 * Build OANDA protective order specs (stop loss / take profit) for a trade.
 * Separate orders — not a single OCO. Desired until practice API acks.
 */
export function oandaProtectiveOrderSpecs(desire: VenueProtectionDesire): Array<{
  type: "STOP_LOSS" | "TAKE_PROFIT";
  price: string;
}> {
  const specs: Array<{ type: "STOP_LOSS" | "TAKE_PROFIT"; price: string }> = [];
  if (desire.stopPrice) specs.push({ type: "STOP_LOSS", price: desire.stopPrice });
  if (desire.takeProfitPrice) specs.push({ type: "TAKE_PROFIT", price: desire.takeProfitPrice });
  return specs;
}
