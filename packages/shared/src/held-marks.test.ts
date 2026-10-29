import { describe, expect, it } from "vitest";
import { heldOutsideDiscovery, mergeHeldMarksOutsideDiscovery } from "./held-marks.js";

describe("held marks outside discovery (A04 multi-market)", () => {
  const now = new Date("2026-10-28T16:00:00.000Z"); // Wed lunch ET — sessions open

  it("merges FX/ETF/commodity held marks when discovery only has crypto", () => {
    const rows = mergeHeldMarksOutsideDiscovery({
      discoveryAddresses: ["solpair111111111111111111111111111111111"],
      heldPositions: [
        { pairAddress: "fx:EURUSD", baseQty: "1000" },
        { pairAddress: "etf:SPY", baseQty: "2" },
        { pairAddress: "commodity:XAUUSD", baseQty: "0.5" },
        { pairAddress: "solpair111111111111111111111111111111111", baseQty: "10" },
      ],
      latestByPair: {
        "fx:EURUSD": {
          pairAddress: "fx:EURUSD",
          priceUsd: "1.0850",
          freshness: "LIVE",
          receivedAt: now.toISOString(),
        },
        "etf:SPY": {
          pairAddress: "etf:SPY",
          priceUsd: "520.10",
          freshness: "DELAYED",
          receivedAt: now.toISOString(),
        },
        "commodity:XAUUSD": {
          pairAddress: "commodity:XAUUSD",
          priceUsd: "2650",
          freshness: "LIVE",
          receivedAt: now.toISOString(),
        },
        solpair111111111111111111111111111111111: {
          pairAddress: "solpair111111111111111111111111111111111",
          priceUsd: "1.2",
          freshness: "LIVE",
          receivedAt: now.toISOString(),
        },
      },
      now,
    });

    const outside = heldOutsideDiscovery(rows);
    expect(outside.map((r) => r.pairAddress).sort()).toEqual([
      "commodity:XAUUSD",
      "etf:SPY",
      "fx:EURUSD",
    ]);
    for (const row of outside) {
      expect(row.markUsableForEval).toBe(true);
      expect(row.productLabel).toBeTruthy();
      expect(row.session?.status).toBe("OPEN");
    }
    expect(outside.find((r) => r.pairAddress === "fx:EURUSD")?.freshness).toBe("LIVE");
    expect(outside.find((r) => r.pairAddress === "etf:SPY")?.freshness).toBe("DELAYED");
  });

  it("does not invent marks when latest observation is missing", () => {
    const rows = mergeHeldMarksOutsideDiscovery({
      discoveryAddresses: [],
      heldPositions: [{ pairAddress: "fx:GBPUSD", baseQty: "500" }],
      latestByPair: {},
      now,
    });
    expect(rows[0]?.outsideDiscovery).toBe(true);
    expect(rows[0]?.freshness).toBe("MISSING");
    expect(rows[0]?.markUsableForEval).toBe(false);
    expect(rows[0]?.priceUsd).toBeNull();
    expect(rows[0]?.productLabel).toMatch(/FX spot/i);
  });

  it("flags closed FX weekend session on held mark without inventing open status", () => {
    const saturday = new Date("2026-10-24T15:00:00.000Z");
    const rows = mergeHeldMarksOutsideDiscovery({
      discoveryAddresses: [],
      heldPositions: [{ pairAddress: "fx:EURUSD", baseQty: "1" }],
      latestByPair: {
        "fx:EURUSD": {
          pairAddress: "fx:EURUSD",
          priceUsd: "1.08",
          freshness: "LIVE",
          receivedAt: saturday.toISOString(),
        },
      },
      now: saturday,
    });
    expect(rows[0]?.markUsableForEval).toBe(true);
    expect(rows[0]?.session?.status).toBe("CLOSED");
    expect(rows[0]?.session?.reason).toBe("FX_WEEKEND");
  });
});
