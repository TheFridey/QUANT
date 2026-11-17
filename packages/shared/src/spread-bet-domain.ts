import Decimal from "decimal.js";

// Isolated arithmetic context: do not inherit mutable legacy Decimal settings.
// 80 significant digits cover exact products of two 24-digit inputs and retain
// headroom for division by an eight-decimal point size before penny booking.
export const SpreadDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

/** Proposed C3 prices use Decimal(24,8); this is a representation ceiling,
 * not an approved account balance or an economic risk limit. */
export function spreadDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:e([+-]?\d{1,2}))?$/i.exec(value);
  if (!match || (match[2] !== undefined && Math.abs(Number(match[2])) > 24)) return null;
  try {
    const v = new SpreadDecimal(value);
    return v.isFinite() && v.abs().lt("1e16") && v.decimalPlaces() <= 8 ? v : null;
  } catch {
    return null;
  }
}

/** C3 proposed booked GBP amounts: Decimal(24,2), checked before rounding too. */
export function bookedAmountFits(value: Decimal): boolean {
  return value.isFinite() && value.abs().lt("1e22");
}
