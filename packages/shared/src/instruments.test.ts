import { describe, expect, it } from "vitest";
import {
  SEED_INSTRUMENTS,
  assertCompatibleInstruments,
  canPaperExecute,
  isResearchOnly,
  instrumentSchema,
} from "./instruments.js";

describe("instrument registry", () => {
  it("seeds Solana, FX pairs, ETF proxies, commodity proxies, and research-only indices", () => {
    const ids = SEED_INSTRUMENTS.map((item) => item.id);
    expect(ids).toContain("solana:spot:universe");
    expect(ids).toContain("fx:EURUSD");
    expect(ids).toContain("fx:GBPUSD");
    expect(ids).toContain("etf:SPY");
    expect(ids).toContain("etf:QQQ");
    expect(ids).toContain("commodity:XAUUSD");
    expect(ids).toContain("commodity:WTI");
    expect(ids).toContain("index:SPX");
    expect(ids).toContain("index:NDX");
    expect(ids).toContain("index:FTSE");
    expect(ids).toContain("index:DJI");
    for (const instrument of SEED_INSTRUMENTS) {
      expect(instrumentSchema.parse(instrument).id).toBe(instrument.id);
    }
    const indices = SEED_INSTRUMENTS.filter((item) => item.assetClass === "EQUITY_INDEX");
    expect(indices).toHaveLength(4);
    for (const index of indices) {
      expect(canPaperExecute(index)).toBe(false);
      expect(isResearchOnly(index)).toBe(true);
      expect(index.executionCapabilities).toContain("NO_EXECUTION");
    }
    const fx = SEED_INSTRUMENTS.filter((item) => item.assetClass === "FX_SPOT");
    expect(fx.length).toBeGreaterThanOrEqual(2);
    for (const pair of fx) {
      expect(canPaperExecute(pair)).toBe(true);
      expect(pair.executionCapabilities).toContain("PAPER_FX");
    }
    const etf = SEED_INSTRUMENTS.find((item) => item.id === "etf:SPY")!;
    expect(canPaperExecute(etf)).toBe(true);
    expect(isResearchOnly(etf)).toBe(false);
    const commodities = SEED_INSTRUMENTS.filter((item) => item.assetClass === "COMMODITY_PROXY");
    expect(commodities.length).toBeGreaterThanOrEqual(2);
    for (const commodity of commodities) {
      expect(canPaperExecute(commodity)).toBe(true);
      expect(commodity.providerId).toBe("commodity_stub");
    }
  });

  it("blocks mixing Solana spot with equity indices", () => {
    const sol = SEED_INSTRUMENTS.find((item) => item.id === "solana:spot:universe")!;
    const spx = SEED_INSTRUMENTS.find((item) => item.id === "index:SPX")!;
    expect(assertCompatibleInstruments([sol]).ok).toBe(true);
    expect(assertCompatibleInstruments([spx, SEED_INSTRUMENTS.find((i) => i.id === "index:NDX")!]).ok).toBe(
      true,
    );
    const mixed = assertCompatibleInstruments([sol, spx]);
    expect(mixed.ok).toBe(false);
    expect(mixed.reason).toMatch(/Incompatible/);
  });
});
