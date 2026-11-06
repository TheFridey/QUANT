import { describe, expect, it } from "vitest";
import { classifyFxPair, convertAmountToUsd, pairPnlUsd, resolveUsdPerUnit, type FxRate } from "./fx-conversion.js";

const NOW = new Date("2026-11-04T15:00:00.000Z"); // Wednesday
const MAX_AGE = 5 * 60_000;

function rate(base: string, quote: string, mid: string, ageMs = 1_000): FxRate {
  return { base, quote, mid, observedAt: new Date(NOW.getTime() - ageMs).toISOString(), source: "test" };
}

describe("classifyFxPair", () => {
  it("labels USD-quoted, USD-based, cross and same-currency pairs", () => {
    expect(classifyFxPair("EUR", "USD")).toBe("USD_QUOTED");
    expect(classifyFxPair("usd", "jpy")).toBe("USD_BASED");
    expect(classifyFxPair("EUR", "GBP")).toBe("CROSS");
    expect(classifyFxPair("USD", "USD")).toBe("SAME_CURRENCY");
  });
});

describe("resolveUsdPerUnit", () => {
  it("returns 1 for USD without any rate", () => {
    expect(resolveUsdPerUnit({ currency: "USD", rates: [], now: NOW, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: true, usdPerUnit: "1", path: "IDENTITY" });
  });

  it("uses XXX/USD directly", () => {
    const r = resolveUsdPerUnit({ currency: "EUR", rates: [rate("EUR", "USD", "1.08")], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, usdPerUnit: "1.08", path: "DIRECT" });
  });

  it("inverts USD/XXX (JPY via USDJPY)", () => {
    const r = resolveUsdPerUnit({ currency: "JPY", rates: [rate("USD", "JPY", "150")], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe("INVERSE");
      expect(Number(r.usdPerUnit)).toBeCloseTo(1 / 150, 15);
    }
  });

  it("refuses a missing rate with FX_RATE_UNAVAILABLE", () => {
    expect(resolveUsdPerUnit({ currency: "JPY", rates: [], now: NOW, maxRateAgeMs: MAX_AGE })).toEqual({
      ok: false,
      reason: "FX_RATE_UNAVAILABLE",
      detail: "MISSING_RATE",
      currency: "JPY",
    });
  });

  it("refuses a cross with no direct USD leg (no triangulation is invented)", () => {
    const r = resolveUsdPerUnit({ currency: "CHF", rates: [rate("EUR", "CHF", "0.94"), rate("EUR", "USD", "1.08")], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: false, reason: "FX_RATE_UNAVAILABLE", detail: "NO_CONVERSION_PATH" });
  });

  it("refuses stale, future-dated and non-positive rates", () => {
    expect(resolveUsdPerUnit({ currency: "JPY", rates: [rate("USD", "JPY", "150", MAX_AGE + 1)], now: NOW, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: false, detail: "STALE_RATE" });
    expect(resolveUsdPerUnit({ currency: "JPY", rates: [rate("USD", "JPY", "150", -1)], now: NOW, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: false, detail: "FUTURE_DATED_RATE" });
    expect(resolveUsdPerUnit({ currency: "JPY", rates: [rate("USD", "JPY", "0")], now: NOW, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: false, detail: "NON_POSITIVE_RATE" });
    expect(resolveUsdPerUnit({ currency: "JPY", rates: [rate("USD", "JPY", "abc")], now: NOW, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: false, detail: "MISSING_RATE" });
  });

  it("accepts a rate exactly at the age limit and refuses one ms past it", () => {
    expect(resolveUsdPerUnit({ currency: "EUR", rates: [rate("EUR", "USD", "1.1", MAX_AGE)], now: NOW, maxRateAgeMs: MAX_AGE }).ok).toBe(true);
    expect(resolveUsdPerUnit({ currency: "EUR", rates: [rate("EUR", "USD", "1.1", MAX_AGE + 1)], now: NOW, maxRateAgeMs: MAX_AGE }).ok).toBe(false);
  });

  it("falls back to a fresh inverse rate when the direct one is stale", () => {
    const r = resolveUsdPerUnit({ currency: "EUR", rates: [rate("EUR", "USD", "1.08", MAX_AGE * 10), rate("USD", "EUR", "0.925")], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, path: "INVERSE" });
  });

  it("uses the freshest duplicate rate and never one observed after now", () => {
    const r = resolveUsdPerUnit({ currency: "EUR", rates: [rate("EUR", "USD", "1.00", MAX_AGE * 10), rate("EUR", "USD", "1.10"), rate("EUR", "USD", "9.99", -60_000)], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, usdPerUnit: "1.1", path: "DIRECT" });
  });

  it("has no weekend exemption: a Friday-close USDJPY rate read on Sunday is stale", () => {
    const fridayClose = { base: "USD", quote: "JPY", mid: "150", observedAt: "2026-11-06T21:59:00.000Z", source: "test" };
    const sunday = new Date("2026-11-08T12:00:00.000Z");
    expect(resolveUsdPerUnit({ currency: "JPY", rates: [fridayClose], now: sunday, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: false, detail: "STALE_RATE" });
  });
});

describe("convertAmountToUsd", () => {
  it("converts 15,000 JPY at USDJPY 150 to 100 USD", () => {
    const r = convertAmountToUsd({ amount: "15000", currency: "JPY", rates: [rate("USD", "JPY", "150")], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, amountUsd: "100.00000000" });
  });

  it("refuses an unparseable amount", () => {
    expect(convertAmountToUsd({ amount: "", currency: "USD", rates: [], now: NOW, maxRateAgeMs: MAX_AGE })).toMatchObject({ ok: false, detail: "INVALID_AMOUNT" });
  });
});

describe("pairPnlUsd", () => {
  it("USD/JPY long: P&L accrues in JPY and converts at the current USDJPY rate", () => {
    // Long 10,000 USD at 150.000, exit 151.500: +15,000 JPY; at the current 151.5 that is 99.0099... USD.
    const r = pairPnlUsd({
      base: "USD",
      quote: "JPY",
      side: "LONG",
      qty: "10000",
      entryPrice: "150.000",
      exitPrice: "151.500",
      rates: [rate("USD", "JPY", "151.5")],
      now: NOW,
      maxRateAgeMs: MAX_AGE,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quoteCurrency).toBe("JPY");
      expect(r.pnlQuote).toBe("15000");
      expect(r.pnlUsd).toBe("99.00990099");
      // Never booked as 15,000 "USD" (the bug the diagnosis warned about).
      expect(Number(r.pnlUsd)).toBeLessThan(100);
    }
  });

  it("USD/JPY short loses when the rate rises", () => {
    const r = pairPnlUsd({ base: "USD", quote: "JPY", side: "SHORT", qty: "1000", entryPrice: "150", exitPrice: "151", rates: [rate("USD", "JPY", "151")], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, pnlQuote: "-1000", pnlUsd: "-6.62251656" });
  });

  it("EUR/USD needs no conversion rate", () => {
    const r = pairPnlUsd({ base: "EUR", quote: "USD", side: "LONG", qty: "1000", entryPrice: "1.08000", exitPrice: "1.08250", rates: [], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, pnlUsd: "2.50000000", conversion: { path: "IDENTITY" } });
  });

  it("refuses USD/JPY P&L when the USDJPY rate is stale or missing", () => {
    const base = { base: "USD", quote: "JPY", side: "LONG" as const, qty: "1", entryPrice: "150", exitPrice: "151", now: NOW, maxRateAgeMs: MAX_AGE };
    expect(pairPnlUsd({ ...base, rates: [rate("USD", "JPY", "151", MAX_AGE * 2)] })).toMatchObject({ ok: false, reason: "FX_RATE_UNAVAILABLE", detail: "STALE_RATE" });
    expect(pairPnlUsd({ ...base, rates: [] })).toMatchObject({ ok: false, reason: "FX_RATE_UNAVAILABLE", detail: "MISSING_RATE" });
  });

  it("EUR/GBP cross converts only when a GBP/USD leg exists", () => {
    const base = { base: "EUR", quote: "GBP", side: "LONG" as const, qty: "1000", entryPrice: "0.8500", exitPrice: "0.8600", now: NOW, maxRateAgeMs: MAX_AGE };
    expect(pairPnlUsd({ ...base, rates: [rate("EUR", "USD", "1.08")] })).toMatchObject({ ok: false, detail: "MISSING_RATE" });
    expect(pairPnlUsd({ ...base, rates: [rate("GBP", "USD", "1.25")] })).toMatchObject({ ok: true, pnlUsd: "12.50000000" });
  });

  it("applies a contract multiplier", () => {
    const r = pairPnlUsd({ base: "WTI", quote: "USD", side: "LONG", qty: "2", entryPrice: "70", exitPrice: "71", multiplier: "1000", rates: [], now: NOW, maxRateAgeMs: MAX_AGE });
    expect(r).toMatchObject({ ok: true, pnlUsd: "2000.00000000" });
  });
});
