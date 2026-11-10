import { describe, expect, it } from "vitest";
import { excludeWeekendStubBars, validateResearchBars } from "../index.js";

const DAY = 86_400_000;
// OANDA 17:00 New York daily bars (EDT: 21:00 UTC); trading day D opens D-1 17:00 NY.
const bar = (iso: string, o: number, h: number, l: number, c: number) => ({ t: Date.parse(iso), open: o, high: h, low: l, close: c, volume: null });
const week = [
  bar("2017-10-01T21:00:00Z", 112.5, 112.9, 112.3, 112.6), // Sun open → trading day Mon 2 Oct
  bar("2017-10-02T21:00:00Z", 112.6, 113.0, 112.4, 112.8),
  bar("2017-10-03T21:00:00Z", 112.8, 113.1, 112.5, 112.7),
  bar("2017-10-04T21:00:00Z", 112.7, 113.2, 112.6, 113.0),
  bar("2017-10-05T21:00:00Z", 113.0, 113.4, 112.4, 112.6),
  bar("2017-10-06T21:00:00Z", 112.65, 112.65, 112.65, 112.65), // Fri 17:00 NY → trading day Sat 7 Oct: stub print
  bar("2017-10-08T21:00:00Z", 112.6, 112.9, 112.3, 112.7),
];

describe("weekend stub exclusion (FX_24_5)", () => {
  it("excludes a one-tick weekend print and leaves a series that validates", () => {
    const ticks = [90_000, 85_000, 88_000, 87_000, 91_000, 1, 86_000];
    const availableAt = week.map((b) => b.t + DAY);
    const out = excludeWeekendStubBars(week, { barMs: DAY, calendar: "FX_24_5", tickVolumes: ticks, availableAt });
    expect(out.excluded).toEqual([{ t: Date.parse("2017-10-06T21:00:00Z"), reason: "weekend stub: 1 tick(s)" }]);
    expect(out.bars).toHaveLength(6);
    expect(out.availableAt).toHaveLength(6);
    expect(validateResearchBars(week, { barMs: DAY, calendar: "FX_24_5" }).map((i) => i.code)).toContain("OFF_SESSION");
    expect(validateResearchBars(out.bars, { barMs: DAY, calendar: "FX_24_5", availableAt: out.availableAt })).toEqual([]);
  });

  it("keeps an active weekend bar so validation still refuses it", () => {
    const active = [...week];
    active[5] = bar("2017-10-06T21:00:00Z", 112.65, 113.4, 112.1, 113.2);
    const byTicks = excludeWeekendStubBars(active, { barMs: DAY, calendar: "FX_24_5", tickVolumes: [1, 1, 1, 1, 1, 5_000, 1] });
    expect(byTicks.excluded).toEqual([]);
    const byRange = excludeWeekendStubBars(active, { barMs: DAY, calendar: "FX_24_5" });
    expect(byRange.excluded).toEqual([]);
    expect(validateResearchBars(byRange.bars, { barMs: DAY, calendar: "FX_24_5" }).map((i) => i.code)).toContain("OFF_SESSION");
  });

  it("uses a near-flat range when no tick count is available, and never touches other calendars", () => {
    const out = excludeWeekendStubBars(week, { barMs: DAY, calendar: "FX_24_5" });
    expect(out.excluded.map((e) => e.reason)).toEqual(["weekend stub: range 0.00 bps"]);
    expect(excludeWeekendStubBars(week, { barMs: DAY, calendar: "CRYPTO_24_7" }).excluded).toEqual([]);
  });
});
