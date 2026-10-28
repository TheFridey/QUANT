import { describe, expect, it } from "vitest";
import { ExternalDemoAdapter, inventoryExternalDemoCredentials } from "./external-demo.js";
import { FxMarketProvider } from "./fx-feed.js";

describe("FX + external demo adapters", () => {
  it("lists FX currency pairs and labels fixture quotes as DEMO not LIVE", async () => {
    const fx = new FxMarketProvider({
      fixtureLevels: { "fx:EURUSD": "1.08500000" },
      now: () => new Date("2026-10-28T16:00:00.000Z"),
    });
    const instruments = await fx.listInstruments();
    expect(instruments.some((item) => item.symbol === "EURUSD")).toBe(true);
    const quotes = await fx.getQuotes(["fx:EURUSD"]);
    expect(quotes.ok).toBe(true);
    if (!quotes.ok) return;
    expect(quotes.data[0]?.level).toBe("1.08500000");
    expect(quotes.data[0]?.dataState).toBe("DEMO");
    expect(quotes.data[0]?.provenance).toMatch(/DEMO/);
    expect(fx.buildOrderSpec("fx:EURUSD", "BUY").allowed).toBe(true);
  });

  it("keeps external demo BLOCKED_EXTERNAL without credentials and never fakes success", async () => {
    const creds = inventoryExternalDemoCredentials({});
    expect(creds.apiKeyPresent).toBe(false);
    const adapter = new ExternalDemoAdapter(creds);
    expect(adapter.blocked).toBe(true);
    const quotes = await adapter.getQuotes(["any"]);
    expect(quotes.ok).toBe(false);
    if (quotes.ok) return;
    expect(quotes.error).toMatch(/BLOCKED_EXTERNAL/);
    expect(adapter.buildOrderSpec("any", "BUY").allowed).toBe(false);
  });
});
