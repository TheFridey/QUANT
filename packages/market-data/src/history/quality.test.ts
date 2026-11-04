import { describe, expect, it } from "vitest";
import { US_EQUITY_HOLIDAYS } from "@odin/shared";
import {
  NYSE_COVERED_YEARS,
  NYSE_SPECIAL_DAYS,
  expectedSlots,
  newYorkDate,
  newYorkWallToUtc,
  nyseSession,
  sessionOverlaps,
  usEasternDst,
} from "./calendar.js";
import { datasetVersionHash } from "./integrity.js";
import { datasetQualityReport, survivorshipSummary, type QualityBar, type QualityDataset } from "./quality.js";

const H = 3_600_000;
const D = 86_400_000;
const NY_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function bar(openTime: number, close = 1, intervalMs = H, volume: string | null = "10"): QualityBar {
  const c = String(close);
  return { openTime, availableAt: openTime + intervalMs, open: c, high: String(close * 1.01), low: String(close * 0.99), close: c, volume };
}

const crypto: QualityDataset = { id: "ds1", sourceId: "geckoterminal", instrumentKey: "POOL", instrumentKind: "SOLANA_POOL", cohort: "SPECULATIVE_SOLANA", interval: "1h", versionHash: null };
const spy: QualityDataset = { id: "ds2", sourceId: "alpaca_iex", instrumentKey: "SPY", instrumentKind: "EQUITY_ETF", cohort: "BROAD_ETF", interval: "1d", versionHash: null };

describe("GENESIS calendars", () => {
  it("New York offsets match the IANA database across DST transitions", () => {
    const instants = [
      Date.UTC(2026, 2, 8, 6, 59), Date.UTC(2026, 2, 8, 7, 0), Date.UTC(2026, 10, 1, 5, 59), Date.UTC(2026, 10, 1, 6, 0),
      Date.UTC(2021, 0, 4, 4, 30), Date.UTC(2024, 6, 1, 3, 59), Date.UTC(2025, 11, 31, 23, 0),
    ];
    for (const ms of instants) {
      const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
      expect(newYorkDate(ms)).toBe(`${parts.year}-${parts.month}-${parts.day}`);
    }
    expect(usEasternDst(Date.UTC(2026, 2, 8, 7, 0))).toBe(true);
    expect(usEasternDst(Date.UTC(2026, 2, 8, 6, 59))).toBe(false);
    expect(newYorkWallToUtc("2026-03-08", 0)).toBe(Date.UTC(2026, 2, 8, 5));
    expect(newYorkWallToUtc("2026-11-01", 0)).toBe(Date.UTC(2026, 10, 1, 4));
  });

  it("NYSE session opens an hour earlier in UTC after the spring DST change", () => {
    expect(nyseSession("2026-03-06")!.open).toBe(Date.UTC(2026, 2, 6, 14, 30));
    expect(nyseSession("2026-03-09")!.open).toBe(Date.UTC(2026, 2, 9, 13, 30));
    // Hourly slots on the DST Monday: 13:00Z (covers 09:30) … 19:00Z (covers to 16:00 = 20:00Z exclusive) = 7 slots.
    const monday = expectedSlots({ calendar: "US_EQUITY_NYSE", intervalMs: H, alignment: "UTC_GRID", fromOpenTime: Date.UTC(2026, 2, 9), toOpenTime: Date.UTC(2026, 2, 9, 23) });
    expect(monday.openTimes.map((t) => new Date(t).getUTCHours())).toEqual([13, 14, 15, 16, 17, 18, 19]);
    const friday = expectedSlots({ calendar: "US_EQUITY_NYSE", intervalMs: H, alignment: "UTC_GRID", fromOpenTime: Date.UTC(2026, 2, 6), toOpenTime: Date.UTC(2026, 2, 6, 23) });
    expect(friday.openTimes.map((t) => new Date(t).getUTCHours())).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it("skips NYSE holidays and weekends for daily bars, and honours early closes", () => {
    // 29 Jun – 10 Jul 2026: 10 weekdays, 3 Jul observed Independence Day.
    const slots = expectedSlots({ calendar: "US_EQUITY_NYSE", intervalMs: D, alignment: "NEW_YORK_DAY", fromOpenTime: newYorkWallToUtc("2026-06-29", 0), toOpenTime: newYorkWallToUtc("2026-07-10", 0) });
    expect(slots.openTimes).toHaveLength(9);
    expect(slots.openTimes.map(newYorkDate)).not.toContain("2026-07-03");
    expect(slots.calendarComplete).toBe(true);
    expect(nyseSession("2026-11-27")!.close).toBe(Date.UTC(2026, 10, 27, 18));
    expect(nyseSession("2025-01-09")).toBeNull();
  });

  it("reports years outside the holiday table as calendar-incomplete", () => {
    const slots = expectedSlots({ calendar: "US_EQUITY_NYSE", intervalMs: D, alignment: "NEW_YORK_DAY", fromOpenTime: newYorkWallToUtc("2027-01-04", 0), toOpenTime: newYorkWallToUtc("2027-01-08", 0) });
    expect(slots.calendarComplete).toBe(false);
    expect(slots.unknownYears).toEqual([2027]);
  });

  it("FX is closed Friday 22:00 UTC to Sunday 22:00 UTC", () => {
    expect(sessionOverlaps("FX_24_5", Date.UTC(2026, 9, 30, 21), Date.UTC(2026, 9, 30, 22))).toBe(true); // Fri 21:00
    expect(sessionOverlaps("FX_24_5", Date.UTC(2026, 9, 30, 22), Date.UTC(2026, 9, 30, 23))).toBe(false); // Fri 22:00
    expect(sessionOverlaps("FX_24_5", Date.UTC(2026, 10, 1, 21), Date.UTC(2026, 10, 1, 22))).toBe(false); // Sun 21:00
    expect(sessionOverlaps("FX_24_5", Date.UTC(2026, 10, 1, 22), Date.UTC(2026, 10, 1, 23))).toBe(true); // Sun 22:00
    const week = expectedSlots({ calendar: "FX_24_5", intervalMs: H, alignment: "UTC_GRID", fromOpenTime: Date.UTC(2026, 10, 1), toOpenTime: Date.UTC(2026, 10, 8) - H });
    expect(week.openTimes).toHaveLength(120); // 5 × 24 h trading week
  });

  it("crypto expects every slot", () => {
    expect(expectedSlots({ calendar: "CRYPTO_24_7", intervalMs: H, alignment: "UTC_GRID", fromOpenTime: 0, toOpenTime: 47 * H }).openTimes).toHaveLength(48);
  });

  it("the research holiday table agrees with the engine's session table for covered years", () => {
    const closed = new Set(NYSE_SPECIAL_DAYS.filter((d) => d.status === "CLOSED").map((d) => d.date));
    for (const date of US_EQUITY_HOLIDAYS) {
      if (NYSE_COVERED_YEARS.includes(Number(date.slice(0, 4)))) expect(closed.has(date)).toBe(true);
    }
    for (const day of NYSE_SPECIAL_DAYS) expect([1, 2, 3, 4, 5]).toContain(new Date(`${day.date}T00:00:00Z`).getUTCDay());
  });
});

describe("GENESIS dataset quality report", () => {
  const T0 = Date.UTC(2026, 9, 1);
  const asOf = T0 + 30 * H;

  it("finds calendar gaps and classifies a sparse DEX pool's holes as no-trade", () => {
    const bars = [0, 1, 2, 6, 7, 20].map((i) => bar(T0 + i * H));
    const report = datasetQualityReport({ dataset: { ...crypto, versionHash: datasetVersionHash(bars) }, bars, revisions: 0, rejectionsByReason: {}, asOf });
    expect(report.coverage).toMatchObject({ actualBars: 6, expectedBars: 21, missingBars: 15 });
    expect(report.versionHashMatches).toBe(true);
    expect(report.gaps.count).toBe(2);
    expect(report.gaps.byClass.NO_TRADE_LIKELY).toEqual({ count: 2, missingBars: 15 });
    expect(report.gaps.listed[0]).toMatchObject({ missingBars: 12, class: "NO_TRADE_LIKELY" });
    expect(report.flags).toContain("GAPS_NO_TRADE");
    expect(report.verdict).toBe("PASS");
  });

  it("treats a hole in a dense series as suspected missing data", () => {
    const bars = Array.from({ length: 100 }, (_, i) => i).filter((i) => i !== 50).map((i) => bar(T0 + i * H));
    const report = datasetQualityReport({ dataset: crypto, bars, revisions: 0, rejectionsByReason: {}, asOf: T0 + 101 * H });
    expect(report.gaps.byClass.MISSING_DATA_SUSPECTED).toEqual({ count: 1, missingBars: 1 });
    expect(report.verdict).toBe("WARN");
  });

  it("treats a missing session on a complete-session source as missing data, but not a holiday", () => {
    const days = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-06", "2026-07-08"].map((d) => newYorkWallToUtc(d, 0));
    const bars = days.map((t) => bar(t, 500, D));
    const report = datasetQualityReport({ dataset: spy, bars, revisions: 0, rejectionsByReason: {}, asOf: Date.UTC(2026, 6, 9, 12) });
    expect(report.coverage.expectedBars).toBe(7);
    expect(report.gaps.byClass.MISSING_DATA).toEqual({ count: 1, missingBars: 1 });
    expect(report.gaps.listed[0]!.fromOpenTime).toBe(new Date(newYorkWallToUtc("2026-07-07", 0)).toISOString());
    expect(report.verdict).toBe("FAIL");
  });

  it("flags a bar stamped on a holiday as off-calendar", () => {
    const bars = ["2026-07-02", "2026-07-03", "2026-07-06"].map((d) => bar(newYorkWallToUtc(d, 0), 500, D));
    const report = datasetQualityReport({ dataset: spy, bars, revisions: 0, rejectionsByReason: {}, asOf: Date.UTC(2026, 6, 7) });
    expect(report.coverage.offCalendarBars).toBe(1);
    expect(report.flags).toContain("OFF_CALENDAR_BARS");
  });

  it("detects duplicates and conflicting duplicates", () => {
    const bars = [bar(T0), bar(T0), bar(T0 + H), bar(T0 + H, 2), bar(T0 + 2 * H)];
    const report = datasetQualityReport({ dataset: crypto, bars, revisions: 0, rejectionsByReason: {}, asOf });
    expect(report.duplicates).toMatchObject({ count: 2, conflicting: 1 });
    expect(report.coverage.actualBars).toBe(3);
    expect(report.flags).toEqual(expect.arrayContaining(["DUPLICATE_BARS", "DUPLICATE_CONFLICTS"]));
    expect(report.verdict).toBe("FAIL");
  });

  it("reports OHLC violations, stale and zero-volume runs, revisions and rejections", () => {
    const broken = { ...bar(T0 + 3 * H), high: "0.5" };
    const flat = (i: number) => ({ openTime: T0 + i * H, availableAt: T0 + (i + 1) * H, open: "1", high: "1", low: "1", close: "1", volume: "0" });
    const bars = [bar(T0), flat(1), flat(2), broken, flat(4), flat(5), flat(6), flat(7)];
    const report = datasetQualityReport({ dataset: crypto, bars, revisions: 2, rejectionsByReason: { MISALIGNED: 3, NON_POSITIVE: 1 }, asOf, options: { minRunBars: 3 } });
    expect(report.ohlcViolations).toMatchObject({ count: 1, byKind: { HIGH_BELOW_BODY: 1 } });
    expect(report.staleRuns.count).toBe(1);
    expect(report.staleRuns.longest).toBe(4); // bars 4-7 repeat the previous close; the 2-bar run at 1-2 is below minRunBars
    expect(report.zeroVolumeRuns.longest).toBe(4);
    expect(report.rejections).toEqual({ total: 4, byReason: { MISALIGNED: 3, NON_POSITIVE: 1 } });
    expect(report.flags).toEqual(expect.arrayContaining(["OHLC_VIOLATIONS", "STALE_RUNS", "ZERO_VOLUME_RUNS", "REVISIONS_PRESENT", "REJECTIONS_PRESENT"]));
  });

  it("bounds listed arrays while keeping exact counts", () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(T0 + i * 3 * H));
    const report = datasetQualityReport({ dataset: crypto, bars, revisions: 0, rejectionsByReason: {}, asOf: T0 + 200 * H, options: { maxListed: 5 } });
    expect(report.gaps.count).toBe(39);
    expect(report.gaps.listed).toHaveLength(5);
    expect(report.gaps.truncated).toBe(true);
  });

  it("content hash is deterministic, order-independent and equals the warehouse version hash", () => {
    const bars = [0, 1, 2, 3].map((i) => bar(T0 + i * H, 1 + i / 10));
    const a = datasetQualityReport({ dataset: crypto, bars, revisions: 0, rejectionsByReason: {}, asOf });
    const b = datasetQualityReport({ dataset: crypto, bars: [...bars].reverse(), revisions: 0, rejectionsByReason: {}, asOf });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toBe(datasetVersionHash(bars));
    const changed = datasetQualityReport({ dataset: crypto, bars: [...bars.slice(0, 3), { ...bars[3]!, volume: "11" }], revisions: 0, rejectionsByReason: {}, asOf });
    expect(changed.contentHash).not.toBe(a.contentHash);
    expect(datasetQualityReport({ dataset: { ...crypto, versionHash: a.contentHash }, bars, revisions: 0, rejectionsByReason: {}, asOf }).versionHashMatches).toBe(true);
    const mismatch = datasetQualityReport({ dataset: { ...crypto, versionHash: "deadbeef" }, bars, revisions: 0, rejectionsByReason: {}, asOf });
    expect(mismatch.flags).toContain("VERSION_HASH_MISMATCH");
    expect(mismatch.verdict).toBe("FAIL");
  });

  it("flags survivorship: inactive candidates, the INACTIVE cohort, and a survivors-only universe", () => {
    const bars = [0, 1].map((i) => bar(T0 + i * H));
    const stale = datasetQualityReport({ dataset: crypto, bars, revisions: 0, rejectionsByReason: {}, asOf: T0 + 30 * D });
    expect(stale.survivorship.status).toBe("POSSIBLY_INACTIVE");
    expect(stale.flags).toContain("INACTIVE_CANDIDATE");
    const fresh = datasetQualityReport({ dataset: crypto, bars, revisions: 0, rejectionsByReason: {}, asOf: T0 + 3 * H });
    expect(fresh.survivorship.status).toBe("ACTIVE_AT_LAST_BAR");
    const inactive = datasetQualityReport({ dataset: { ...crypto, cohort: "INACTIVE" }, bars, revisions: 0, rejectionsByReason: {}, asOf: T0 + 30 * D });
    expect(inactive.survivorship.status).toBe("INACTIVE_COHORT");

    const universe = [
      { cohort: "LIQUID_MAJOR", interval: "1h", lastOpenTime: T0 },
      { cohort: "SPECULATIVE_SOLANA", interval: "5m", lastOpenTime: T0 - 60 * D },
    ];
    expect(survivorshipSummary(universe, T0 + H)).toMatchObject({ status: "SURVIVORS_ONLY", inactiveCohort: 0, possiblyInactive: 1 });
    expect(survivorshipSummary([...universe, { cohort: "INACTIVE", interval: "5m", lastOpenTime: T0 - 90 * D }], T0 + H).status).toBe("INACTIVE_COHORT_PRESENT");
    expect(survivorshipSummary([], T0).status).toBe("EMPTY");
  });

  it("returns no expectation for an unknown asset class rather than guessing", () => {
    const report = datasetQualityReport({ dataset: { ...crypto, instrumentKind: "COMMODITY_FUTURE" }, bars: [bar(T0), bar(T0 + 3 * H)], revisions: 0, rejectionsByReason: {}, asOf });
    expect(report.calendar.id).toBe("UNKNOWN");
    expect(report.coverage.expectedBars).toBeNull();
    expect(report.gaps.byClass.UNCLASSIFIED).toEqual({ count: 1, missingBars: 2 });
    expect(report.flags).toContain("CALENDAR_UNKNOWN");
  });
});
