import { describe, expect, it } from "vitest";
import { positionalArgs, storageQuotaFromArgs } from "./backfill-quota.js";
import { DEFAULT_STORAGE_QUOTA } from "./prisma-backfill-store.js";

describe("HELIOS backfill storage quota flags", () => {
  it("defaults to the deployed quota when no flag is given", () => {
    expect(storageQuotaFromArgs(["oanda_practice", "XAU_USD", "1m"])).toEqual(DEFAULT_STORAGE_QUOTA);
  });

  it("accepts a bounded 10-year M1 quota", () => {
    expect(storageQuotaFromArgs(["--max-bars-per-dataset=4000000", "--max-total-bars=5000000"])).toEqual({ maxBarsPerDataset: 4_000_000, maxTotalBars: 5_000_000 });
    // Total defaults to at least the per-dataset value.
    expect(storageQuotaFromArgs(["--max-bars-per-dataset=6000000"])).toEqual({ maxBarsPerDataset: 6_000_000, maxTotalBars: 6_000_000 });
  });

  it("refuses values above the ceilings, inconsistent pairs and malformed numbers rather than clamping", () => {
    expect(() => storageQuotaFromArgs(["--max-bars-per-dataset=6000001"])).toThrow("above");
    expect(() => storageQuotaFromArgs(["--max-total-bars=8000001"])).toThrow("above");
    expect(() => storageQuotaFromArgs(["--max-bars-per-dataset=300000", "--max-total-bars=200000"])).toThrow("below");
    for (const bad of ["0", "-1", "1e6", "4,000,000", "", "abc", "01"]) {
      expect(() => storageQuotaFromArgs([`--max-bars-per-dataset=${bad}`])).toThrow();
    }
  });

  it("keeps positional arguments in order and drops flags", () => {
    expect(positionalArgs(["oanda_practice", "--max-total-bars=5000000", "XAU_USD", "1m", "PRECIOUS_METAL", "a", "b", "200"])).toEqual(["oanda_practice", "XAU_USD", "1m", "PRECIOUS_METAL", "a", "b", "200"]);
  });
});
