import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const USD_DP = 8;
export const QTY_DP = 8;
export const ACCOUNT_CURRENCY = "USD" as const;

export function d(value: string | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("MONEY_STRING_REQUIRED");
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error("NON_FINITE_MONEY");
  return parsed;
}

export function usd(value: Decimal): string {
  return value.toDecimalPlaces(USD_DP, Decimal.ROUND_HALF_UP).toFixed(USD_DP);
}

export function qty(value: Decimal): string {
  return value.toDecimalPlaces(QTY_DP, Decimal.ROUND_DOWN).toFixed(QTY_DP);
}

export function price(value: Decimal): string {
  return value.toDecimalPlaces(USD_DP, Decimal.ROUND_HALF_UP).toFixed(USD_DP);
}

export function bps(value: Decimal): string {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

export function confidenceFixed(value: Decimal): string {
  return Decimal.max(0, Decimal.min(1, value)).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

export function sumUsd(values: string[]): string {
  return usd(values.reduce((total, value) => total.plus(d(value)), new Decimal(0)));
}

/**
 * Convert an amount in `fromCurrency` to account USD using an explicit rate
 * (units of USD per 1 unit of fromCurrency). Missing/non-positive rates fail closed.
 */
export function convertToUsd(input: {
  amount: string;
  fromCurrency: string;
  /** USD per 1 unit of fromCurrency. Required when fromCurrency !== USD. */
  usdPerUnit: string | null;
}): { ok: true; amountUsd: string } | { ok: false; reason: "FX_RATE_UNAVAILABLE" } {
  const currency = input.fromCurrency.trim().toUpperCase();
  if (currency === ACCOUNT_CURRENCY || currency === "") {
    return { ok: true, amountUsd: usd(d(input.amount)) };
  }
  if (input.usdPerUnit === null || d(input.usdPerUnit).lte(0)) {
    return { ok: false, reason: "FX_RATE_UNAVAILABLE" };
  }
  return { ok: true, amountUsd: usd(d(input.amount).mul(d(input.usdPerUnit))) };
}

/** Haircut multiplier for fees + slippage so min-order headroom checks stay conservative. */
export function costHaircutMultiplier(feeBps: string, maxSlippageBps: string): Decimal {
  return d("1").plus(d(feeBps).div(10000)).mul(d("1").plus(d(maxSlippageBps).div(10000)));
}

/**
 * Max position notional at configured starting equity, after fee/slippage haircut.
 * Used to reject configs where min order already exceeds the risk cap at day one.
 */
export function maxPositionNotionalAtStart(input: {
  startingBalanceUsd: string;
  maxPositionPctEquity: string;
  feeBps: string;
  maxSlippageBps: string;
}): string {
  const gross = d(input.startingBalanceUsd).mul(d(input.maxPositionPctEquity)).div(100);
  return usd(gross.div(costHaircutMultiplier(input.feeBps, input.maxSlippageBps)));
}

export { Decimal };
