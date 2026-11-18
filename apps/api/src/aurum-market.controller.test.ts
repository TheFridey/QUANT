import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AurumMarketController, MAX_CANDLES, findCandleGaps, toCandle } from "./aurum-market.controller.js";

const H = 3_600_000;

function fakePrisma(input: { dataset?: Record<string, unknown> | null; bars?: Array<Record<string, unknown>> }) {
  return {
    historicalDataset: {
      findMany: async () => (input.dataset ? [input.dataset] : []),
      findUnique: async () => input.dataset ?? null,
    },
    historicalBar: { findMany: async ({ take }: { take: number }) => (input.bars ?? []).slice(0, take) },
  } as never;
}

const dataset = { id: "ds1", sourceId: "oanda_practice", instrumentKey: "XAU_USD", interval: "1h", versionHash: "abc", barCount: 3, firstOpenTime: new Date(0), lastOpenTime: new Date(3 * H), updatedAt: new Date(4 * H), licence: {} };

describe("AURUM COMMAND gold market API (HELIOS)", () => {
  it("maps warehouse bars exactly and keeps missing bid/ask as null, never invented", () => {
    expect(toCandle({ openTime: new Date(H), open: "2650.10", high: "2651", low: "2649.5", close: "2650.4", extra: { bid_c: "2650.25", ask_c: "2650.55", spread_c: "0.3" } })).toEqual({
      t: H, o: "2650.10", h: "2651", l: "2649.5", c: "2650.4", bidC: "2650.25", askC: "2650.55", spreadC: "0.3",
    });
    expect(toCandle({ openTime: new Date(H), open: "1", high: "2", low: "1", close: "2", extra: null })).toMatchObject({ bidC: null, askC: null, spreadC: null });
  });

  it("reports gaps wider than one interval, including closed sessions", () => {
    expect(findCandleGaps([0, H, 2 * H, 5 * H], H)).toEqual([{ afterT: 2 * H, beforeT: 5 * H, missingBars: 2 }]);
    expect(findCandleGaps([0, H], H)).toEqual([]);
  });

  it("returns the latest bars ascending with bid/ask coverage, and refuses bad input or non-gold datasets", async () => {
    // findMany is ordered desc by the controller; the fake returns them in that order.
    const bars = [3, 2, 0].map((i) => ({ openTime: new Date(i * H), open: "1", high: "2", low: "1", close: "2", extra: i === 0 ? {} : { bid_c: "1.9", ask_c: "2.1", spread_c: "0.2" } }));
    const c = new AurumMarketController(fakePrisma({ dataset, bars }));
    const r = await c.candles("ds1", "3");
    expect(r.candles.map((x) => x.t)).toEqual([0, 2 * H, 3 * H]);
    expect(r.gaps).toEqual([{ afterT: 0, beforeT: 2 * H, missingBars: 1 }]);
    expect(r.bidAskCoverage).toBeCloseTo(2 / 3, 6);
    expect(r.dataKind).toBe("HISTORICAL_WAREHOUSE_BARS");
    await expect(c.candles("bad id!", "10")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.candles("ds1", String(MAX_CANDLES + 1))).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.candles("ds1", "0")).rejects.toBeInstanceOf(BadRequestException);
    await expect(new AurumMarketController(fakePrisma({ dataset: { ...dataset, instrumentKey: "EUR_USD" } })).candles("ds1", "10")).rejects.toBeInstanceOf(NotFoundException);
    await expect(new AurumMarketController(fakePrisma({ dataset: null })).candles("ds1", "10")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an empty dataset returns no candles rather than synthesised ones", async () => {
    const r = await new AurumMarketController(fakePrisma({ dataset, bars: [] })).candles("ds1", "10");
    expect(r.candles).toEqual([]);
    expect(r.bidAskCoverage).toBeNull();
  });

  it("status states blocked and inactive capabilities, never an inferred one", () => {
    const s = new AurumMarketController(fakePrisma({})).status();
    expect(s).toMatchObject({ shadowFeed: { state: "INACTIVE", persisted: false }, account: { state: "NOT_CREATED" }, execution: { state: "BLOCKED" }, research: { state: "BLOCKED" }, executable: false });
  });
});
