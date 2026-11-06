import { ACCOUNT_CURRENCY, Decimal, d, usd } from "./money.js";

/**
 * HORIZON quote-currency → USD conversion. Pure functions; nothing here is wired into fills or risk.
 *
 * Rules:
 * - USD amounts convert at 1.
 * - XXX amounts convert through an XXX/USD rate (USD per XXX = rate) or a USD/XXX rate (USD per XXX = 1/rate).
 * - Cross currencies with no direct USD leg are refused (`NO_CONVERSION_PATH`): no triangulation is invented.
 * - A missing, non-positive, future-dated or stale rate is refused with FX_RATE_UNAVAILABLE. There is no
 *   weekend exemption: a Friday-close rate read on Sunday is stale like any other old rate, so a JPY P&L
 *   cannot be valued in USD until a fresh USDJPY rate exists. Missing conversion is never zero P&L.
 */

export type FxRate = {
  /** ISO 4217 base currency of the pair (EUR in EUR/USD). */
  base: string;
  /** ISO 4217 quote currency of the pair (USD in EUR/USD). */
  quote: string;
  /** Mid rate as decimal text: units of `quote` per 1 `base`. */
  mid: string;
  /** When the rate was observed at the provider (ISO). */
  observedAt: string;
  /** Provider label for provenance. */
  source: string;
};

export type FxConversionRefusal =
  | "MISSING_RATE"
  | "NO_CONVERSION_PATH"
  | "NON_POSITIVE_RATE"
  | "STALE_RATE"
  | "FUTURE_DATED_RATE"
  | "INVALID_AMOUNT";

export type UsdConversion =
  | { ok: true; usdPerUnit: string; path: "IDENTITY" | "DIRECT" | "INVERSE"; rate: FxRate | null; rateAgeMs: number | null }
  | { ok: false; reason: "FX_RATE_UNAVAILABLE"; detail: FxConversionRefusal; currency: string };

export type FxPairKind = "USD_QUOTED" | "USD_BASED" | "CROSS" | "SAME_CURRENCY";

const CCY = /^[A-Z]{3}$/;

function norm(code: string): string {
  return code.trim().toUpperCase();
}

/** XXX/USD (USD_QUOTED), USD/XXX (USD_BASED), or CROSS (no USD leg). */
export function classifyFxPair(base: string, quote: string): FxPairKind {
  const b = norm(base);
  const q = norm(quote);
  if (b === q) return "SAME_CURRENCY";
  if (q === ACCOUNT_CURRENCY) return "USD_QUOTED";
  if (b === ACCOUNT_CURRENCY) return "USD_BASED";
  return "CROSS";
}

/**
 * Resolve USD per 1 unit of `currency` from the supplied rates. Prefers a direct XXX/USD rate, then the
 * inverse of USD/XXX. Refuses (never guesses) when no fresh, positive, direct USD leg exists.
 */
export function resolveUsdPerUnit(input: { currency: string; rates: readonly FxRate[]; now: Date; maxRateAgeMs: number }): UsdConversion {
  const currency = norm(input.currency);
  if (currency === ACCOUNT_CURRENCY) return { ok: true, usdPerUnit: "1", path: "IDENTITY", rate: null, rateAgeMs: null };
  if (!CCY.test(currency)) return { ok: false, reason: "FX_RATE_UNAVAILABLE", detail: "NO_CONVERSION_PATH", currency };

  const direct = freshest(input.rates.filter((r) => norm(r.base) === currency && norm(r.quote) === ACCOUNT_CURRENCY), input.now);
  const inverse = freshest(input.rates.filter((r) => norm(r.base) === ACCOUNT_CURRENCY && norm(r.quote) === currency), input.now);
  if (!direct && !inverse) {
    const anyLeg = input.rates.some((r) => norm(r.base) === currency || norm(r.quote) === currency);
    return { ok: false, reason: "FX_RATE_UNAVAILABLE", detail: anyLeg ? "NO_CONVERSION_PATH" : "MISSING_RATE", currency };
  }
  let firstRefusal: FxConversionRefusal | null = null;
  for (const [rate, path] of [
    [direct, "DIRECT"],
    [inverse, "INVERSE"],
  ] as const) {
    if (!rate) continue;
    const check = checkRate(rate, input.now, input.maxRateAgeMs);
    if (!check.ok) {
      firstRefusal ??= check.detail;
      continue;
    }
    const mid = new Decimal(rate.mid);
    const usdPerUnit = path === "DIRECT" ? mid : new Decimal(1).div(mid);
    return { ok: true, usdPerUnit: usdPerUnit.toSignificantDigits(20).toFixed(), path, rate, rateAgeMs: check.ageMs };
  }
  return { ok: false, reason: "FX_RATE_UNAVAILABLE", detail: firstRefusal ?? "MISSING_RATE", currency };
}

/** Latest observation not after `now` (no look-ahead); falls back to the first candidate so refusals stay specific. */
function freshest(candidates: readonly FxRate[], now: Date): FxRate | undefined {
  let best: FxRate | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const rate of candidates) {
    const ms = Date.parse(rate.observedAt);
    if (Number.isFinite(ms) && ms <= now.getTime() && ms > bestMs) {
      best = rate;
      bestMs = ms;
    }
  }
  return best ?? candidates[0];
}

function checkRate(rate: FxRate, now: Date, maxRateAgeMs: number): { ok: true; ageMs: number } | { ok: false; detail: FxConversionRefusal } {
  let mid: Decimal;
  try {
    mid = d(rate.mid);
  } catch {
    return { ok: false, detail: "MISSING_RATE" };
  }
  if (mid.lte(0)) return { ok: false, detail: "NON_POSITIVE_RATE" };
  const observed = Date.parse(rate.observedAt);
  if (!Number.isFinite(observed)) return { ok: false, detail: "MISSING_RATE" };
  const age = now.getTime() - observed;
  if (age < 0) return { ok: false, detail: "FUTURE_DATED_RATE" };
  if (!(maxRateAgeMs >= 0) || age > maxRateAgeMs) return { ok: false, detail: "STALE_RATE" };
  return { ok: true, ageMs: age };
}

/** Convert an amount in `currency` to USD (8 dp) using fresh rates, or refuse with FX_RATE_UNAVAILABLE. */
export function convertAmountToUsd(input: {
  amount: string;
  currency: string;
  rates: readonly FxRate[];
  now: Date;
  maxRateAgeMs: number;
}): { ok: true; amountUsd: string; conversion: Extract<UsdConversion, { ok: true }> } | Extract<UsdConversion, { ok: false }> {
  let amount: Decimal;
  try {
    amount = d(input.amount);
  } catch {
    return { ok: false, reason: "FX_RATE_UNAVAILABLE", detail: "INVALID_AMOUNT", currency: norm(input.currency) };
  }
  const conversion = resolveUsdPerUnit(input);
  if (!conversion.ok) return conversion;
  return { ok: true, amountUsd: usd(amount.mul(conversion.usdPerUnit)), conversion };
}

/**
 * Realised P&L of a pair position in USD. P&L accrues in the pair's quote currency
 * ((exit − entry) × qty × multiplier, sign by side) and is then converted at the CURRENT quote→USD rate.
 * For USD/JPY the P&L is in JPY and converts at the current USDJPY rate (USD per JPY = 1 / USDJPY).
 */
export function pairPnlUsd(input: {
  base: string;
  quote: string;
  side: "LONG" | "SHORT";
  qty: string;
  entryPrice: string;
  exitPrice: string;
  multiplier?: string;
  rates: readonly FxRate[];
  now: Date;
  maxRateAgeMs: number;
}):
  | { ok: true; pnlQuote: string; quoteCurrency: string; pnlUsd: string; conversion: Extract<UsdConversion, { ok: true }> }
  | Extract<UsdConversion, { ok: false }> {
  const quoteCurrency = norm(input.quote);
  let pnlQuote: Decimal;
  try {
    const move = d(input.exitPrice).minus(d(input.entryPrice));
    pnlQuote = move.mul(d(input.qty)).mul(d(input.multiplier ?? "1")).mul(input.side === "LONG" ? 1 : -1);
  } catch {
    return { ok: false, reason: "FX_RATE_UNAVAILABLE", detail: "INVALID_AMOUNT", currency: quoteCurrency };
  }
  const conversion = resolveUsdPerUnit({ currency: quoteCurrency, rates: input.rates, now: input.now, maxRateAgeMs: input.maxRateAgeMs });
  if (!conversion.ok) return conversion;
  return {
    ok: true,
    pnlQuote: pnlQuote.toFixed(),
    quoteCurrency,
    pnlUsd: usd(pnlQuote.mul(conversion.usdPerUnit)),
    conversion,
  };
}
