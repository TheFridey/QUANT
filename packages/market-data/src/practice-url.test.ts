import { describe, expect, it } from "vitest";
import {
  ALPACA_DATA_HOSTS,
  ALPACA_PAPER_TRADE_HOSTS,
  OANDA_PRACTICE_HOSTS,
  assertAllowlistedHttpsUrl,
  assertCompleteQuote,
} from "./practice-url.js";
import { AlpacaPaperProvider } from "./providers/alpaca-paper.js";
import { OandaPracticeProvider } from "./providers/oanda-practice.js";

describe("practice URL guards (D10)", () => {
  it("accepts exact allowlisted HTTPS practice hosts", () => {
    expect(assertAllowlistedHttpsUrl("https://paper-api.alpaca.markets", ALPACA_PAPER_TRADE_HOSTS).ok).toBe(true);
    expect(assertAllowlistedHttpsUrl("https://data.alpaca.markets", ALPACA_DATA_HOSTS).ok).toBe(true);
    expect(assertAllowlistedHttpsUrl("https://api-fxpractice.oanda.com", OANDA_PRACTICE_HOSTS).ok).toBe(true);
  });

  it("rejects live hosts and practice markers smuggled in path/query", () => {
    const liveTrade = assertAllowlistedHttpsUrl("https://api.alpaca.markets", ALPACA_PAPER_TRADE_HOSTS);
    expect(liveTrade.ok).toBe(false);

    const pathSmuggle = assertAllowlistedHttpsUrl(
      "https://evil.example/paper-api.alpaca.markets/v2",
      ALPACA_PAPER_TRADE_HOSTS,
    );
    expect(pathSmuggle.ok).toBe(false);

    const liveInPath = assertAllowlistedHttpsUrl(
      "https://paper-api.alpaca.markets/redirect/api.alpaca.markets",
      ALPACA_PAPER_TRADE_HOSTS,
    );
    expect(liveInPath.ok).toBe(false);

    const oandaLive = assertAllowlistedHttpsUrl("https://api-fxtrade.oanda.com", OANDA_PRACTICE_HOSTS);
    expect(oandaLive.ok).toBe(false);

    const oandaPath = assertAllowlistedHttpsUrl(
      "https://attacker.test/api-fxpractice.oanda.com",
      OANDA_PRACTICE_HOSTS,
    );
    expect(oandaPath.ok).toBe(false);

    const httpRemote = assertAllowlistedHttpsUrl("http://paper-api.alpaca.markets", ALPACA_PAPER_TRADE_HOSTS);
    expect(httpRemote.ok).toBe(false);
  });

  it("rejects incomplete quotes: non-finite, ask<bid, stale", () => {
    const now = new Date("2026-10-28T16:00:00.000Z");
    expect(assertCompleteQuote({ bid: Number.NaN, ask: 1, now }).ok).toBe(false);
    expect(assertCompleteQuote({ bid: 1.1, ask: 1.0, now }).reason).toBe("ASK_LT_BID");
    expect(
      assertCompleteQuote({
        bid: 1,
        ask: 1.1,
        eventTime: "2026-10-28T15:00:00.000Z",
        now,
        maxEventAgeMs: 60_000,
      }).reason,
    ).toBe("STALE_EVENT_TIME");
    expect(assertCompleteQuote({ bid: "1.0", ask: "1.1", eventTime: now.toISOString(), now }).ok).toBe(true);
  });

  it("Alpaca readiness distinguishes MISSING_CREDENTIALS / AUTH_FAILED / CONNECTING / READY", async () => {
    const missing = new AlpacaPaperProvider({
      apiKeyPresent: false,
      apiSecretPresent: false,
      baseUrl: "https://paper-api.alpaca.markets",
      dataUrl: "https://data.alpaca.markets",
    });
    expect(missing.readiness()).toBe("MISSING_CREDENTIALS");

    const badHost = new AlpacaPaperProvider({
      apiKeyPresent: true,
      apiSecretPresent: true,
      baseUrl: "https://evil.example/paper-api",
      dataUrl: "https://data.alpaca.markets",
    });
    expect(badHost.readiness()).toBe("INVALID_CONFIGURATION");

    const connecting = new AlpacaPaperProvider({
      apiKeyPresent: true,
      apiSecretPresent: true,
      baseUrl: "https://paper-api.alpaca.markets",
      dataUrl: "https://data.alpaca.markets",
    });
    // Key presence alone is not READY.
    expect(connecting.readiness()).toBe("CONNECTING");

    connecting.noteAuthFailure();
    expect(connecting.readiness()).toBe("AUTH_FAILED");

    const readyFixture = new AlpacaPaperProvider(
      {
        apiKeyPresent: true,
        apiSecretPresent: true,
        baseUrl: "https://paper-api.alpaca.markets",
        dataUrl: "https://data.alpaca.markets",
      },
      {
        now: () => new Date("2026-10-28T16:00:00.000Z"),
        quoteFixture: { SPY: { bid: "519.00", ask: "519.20", mid: "519.10" } },
      },
    );
    expect(readyFixture.readiness()).toBe("READY");

    const rejected = await readyFixture.getQuotes(["etf:SPY"]);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.data[0]?.level).toBe("519.10000000");
    }

    const inverted = new AlpacaPaperProvider(
      {
        apiKeyPresent: true,
        apiSecretPresent: true,
        baseUrl: "https://paper-api.alpaca.markets",
        dataUrl: "https://data.alpaca.markets",
      },
      {
        now: () => new Date("2026-10-28T16:00:00.000Z"),
        quoteFixture: { SPY: { bid: "520", ask: "519", mid: "519.5" } },
      },
    );
    const badQuote = await inverted.getQuotes(["etf:SPY"]);
    expect(badQuote.ok).toBe(true);
    if (badQuote.ok) {
      expect(badQuote.data[0]?.level).toBeNull();
      expect(badQuote.data[0]?.provenance).toContain("ASK_LT_BID");
    }
  });

  it("OANDA rejects injected live URL and incomplete fixtures without network", async () => {
    const live = new OandaPracticeProvider({
      tokenPresent: true,
      accountIdPresent: true,
      apiUrl: "https://api-fxtrade.oanda.com",
      accountId: "x",
    });
    expect(live.readiness()).toBe("INVALID_CONFIGURATION");

    const pathHost = new OandaPracticeProvider({
      tokenPresent: true,
      accountIdPresent: true,
      apiUrl: "https://evil.test/api-fxpractice.oanda.com",
      accountId: "x",
    });
    expect(pathHost.readiness()).toBe("INVALID_CONFIGURATION");

    const keysOnly = new OandaPracticeProvider({
      tokenPresent: true,
      accountIdPresent: true,
      apiUrl: "https://api-fxpractice.oanda.com",
      accountId: "practice-1",
    });
    expect(keysOnly.readiness()).toBe("CONNECTING");

    const fixture = new OandaPracticeProvider(
      {
        tokenPresent: true,
        accountIdPresent: true,
        apiUrl: "https://api-fxpractice.oanda.com",
        accountId: "practice-1",
      },
      {
        now: () => new Date("2026-10-28T16:00:00.000Z"),
        pricingFixture: { EUR_USD: { bid: "1.10", ask: "1.09" } },
      },
    );
    expect(fixture.readiness()).toBe("READY");
    const quotes = await fixture.getQuotes(["fx:EURUSD"]);
    expect(quotes.ok).toBe(true);
    if (quotes.ok) {
      expect(quotes.data[0]?.level).toBeNull();
      expect(quotes.data[0]?.provenance).toContain("ASK_LT_BID");
    }
  });

  it("Alpaca AUTH_FAILED updates readiness after 401 on injected fetch", async () => {
    const provider = new AlpacaPaperProvider(
      {
        apiKeyPresent: true,
        apiSecretPresent: true,
        baseUrl: "https://paper-api.alpaca.markets",
        dataUrl: "https://data.alpaca.markets",
      },
      {
        now: () => new Date("2026-10-28T16:00:00.000Z"),
        fetchImpl: async () => new Response("nope", { status: 401 }),
      },
    );
    expect(provider.readiness()).toBe("CONNECTING");
    const result = await provider.getQuotes(["etf:SPY"]);
    expect(result.ok).toBe(false);
    expect(provider.readiness()).toBe("AUTH_FAILED");
  });
});
