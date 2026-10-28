import { describe, expect, it } from "vitest";
import { buildPaperMultiMarketPairs } from "./paper-multimarket.js";

describe("paper multi-market ingest fixtures", () => {
  it("emits DEMO-provenance FX and ETF pairs never labelled LIVE", () => {
    const pairs = buildPaperMultiMarketPairs({ now: new Date("2026-10-28T16:00:00.000Z") });
    expect(pairs.some((p) => p.source === "fx_stub")).toBe(true);
    expect(pairs.some((p) => p.source === "etf_stub")).toBe(true);
    for (const pair of pairs) {
      expect(pair.raw).toMatchObject({ dataState: "DEMO" });
      expect(pair.priceUsd).not.toBeNull();
    }
  });
});
