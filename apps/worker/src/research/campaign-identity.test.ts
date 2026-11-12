import { describe, expect, it } from "vitest";
import { DatasetLoadError, loadRawBars, warehouseIdentityMismatch } from "./campaign-data.js";

/**
 * OPERATION INTEGRITY F08: a warehouse dataset must be the instrument, product type and interval the campaign
 * declares, checked before any bar is read. Expected outcomes follow from the declaration, not the code.
 */

const fx = { market: "FX" as const, instrument: "XAU/USD", interval: "1h" as const };
const row = (over: Partial<{ instrumentKey: string; instrumentKind: string; interval: string }> = {}) => ({ id: "ds1", instrumentKey: "XAU_USD", instrumentKind: "COMMODITY", interval: "1h", ...over });

describe("warehouse identity against the campaign declaration (F08)", () => {
  it("refuses EUR/USD bars declared as XAU/USD", () => {
    expect(warehouseIdentityMismatch({ ...fx, market: "GOLD" }, row({ instrumentKey: "EUR_USD", instrumentKind: "FX_PAIR" }))).toMatch(/instrument EUR_USD .* declares XAU\/USD/);
  });

  it("accepts formatting aliases of the same instrument", () => {
    for (const instrument of ["XAU/USD", "XAU_USD", "xauusd", "commodity:XAU-USD"]) {
      expect(warehouseIdentityMismatch({ market: "GOLD", instrument, interval: "1h" }, row())).toBeNull();
    }
    expect(warehouseIdentityMismatch({ market: "FX", instrument: "EUR/USD", interval: "1h" }, row({ instrumentKey: "EUR_USD", instrumentKind: "FX_PAIR" }))).toBeNull();
  });

  it("refuses an interval mismatch", () => {
    expect(warehouseIdentityMismatch({ market: "GOLD", instrument: "XAU/USD", interval: "4h" }, row())).toMatch(/is 1h, but the campaign declares 4h/);
  });

  it("refuses a product the declared market does not study, and unknown kinds", () => {
    // Same normalised symbol, wrong market: gold bars studied under FX costs and calendar.
    expect(warehouseIdentityMismatch({ market: "FX", instrument: "XAU/USD", interval: "1h" }, row())).toMatch(/COMMODITY, which the FX market does not study/);
    expect(warehouseIdentityMismatch({ market: "ETF", instrument: "SPY", interval: "1d" }, row({ instrumentKey: "SPY", instrumentKind: "SOLANA_POOL", interval: "1d" }))).toMatch(/does not study/);
    expect(warehouseIdentityMismatch({ market: "GOLD", instrument: "XAU/USD", interval: "1h" }, row({ instrumentKind: "MYSTERY" }))).toMatch(/does not study/);
  });

  it("loadRawBars refuses a mismatch before reading any bar, as a non-retryable load error", async () => {
    let barReads = 0;
    const prisma = {
      historicalDataset: { findUnique: async () => row({ instrumentKey: "EUR_USD", instrumentKind: "FX_PAIR" }) },
      historicalBar: {
        findMany: async () => {
          barReads += 1;
          return [];
        },
      },
    };
    const dataset = { key: "gold", source: { kind: "WAREHOUSE" as const, datasetId: "ds1" }, market: "GOLD" as const, instrument: "XAU/USD", interval: "1h" as const, asOf: "2026-01-01T00:00:00Z" };
    await expect(loadRawBars(prisma as never, dataset as never, ".")).rejects.toBeInstanceOf(DatasetLoadError);
    expect(barReads).toBe(0);
  });
});
