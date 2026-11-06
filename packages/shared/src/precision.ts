import { Decimal, d } from "./money.js";
import type { Instrument } from "./instruments.js";

/**
 * HORIZON instrument precision helpers: tick/lot rounding and contract multipliers from the instrument
 * registry. Pure functions; nothing here is wired into fills (that needs PCR-2 on the protected
 * trading-engine paths).
 */

export type PriceRounding = "NEAREST" | "DOWN" | "UP";

export type PrecisionRefusal = "INVALID_TICK_SIZE" | "INVALID_LOT_SIZE" | "INVALID_PRICE" | "INVALID_QTY" | "NON_POSITIVE_QTY" | "BELOW_MINIMUM_QTY";

function positive(value: string): Decimal | null {
  try {
    const n = d(value);
    return n.gt(0) ? n : null;
  } catch {
    return null;
  }
}

/** Number of decimal places implied by a step such as "0.00001" (5) or "0.25" (2). */
export function stepDecimals(step: string): number {
  return Math.max(0, d(step).decimalPlaces());
}

/**
 * Round a price to a whole number of ticks. NEAREST rounds half away from zero; DOWN/UP floor/ceil toward
 * −∞/+∞ (use DOWN for a sell limit you must not overstate, UP for a buy cost you must not understate).
 */
export function roundPriceToTick(
  price: string,
  tickSize: string,
  mode: PriceRounding = "NEAREST",
): { ok: true; price: string } | { ok: false; reason: PrecisionRefusal } {
  const tick = positive(tickSize);
  if (!tick) return { ok: false, reason: "INVALID_TICK_SIZE" };
  const p = positive(price);
  if (!p) return { ok: false, reason: "INVALID_PRICE" };
  const ticks = p.div(tick);
  const rounding = mode === "DOWN" ? Decimal.ROUND_FLOOR : mode === "UP" ? Decimal.ROUND_CEIL : Decimal.ROUND_HALF_UP;
  const whole = ticks.toDecimalPlaces(0, rounding);
  const rounded = whole.mul(tick);
  // A positive price must never round to zero.
  if (rounded.lte(0)) return { ok: false, reason: "INVALID_PRICE" };
  return { ok: true, price: rounded.toFixed(stepDecimals(tickSize)) };
}

/**
 * Round a quantity DOWN to a whole number of lots (never up: rounding must not enlarge risk) and refuse
 * results below the minimum (default: one lot).
 */
export function roundQtyToLot(
  qty: string,
  lotSize: string,
  minQty?: string,
): { ok: true; qty: string; lots: string } | { ok: false; reason: PrecisionRefusal } {
  const lot = positive(lotSize);
  if (!lot) return { ok: false, reason: "INVALID_LOT_SIZE" };
  let q: Decimal;
  try {
    q = d(qty);
  } catch {
    return { ok: false, reason: "INVALID_QTY" };
  }
  if (q.lte(0)) return { ok: false, reason: "NON_POSITIVE_QTY" };
  const lots = q.div(lot).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const rounded = lots.mul(lot);
  const minimum = minQty !== undefined ? positive(minQty) : lot;
  if (minQty !== undefined && !minimum) return { ok: false, reason: "INVALID_LOT_SIZE" };
  if (rounded.lt(minimum!) || rounded.lte(0)) return { ok: false, reason: "BELOW_MINIMUM_QTY" };
  return { ok: true, qty: rounded.toFixed(stepDecimals(lotSize)), lots: lots.toFixed(0) };
}

/**
 * Contract multipliers by instrument id. Every current registry instrument is a spot or spot-proxy unit
 * (the registry notes say multiplier=1; CL futures contract size is deliberately not modelled), so the
 * default is 1. An explicit override map lets research model a real contract without editing the registry.
 */
export function contractMultiplier(instrument: Pick<Instrument, "id">, overrides: Readonly<Record<string, string>> = {}): string {
  const override = overrides[instrument.id];
  if (override !== undefined) {
    const m = positive(override);
    if (!m) throw new Error(`INVALID_CONTRACT_MULTIPLIER:${instrument.id}`);
    return m.toFixed();
  }
  return "1";
}

/** Notional in the instrument's quote currency: qty × price × multiplier (unrounded decimal text). */
export function notionalInQuote(input: { qty: string; price: string; multiplier?: string }): string {
  return d(input.qty).mul(d(input.price)).mul(d(input.multiplier ?? "1")).toFixed();
}

/** Registry precision for an instrument, as one record. */
export function instrumentPrecision(instrument: Pick<Instrument, "id" | "tickSize" | "lotSize">, overrides: Readonly<Record<string, string>> = {}) {
  return {
    tickSize: instrument.tickSize,
    lotSize: instrument.lotSize,
    priceDecimals: stepDecimals(instrument.tickSize),
    qtyDecimals: stepDecimals(instrument.lotSize),
    minQty: instrument.lotSize,
    multiplier: contractMultiplier(instrument, overrides),
  };
}
