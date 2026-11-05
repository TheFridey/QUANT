import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OANDA_REGISTRY_MAP,
  OandaPracticeMarketData,
  normaliseOandaTime,
  oandaAvailability,
  oandaPrecision,
  parseOandaCandles,
  parseOandaInstruments,
  parseOandaPricing,
  type OandaPracticeCredentials,
} from "./oanda-practice.js";
import { AlpacaMarketData, AlpacaPaperProvider, parseAlpacaLatestQuotes, type AlpacaPaperCredentials } from "./alpaca-paper.js";
import { FrankfurterFxProvider } from "./frankfurter-fx.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(here, "../../fixtures", name), "utf8"));
const NOW = new Date("2026-11-04T15:00:00.000Z");

const OANDA_CREDS: OandaPracticeCredentials = { tokenPresent: true, accountIdPresent: true, apiUrl: "https://api-fxpractice.oanda.com", accountId: "101-004-1234567-001" };
const ALPACA_CREDS: AlpacaPaperCredentials = { apiKeyPresent: true, apiSecretPresent: true, baseUrl: "https://paper-api.alpaca.markets", dataUrl: "https://data.alpaca.markets" };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Call = { url: URL; init: RequestInit };
function recorder(respond: (url: URL) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return respond(url);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("OANDA practice: parsing", () => {
  it("trims nanosecond timestamps to ms and rejects junk", () => {
    expect(normaliseOandaTime("2026-11-04T14:59:58.912345678Z")).toBe("2026-11-04T14:59:58.912Z");
    expect(normaliseOandaTime("2026-11-04T14:59:58Z")).toBe("2026-11-04T14:59:58.000Z");
    expect(normaliseOandaTime("1730732398.912345678")).toBeNull();
  });

  it("parses instrument precision and drops rows missing precision fields", () => {
    const specs = parseOandaInstruments(fixture("oanda-practice/instruments-no-metals.json"))!;
    expect(specs.map((s) => s.name)).toEqual(["EUR_USD", "GBP_USD", "USD_JPY"]);
    expect(specs[2]).toEqual({ name: "USD_JPY", type: "CURRENCY", displayName: "USD/JPY", displayPrecision: 3, pipLocation: -2, tradeUnitsPrecision: 0, minimumTradeSize: "1", marginRate: "0.02" });
    expect(oandaPrecision(specs[0]!)).toEqual({ tickSize: "0.00001", pipSize: "0.0001", unitStep: "1" });
    expect(oandaPrecision(specs[2]!)).toEqual({ tickSize: "0.001", pipSize: "0.01", unitStep: "1" });
    expect(parseOandaInstruments({})).toBeNull();
  });

  it("says plainly when XAU_USD is not available on this account", () => {
    const specs = parseOandaInstruments(fixture("oanda-practice/instruments-no-metals.json"))!;
    const availability = oandaAvailability(specs, ["EUR_USD", "XAU_USD"]);
    expect(availability[0]).toMatchObject({ instrument: "EUR_USD", available: true, reason: null });
    expect(availability[1]).toEqual({ instrument: "XAU_USD", available: false, reason: "XAU_USD not available on this account", spec: null });
    const gold = oandaAvailability(parseOandaInstruments(fixture("oanda-practice/instruments-with-gold.json"))!, ["XAU_USD"]);
    expect(gold[0]).toMatchObject({ available: true, spec: { type: "METAL", displayPrecision: 3, marginRate: "0.05" } });
  });

  it("parses pricing with bid/ask/time/tradeable/spread and never invents a missing side", () => {
    const prices = parseOandaPricing(fixture("oanda-practice/pricing.json"), NOW)!;
    const eur = prices.find((p) => p.instrument === "EUR_USD")!;
    expect(eur).toMatchObject({ time: "2026-11-04T14:59:58.912Z", bid: "1.08201", ask: "1.08215", mid: "1.08208000", spread: "0.00014", tradeable: true, bidLiquidity: 1000000, closeoutBid: "1.08196" });
    expect(eur.quality).toMatchObject({ feed: "OANDA_PRACTICE", coverage: "DEALER_INDICATIVE", timeliness: "REAL_TIME", quoteAgeMs: 1088, providerTradeable: true });
    const gbp = prices.find((p) => p.instrument === "GBP_USD")!;
    expect(gbp).toMatchObject({ bid: "1.29010", ask: null, mid: null, spread: null, tradeable: false });
    expect(gbp.quality.twoSided).toBe(false);
  });

  it("parses MBA candles with the complete flag, bid/ask/mid and close time", () => {
    const candles = parseOandaCandles(fixture("oanda-practice/candles-eurusd-m5-mba.json"), "M5")!;
    expect(candles).toHaveLength(4);
    expect(candles[0]).toMatchObject({ openTime: Date.parse("2026-11-04T14:40:00Z"), closeTime: Date.parse("2026-11-04T14:45:00Z"), complete: true, tickVolume: 132, bid: { c: "1.08180" }, ask: { c: "1.08194" }, mid: { c: "1.08187" } });
    expect(candles[3]!.complete).toBe(false);
  });
});

describe("OANDA practice: read-only client", () => {
  it("refuses without credentials and never calls the network", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}));
    const client = new OandaPracticeMarketData({ tokenPresent: false, accountIdPresent: false, apiUrl: "https://api-fxpractice.oanda.com", accountId: "" }, { fetchImpl });
    expect(await client.availability()).toMatchObject({ ok: false, code: "MISSING_CREDENTIALS" });
    expect(await client.pricing(["EUR_USD"])).toMatchObject({ ok: false, code: "MISSING_CREDENTIALS" });
    expect(calls).toHaveLength(0);
  });

  it("refuses the live host, loopback and malformed account ids", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}));
    for (const apiUrl of ["https://api-fxtrade.oanda.com", "http://127.0.0.1", "https://api-fxpractice.oanda.com.evil.test"]) {
      expect(await new OandaPracticeMarketData({ ...OANDA_CREDS, apiUrl }, { fetchImpl }).pricing(["EUR_USD"])).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION" });
    }
    expect(await new OandaPracticeMarketData({ ...OANDA_CREDS, accountId: "../orders" }, { fetchImpl }).pricing(["EUR_USD"])).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION" });
    expect(calls).toHaveLength(0);
  });

  it("uses GET only, sends the token as a header, and maps registry instruments", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.pathname.endsWith("/instruments") ? jsonResponse(fixture("oanda-practice/instruments-no-metals.json")) : jsonResponse(fixture("oanda-practice/pricing.json")),
    );
    const client = new OandaPracticeMarketData(OANDA_CREDS, { fetchImpl, now: () => NOW, token: () => "tok-123" });
    const availability = await client.availability();
    expect(availability.ok).toBe(true);
    if (availability.ok) {
      expect(availability.data.map((a) => [a.instrument, a.available])).toEqual(Object.values(OANDA_REGISTRY_MAP).map((name) => [name, !["XAU_USD", "WTICO_USD"].includes(name)]));
    }
    const pricing = await client.pricing(["EUR_USD", "USD_JPY"]);
    expect(pricing.ok).toBe(true);
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "GET"]);
    expect(calls[0]!.url.toString()).toBe("https://api-fxpractice.oanda.com/v3/accounts/101-004-1234567-001/instruments");
    expect(calls[1]!.url.searchParams.get("instruments")).toBe("EUR_USD,USD_JPY");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(calls.every((c) => !c.url.toString().includes("tok-123"))).toBe(true);
  });

  it("maps 401 to AUTH_FAILED and 429 to RATE_LIMITED", async () => {
    let status = 401;
    const { fetchImpl } = recorder(() => jsonResponse({}, status));
    const client = new OandaPracticeMarketData(OANDA_CREDS, { fetchImpl, token: () => "t" });
    expect(await client.pricing(["EUR_USD"])).toMatchObject({ ok: false, code: "AUTH_FAILED" });
    status = 429;
    expect(await client.pricing(["EUR_USD"])).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("requests candles with MBA, UTC daily alignment and a bounded count", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse(fixture("oanda-practice/candles-eurusd-m5-mba.json")));
    const client = new OandaPracticeMarketData(OANDA_CREDS, { fetchImpl, token: () => "t" });
    const res = await client.candles({ instrument: "EUR_USD", granularity: "M5", fromMs: Date.parse("2026-11-04T14:40:00Z"), count: 99_999 });
    expect(res.ok).toBe(true);
    const params = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe("/v3/instruments/EUR_USD/candles");
    expect(Object.fromEntries(params)).toMatchObject({ granularity: "M5", price: "MBA", count: "5000", dailyAlignment: "0", alignmentTimezone: "UTC", from: "2026-11-04T14:40:00.000Z" });
    expect(await client.candles({ instrument: "EUR/USD", granularity: "M5", fromMs: 0 })).toMatchObject({ ok: false, code: "INVALID" });
  });
});

describe("Alpaca market data", () => {
  it("parses latest quotes with feed, sizes, exchanges, conditions and treats a zero side as missing", () => {
    const quotes = parseAlpacaLatestQuotes(fixture("alpaca/latest-quotes-iex.json"), "iex", NOW)!;
    expect(quotes.map((q) => q.symbol)).toEqual(["QQQ", "SPY"]);
    const spy = quotes[1]!;
    expect(spy).toMatchObject({ feed: "iex", bid: "512.1", ask: "512.13", bidSize: 2, askSize: 3, bidExchange: "V", conditions: ["R"], tape: "B", time: "2026-11-04T14:59:58.500Z" });
    expect(spy.quality).toMatchObject({ feed: "ALPACA_IEX", coverage: "SINGLE_VENUE", timeliness: "REAL_TIME", quoteAgeMs: 1500, twoSided: true });
    expect(quotes[0]).toMatchObject({ ask: null, bid: "441.2" });
    expect(quotes[0]!.quality.twoSided).toBe(false);
  });

  it("requests the feed explicitly and keeps keys in headers only", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse(fixture("alpaca/latest-quotes-iex.json")));
    const client = new AlpacaMarketData(ALPACA_CREDS, { fetchImpl, now: () => NOW, keys: () => ({ keyId: "kid", secret: "s3cret" }) });
    const res = await client.latestQuotes(["SPY", "QQQ"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request).not.toContain("s3cret");
    expect(calls[0]!.url.searchParams.get("feed")).toBe("iex");
    expect(calls[0]!.url.searchParams.get("symbols")).toBe("SPY,QQQ");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.url.toString()).not.toContain("s3cret");
  });

  it("records delayed SIP as consolidated and delayed", async () => {
    const { fetchImpl } = recorder(() => jsonResponse(fixture("alpaca/latest-quotes-iex.json")));
    const res = await new AlpacaMarketData(ALPACA_CREDS, { fetchImpl, now: () => NOW, feed: "delayed_sip", keys: () => ({ keyId: "k", secret: "s" }) }).latestQuotes(["SPY"]);
    expect(res.ok && res.data[1]!.quality).toMatchObject({ feed: "ALPACA_DELAYED_SIP", coverage: "CONSOLIDATED", timeliness: "DELAYED" });
  });

  it("refuses without credentials or on a non-data host, with no network call", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}));
    expect(await new AlpacaMarketData({ ...ALPACA_CREDS, apiKeyPresent: false }, { fetchImpl }).latestQuotes(["SPY"])).toMatchObject({ ok: false, code: "MISSING_CREDENTIALS" });
    expect(await new AlpacaMarketData({ ...ALPACA_CREDS, dataUrl: "https://api.alpaca.markets" }, { fetchImpl }).latestQuotes(["SPY"])).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION" });
    expect(calls).toHaveLength(0);
  });

  it("reports 429 with the provider's retry delay", async () => {
    const { fetchImpl } = recorder(() => jsonResponse({}, 429, { "retry-after": "7" }));
    expect(await new AlpacaMarketData(ALPACA_CREDS, { fetchImpl, keys: () => ({ keyId: "k", secret: "s" }) }).latestQuotes(["SPY"])).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: 7000 });
  });

  it("paginates bars with spacing, stops at the page limit, and stops on 429 without padding", async () => {
    let page = 0;
    const { calls, fetchImpl } = recorder(() => {
      page += 1;
      if (page === 3) return jsonResponse({}, 429, { "retry-after": "2" });
      return jsonResponse({ bars: { SPY: [{ t: `2026-11-04T14:3${page}:00Z`, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: `p${page}` });
    });
    const sleeps: number[] = [];
    const client = new AlpacaMarketData(ALPACA_CREDS, { fetchImpl, keys: () => ({ keyId: "k", secret: "s" }), maxRequestsPerMinute: 60, sleep: async (ms) => void sleeps.push(ms) });
    const res = await client.bars({ symbol: "SPY", interval: "1m", startMs: 0, endMs: Date.parse("2026-11-05T00:00:00Z"), maxPages: 5 });
    expect(res).toMatchObject({ ok: true, pages: 2, complete: false, stoppedBy: "RATE_LIMITED", retryAfterMs: 2000 });
    expect(res.ok && res.bars).toHaveLength(2);
    expect(sleeps).toEqual([1000, 1000]);
    expect(calls[1]!.url.searchParams.get("page_token")).toBe("p1");

    page = 0;
    const limited = await client.bars({ symbol: "SPY", interval: "1m", startMs: 0, endMs: 1, maxPages: 1 });
    expect(limited).toMatchObject({ ok: true, pages: 1, complete: false, stoppedBy: "PAGE_LIMIT" });
  });
});

describe("quality is additive: dataState labels are unchanged", () => {
  it("Alpaca and OANDA fixture quotes stay DEMO; their quality says RECORDED", async () => {
    const alpaca = await new AlpacaPaperProvider(ALPACA_CREDS, { now: () => NOW, quoteFixture: { SPY: { bid: "512.10", ask: "512.13", mid: "512.115", eventTime: "2026-11-04T14:59:59.000Z" } } }).getQuotes(["etf:SPY"]);
    expect(alpaca.ok && alpaca.data[0]).toMatchObject({ dataState: "DEMO", quality: { timeliness: "RECORDED" } });
  });

  it("Alpaca network quotes stay DEMO; quality records the unspecified account-default feed", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ quote: { bp: 512.1, ap: 512.13, t: "2026-11-04T14:59:59Z" } }));
    const res = await new AlpacaPaperProvider(ALPACA_CREDS, { now: () => NOW, fetchImpl }).getQuotes(["etf:SPY"]);
    expect(res.ok && res.data[0]).toMatchObject({ dataState: "DEMO", quality: { feed: "ALPACA_ACCOUNT_DEFAULT", coverage: "UNKNOWN" } });
    // Without an explicit feed option the request URL is exactly as before.
    expect(calls[0]!.url.search).toBe("");
  });

  it("Frankfurter stays DELAYED and is described as a daily reference rate, never live", async () => {
    const { fetchImpl } = recorder(() => jsonResponse({ amount: 1, base: "EUR", date: "2026-11-03", rates: { USD: 1.0821 } }));
    const res = await new FrankfurterFxProvider({ fetchImpl, now: () => NOW }).getQuotes(["fx:EURUSD"]);
    expect(res.ok && res.data[0]).toMatchObject({ dataState: "DELAYED", bid: null, ask: null, quality: { feed: "ECB_REFERENCE", coverage: "REFERENCE_RATE", timeliness: "REFERENCE", twoSided: false } });
  });
});
