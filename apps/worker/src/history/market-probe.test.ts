import { describe, expect, it } from "vitest";
import { describeQuoteQuality, type ProviderReadiness } from "@odin/shared";
import { boundedFetch, runMarketProbe, type MarketProbeGateway, type ProbeProviderId } from "./market-probe.js";

const NOW = new Date("2026-11-04T15:00:00.000Z"); // Wednesday, US RTH, FX open

function stub(readiness: Record<ProbeProviderId, ProviderReadiness>, overrides: Partial<MarketProbeGateway> = {}) {
  const calls: string[] = [];
  const gateway: MarketProbeGateway = {
    readiness: () => readiness,
    async oandaAvailability(names) {
      calls.push(`oandaAvailability:${names.join(",")}`);
      return { ok: true, data: names.map((n) => (n === "XAU_USD" || n === "WTICO_USD" ? { instrument: n, available: false, reason: `${n} not available on this account` } : { instrument: n, available: true, reason: null })) };
    },
    async oandaPricing(names) {
      calls.push(`oandaPricing:${names.join(",")}`);
      const out: Record<string, { bid: string; ask: string; time: string; quality: ReturnType<typeof describeQuoteQuality> }> = {};
      for (const n of names) {
        const time = "2026-11-04T14:59:58.000Z";
        out[n] = { bid: "1.08201", ask: "1.08215", time, quality: describeQuoteQuality({ source: "oanda_practice", feed: "OANDA_PRACTICE", now: NOW, eventTime: time, bid: "1.08201", ask: "1.08215", providerTradeable: n !== "GBP_USD" }) };
      }
      return { ok: true, data: out };
    },
    async alpacaQuotes(symbols) {
      calls.push(`alpacaQuotes:${symbols.join(",")}`);
      const time = "2026-11-04T14:59:59.000Z";
      return { ok: true, data: Object.fromEntries(symbols.map((s) => [s, { bid: "512.10", ask: "512.13", time, quality: describeQuoteQuality({ source: "alpaca_paper", feed: "ALPACA_IEX", now: NOW, eventTime: time, bid: "512.10", ask: "512.13" }) }])) };
    },
    async frankfurterQuotes(ids) {
      calls.push(`frankfurterQuotes:${ids.join(",")}`);
      const time = "2026-11-03T16:00:00.000Z";
      return { ok: true, data: Object.fromEntries(ids.map((id) => [id, { bid: null, ask: null, level: "1.0821", time, dataState: "DELAYED", quality: describeQuoteQuality({ source: "frankfurter_fx", feed: "ECB_REFERENCE", now: NOW, eventTime: time }) }])) };
    },
    ...overrides,
  };
  return { gateway, calls };
}

describe("runMarketProbe", () => {
  it("with no credentials: FX falls back to the ECB reference rate, ETFs and gold report missing credentials", async () => {
    const { gateway, calls } = stub({ oanda_practice: "MISSING_CREDENTIALS", alpaca_paper: "MISSING_CREDENTIALS", frankfurter_fx: "READY" });
    const report = await runMarketProbe({ gateway, now: NOW });
    expect(report.mode).toBe("READ_ONLY_PROBE");
    expect(calls).toEqual(["frankfurterQuotes:fx:EURUSD,fx:GBPUSD,fx:USDJPY"]);
    const eur = report.instruments.find((e) => e.instrumentId === "fx:EURUSD")!;
    expect(eur).toMatchObject({ probeProvider: "frankfurter_fx", canPaperTradeNow: false, lastQuote: { level: "1.0821", bid: null, ask: null, dataState: "DELAYED", ageMs: 82_800_000 } });
    expect(eur.quality).toMatchObject({ coverage: "REFERENCE_RATE", timeliness: "REFERENCE" });
    expect(eur.cannotTradeReasons.some((r) => r.startsWith("REFERENCE_RATE_ONLY"))).toBe(true);
    const spy = report.instruments.find((e) => e.instrumentId === "etf:SPY")!;
    expect(spy).toMatchObject({ probeProvider: "alpaca_paper", provider: { configured: false, respondedOk: false }, lastQuote: null });
    expect(spy.cannotTradeReasons[0]).toBe("PROVIDER_NOT_CONFIGURED: alpaca_paper readiness=MISSING_CREDENTIALS");
    const gold = report.instruments.find((e) => e.instrumentId === "commodity:XAUUSD")!;
    expect(gold.cannotTradeReasons[0]).toMatch(/^PROVIDER_NOT_CONFIGURED: oanda_practice/);
  });

  it("with OANDA and Alpaca configured: reports availability, quotes, quality and the remaining blockers", async () => {
    const { gateway, calls } = stub({ oanda_practice: "CONNECTING", alpaca_paper: "CONNECTING", frankfurter_fx: "READY" });
    const report = await runMarketProbe({ gateway, now: NOW });
    expect(calls).toEqual([
      "oandaAvailability:EUR_USD,GBP_USD,USD_JPY,XAU_USD,WTICO_USD",
      "oandaPricing:EUR_USD,GBP_USD,USD_JPY",
      "alpacaQuotes:SPY,QQQ",
    ]);
    const gold = report.instruments.find((e) => e.instrumentId === "commodity:XAUUSD")!;
    expect(gold).toMatchObject({ availableOnAccount: false, availabilityReason: "XAU_USD not available on this account", lastQuote: null });
    expect(gold.cannotTradeReasons).toContain("NOT_AVAILABLE_ON_ACCOUNT: XAU_USD not available on this account");
    const jpy = report.instruments.find((e) => e.instrumentId === "fx:USDJPY")!;
    expect(jpy).toMatchObject({ availableOnAccount: true, provider: { respondedOk: true }, lastQuote: { bid: "1.08201", ageMs: 2000 } });
    expect(jpy.cannotTradeReasons.some((r) => r.startsWith("QUOTE_CURRENCY_JPY"))).toBe(true);
    const gbp = report.instruments.find((e) => e.instrumentId === "fx:GBPUSD")!;
    expect(gbp.cannotTradeReasons.some((r) => r.startsWith("PROVIDER_NOT_TRADEABLE"))).toBe(true);
    const spy = report.instruments.find((e) => e.instrumentId === "etf:SPY")!;
    expect(spy.quality).toMatchObject({ feed: "ALPACA_IEX", coverage: "SINGLE_VENUE" });
    // Every non-Solana instrument stays non-tradeable until PCR-2 and operator activation.
    for (const entry of report.instruments.filter((e) => e.assetClass !== "SPOT_CRYPTO_PAIR")) {
      expect(entry.canPaperTradeNow).toBe(false);
    }
    expect(report.instruments.find((e) => e.instrumentId === "solana:spot:universe")).toMatchObject({ canPaperTradeNow: null, provider: { readiness: "NOT_PROBED" } });
    expect(report.instruments.find((e) => e.instrumentId === "index:SPX")!.cannotTradeReasons[0]).toMatch(/^RESEARCH_ONLY/);
  });

  it("records provider errors as NO_QUOTE reasons and keeps the report JSON-serialisable", async () => {
    const { gateway } = stub(
      { oanda_practice: "CONNECTING", alpaca_paper: "CONNECTING", frankfurter_fx: "READY" },
      { alpacaQuotes: async () => ({ ok: false, error: "AUTH_FAILED: Alpaca http_403" }), oandaAvailability: async () => ({ ok: false, error: "AUTH_FAILED: OANDA rejected token" }) },
    );
    const report = await runMarketProbe({ gateway, now: NOW });
    expect(report.providers.alpaca_paper).toEqual({ readiness: "CONNECTING", called: true, error: "AUTH_FAILED: Alpaca http_403" });
    expect(report.instruments.find((e) => e.instrumentId === "etf:QQQ")!.cannotTradeReasons).toContain("NO_QUOTE: AUTH_FAILED: Alpaca http_403");
    expect(report.instruments.find((e) => e.instrumentId === "fx:EURUSD")!.quoteError).toBe("AUTH_FAILED: OANDA rejected token");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("reports closed sessions at the weekend", async () => {
    const { gateway } = stub({ oanda_practice: "MISSING_CREDENTIALS", alpaca_paper: "MISSING_CREDENTIALS", frankfurter_fx: "READY" });
    const report = await runMarketProbe({ gateway, now: new Date("2026-11-07T15:00:00.000Z") });
    const spy = report.instruments.find((e) => e.instrumentId === "etf:SPY")!;
    expect(spy.session.status).toBe("CLOSED");
    expect(spy.cannotTradeReasons).toContain("SESSION_CLOSED: WEEKEND");
  });
});

describe("boundedFetch", () => {
  it("allows only GET and enforces a request budget", async () => {
    const inner = (async () => new Response("{}")) as unknown as typeof fetch;
    const f = boundedFetch(1000, 2, inner);
    await expect(f("https://example.test", { method: "POST" })).rejects.toThrow("only GET");
    await f("https://example.test");
    await f("https://example.test");
    await expect(f("https://example.test")).rejects.toThrow("budget");
  });
});
