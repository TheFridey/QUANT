import { describe, expect, it } from "vitest";
import { aggregateBars } from "./aggregate.js";
import type { HistoricalBar } from "./integrity.js";

const M1 = 60_000;
const H1 = 3_600_000;
const T0 = Date.UTC(2026, 10, 17, 14, 0);

function m1(i: number, o: string, h: string, l: string, c: string, ba = true): HistoricalBar {
  const openTime = T0 + i * M1;
  const half = (x: string, d: number) => (Number(x) + d).toFixed(2);
  return {
    openTime,
    availableAt: openTime + M1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    extra: ba
      ? { tickVolume: 10 + i, priceComponents: "MBA", bid_o: half(o, -0.15), bid_h: half(h, -0.15), bid_l: half(l, -0.15), bid_c: half(c, -0.15), ask_o: half(o, 0.15), ask_h: half(h, 0.15), ask_l: half(l, 0.15), ask_c: half(c, 0.15) }
      : { tickVolume: 10 + i, priceComponents: "MBA", bid_o: null, bid_h: null, bid_l: null, bid_c: null, ask_o: null, ask_h: null, ask_l: null, ask_c: null },
  };
}

describe("deterministic M1 to higher-timeframe aggregation", () => {
  it("builds OHLC, bid/ask, ticks and availability exactly, and flags completeness against the calendar", () => {
    const bars = [m1(0, "2650.00", "2651.00", "2649.50", "2650.50"), m1(1, "2650.50", "2652.25", "2650.10", "2652.00"), m1(2, "2652.00", "2652.10", "2648.00", "2649.00")];
    const r = aggregateBars(bars, { sourceMs: M1, targetMs: H1, expectedMembers: () => 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [h] = r.bars;
    expect(h).toMatchObject({ openTime: T0, availableAt: T0 + H1, open: "2650.00", high: "2652.25", low: "2648", close: "2649.00", members: 3, expectedMembers: 60, complete: false });
    expect(h!.extra).toMatchObject({ bid_o: "2649.85", ask_c: "2649.15", bid_h: "2652.1", ask_l: "2648.15", tickVolume: 33, spread_c: "0.3", aggregatedFromMs: M1 });
    // Deterministic: same input, identical output.
    expect(JSON.stringify(aggregateBars(bars, { sourceMs: M1, targetMs: H1, expectedMembers: () => 60 }))).toBe(JSON.stringify(r));
  });

  it("never fills in bid/ask from a partial set, and never fabricates missing minutes", () => {
    const r = aggregateBars([m1(0, "1", "2", "1", "2"), m1(5, "2", "3", "2", "3", false)], { sourceMs: M1, targetMs: H1, expectedMembers: () => 60 });
    expect(r.ok && r.bars[0]!.extra).toMatchObject({ bid_o: null, ask_c: null, spread_c: null });
    expect(r.ok && r.bars[0]!.members).toBe(2);
  });

  it("splits buckets on the grid and keeps a late member's availability", () => {
    const late = { ...m1(59, "2", "3", "1", "2"), availableAt: T0 + H1 + 5_000 };
    const r = aggregateBars([m1(0, "1", "2", "1", "2"), late, m1(60, "2", "2", "2", "2")], { sourceMs: M1, targetMs: H1 });
    expect(r.ok && r.bars.map((b) => [b.openTime, b.members, b.availableAt, b.complete])).toEqual([
      [T0, 2, T0 + H1 + 5_000, false],
      [T0 + H1, 1, T0 + 2 * H1, false],
    ]);
  });

  it("refuses unordered, misaligned, invalid OHLC and bad intervals", () => {
    expect(aggregateBars([m1(1, "1", "2", "1", "2"), m1(0, "1", "2", "1", "2")], { sourceMs: M1, targetMs: H1 })).toMatchObject({ ok: false, reason: "NOT_INCREASING" });
    expect(aggregateBars([{ ...m1(0, "1", "2", "1", "2"), openTime: T0 + 30_000 }], { sourceMs: M1, targetMs: H1 })).toMatchObject({ ok: false, reason: "MISALIGNED" });
    expect(aggregateBars([m1(0, "1", "0.5", "1", "2")], { sourceMs: M1, targetMs: H1 })).toMatchObject({ ok: false, reason: "INVALID_OHLC" });
    expect(aggregateBars([m1(0, "1", "2", "1", "2")], { sourceMs: M1, targetMs: 90_000 })).toMatchObject({ ok: false, reason: "INVALID_INTERVAL" });
    expect(aggregateBars([], { sourceMs: M1, targetMs: H1 })).toMatchObject({ ok: false, reason: "EMPTY" });
  });

  it("supports a non-UTC anchor (e.g. 17:00 New York daily buckets)", () => {
    const anchor = Date.UTC(2026, 10, 16, 22, 0); // 17:00 New York (EST)
    const r = aggregateBars([{ ...m1(0, "1", "2", "1", "2"), openTime: anchor + 5 * M1, availableAt: anchor + 6 * M1 }], { sourceMs: M1, targetMs: 86_400_000, anchorMs: anchor });
    expect(r.ok && r.bars[0]!.openTime).toBe(anchor);
  });
});
