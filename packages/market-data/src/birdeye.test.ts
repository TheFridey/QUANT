import { describe, expect, it } from "vitest";
import { BirdeyeClient, parseCandles } from "./birdeye.js";

describe("Birdeye adapter", () => {
  it("stays unavailable without an API key and does not invent candles", async () => {
    const client = new BirdeyeClient(undefined, async () => {
      throw new Error("network should not be called");
    });
    const ohlcv = await client.getOhlcv("So11111111111111111111111111111111111111112", "15m", 1, 2);
    const security = await client.getTokenSecurity("So11111111111111111111111111111111111111112");
    const holders = await client.getHolders("So11111111111111111111111111111111111111112");
    expect(ohlcv.ok).toBe(false);
    expect(security.ok).toBe(false);
    expect(holders.ok).toBe(false);
    if (!ohlcv.ok) expect(ohlcv.code).toBe("UNAVAILABLE");
  });

  it("parses candle rows and drops incomplete ones", () => {
    const candles = parseCandles({
      data: {
        items: [
          { unixTime: 100, o: 1.5, h: 2, l: 1.2, c: 1.8, v: 10 },
          { unixTime: 160, o: 1.8, h: 2 },
        ],
      },
    });
    expect(candles).toEqual([
      { time: 100, open: "1.5", high: "2", low: "1.2", close: "1.8", volume: "10" },
    ]);
  });

  it("reports holder count only when the payload includes one", async () => {
    const client = new BirdeyeClient("test-key", async () => Response.json({ data: { note: "no count" } }));
    const missing = await client.getHolders("So11111111111111111111111111111111111111112");
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.data.holderCount).toBeNull();

    const withCount = new BirdeyeClient("test-key", async () => Response.json({ data: { total: 42 } }));
    const present = await withCount.getHolders("So11111111111111111111111111111111111111112");
    expect(present.ok).toBe(true);
    if (present.ok) expect(present.data.holderCount).toBe("42");
  });
});
