import { describe, expect, it } from "vitest";
import { ExternalDemoAdapter, inventoryExternalDemoCredentials } from "./external-demo.js";
import { FxMarketProvider } from "./fx-feed.js";
import { AlpacaPaperProvider } from "./providers/alpaca-paper.js";
import { OandaPracticeProvider } from "./providers/oanda-practice.js";

describe("FX stub + named external providers", () => {
  it("fx stub returns DEMO quotes for EURUSD", async () => {
    const fx = new FxMarketProvider({
      fixtureLevels: { "fx:EURUSD": "1.10000000" },
    });
    const instruments = await fx.listInstruments();
    expect(instruments.some((i) => i.id === "fx:EURUSD")).toBe(true);
    const quotes = await fx.getQuotes(["fx:EURUSD"]);
    expect(quotes.ok).toBe(true);
    if (quotes.ok) {
      expect(quotes.data[0]?.level).toBe("1.10000000");
      expect(quotes.data[0]?.dataState).toBe("DEMO");
    }
    expect(fx.buildOrderSpec("fx:EURUSD", "BUY").allowed).toBe(true);
  });

  it("EXTERNAL_DEMO_API_KEY alone does not unblock external demo", async () => {
    const inventory = inventoryExternalDemoCredentials({
      EXTERNAL_DEMO_API_KEY: "not-a-real-provider-key",
    });
    expect(inventory.apiKeyPresent).toBe(true);
    expect(inventory.alpacaReady).toBe(false);
    expect(inventory.oandaReady).toBe(false);

    const adapter = new ExternalDemoAdapter(inventory);
    expect(adapter.readiness()).toBe("MISSING_CREDENTIALS");
    const quotes = await adapter.getQuotes(["fx:EURUSD"]);
    expect(quotes.ok).toBe(false);
    expect(adapter.buildOrderSpec("fx:EURUSD", "BUY").allowed).toBe(false);
  });

  it("Alpaca offline fixture path returns sanitised DEMO quotes when READY", async () => {
    const provider = new AlpacaPaperProvider(
      {
        apiKeyPresent: true,
        apiSecretPresent: true,
        baseUrl: "https://paper-api.alpaca.markets",
        dataUrl: "https://data.alpaca.markets",
      },
      {
        quoteFixture: { SPY: { bid: "519.00", ask: "519.20", mid: "519.10000000" } },
      },
    );
    expect(provider.readiness()).toBe("READY");
    const quotes = await provider.getQuotes(["etf:SPY"]);
    expect(quotes.ok).toBe(true);
    if (quotes.ok) {
      expect(quotes.data[0]?.level).toBe("519.10000000");
      expect(quotes.data[0]?.bid).toBe("519.00");
      expect(quotes.data[0]?.provenance).toContain("offline_fixture");
    }
  });

  it("OANDA offline fixture path returns sanitised DEMO quotes when READY", async () => {
    const provider = new OandaPracticeProvider(
      {
        tokenPresent: true,
        accountIdPresent: true,
        apiUrl: "https://api-fxpractice.oanda.com",
        accountId: "practice-1",
      },
      {
        pricingFixture: { EUR_USD: { bid: "1.08490", ask: "1.08510" } },
      },
    );
    expect(provider.readiness()).toBe("READY");
    // providerSymbol for fx:EURUSD is EURUSD — also try EUR_USD via symbol map
    const quotes = await provider.getQuotes(["fx:EURUSD"]);
    expect(quotes.ok).toBe(true);
  });

  it("Alpaca without credentials reports MISSING_CREDENTIALS and refuses orders", async () => {
    const provider = new AlpacaPaperProvider({
      apiKeyPresent: false,
      apiSecretPresent: false,
      baseUrl: "https://paper-api.alpaca.markets",
      dataUrl: "https://data.alpaca.markets",
    });
    expect(provider.readiness()).toBe("MISSING_CREDENTIALS");
    const quotes = await provider.getQuotes(["etf:SPY"]);
    expect(quotes.ok).toBe(false);
    if (!quotes.ok) expect(quotes.error).toContain("BLOCKED_EXTERNAL_TEST");
    expect(provider.buildOrderSpec("etf:SPY", "BUY").allowed).toBe(false);
  });
});
