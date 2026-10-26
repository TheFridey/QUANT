import { describe, expect, it } from "vitest";
import { createInstrumentRegistry, setMarketEnabled, validateStrategyUniverse } from "./registry.js";
import { IndexMarketProvider } from "./index-feed.js";

describe("market selector registry", () => {
  it("toggles markets without inventing quotes", async () => {
    let registry = createInstrumentRegistry();
    expect(registry.selections.get("solana:spot:universe")).toBe(true);
    expect(registry.selections.get("index:SPX")).toBe(false);
    registry = setMarketEnabled(registry, "index:SPX", true);
    expect(registry.selections.get("index:SPX")).toBe(true);

    const provider = new IndexMarketProvider({ useDelayedApi: false });
    const quotes = await provider.getQuotes(["index:SPX"]);
    expect(quotes.ok).toBe(true);
    if (quotes.ok) {
      expect(quotes.data[0]?.level).toBeNull();
      expect(quotes.data[0]?.dataState).toBe("DEMO");
      expect(quotes.data[0]?.provenance).toMatch(/DEMO/);
    }
    expect(provider.buildOrderSpec("index:SPX", "BUY").allowed).toBe(false);
  });

  it("rejects incompatible strategy universes", () => {
    const registry = createInstrumentRegistry();
    const result = validateStrategyUniverse(["solana:spot:universe", "index:SPX"], registry);
    expect(result.ok).toBe(false);
  });
});
