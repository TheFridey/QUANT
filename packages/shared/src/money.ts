import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const USD_DP = 8;
export const QTY_DP = 8;

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

export { Decimal };
