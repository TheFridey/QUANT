import type { MarketCalendar } from "./regime.js";

/**
 * Exchange-session calendars for the GENESIS ML pipeline's bar-integrity and label-gap checks.
 *
 * CRYPTO_24_7: every interval prints; bars sit on one fixed UTC grid and a missing bar is a gap.
 * US_EQUITY: sessions are NYSE trading days in America/New_York. Daily bars open at New York midnight (05:00 UTC
 * in winter, 04:00 UTC in summer), so a fixed UTC grid would reject every bar after a DST change. Weekends and
 * NYSE holidays are not gaps; a missing trading day is. Intraday equity bars align to the interval in New York
 * local time, and the step from a session's last bar to the next session's first bar is not a gap.
 *
 * The holiday table is rule-based (full-day NYSE closures, plus the listed special closures); early closes do
 * not matter at this resolution. A bar dated on a computed holiday or a weekend is refused as OFF_SESSION.
 *
 * FX_24_5 (spot FX and spot metals, HORIZON): the market runs Sunday 17:00 to Friday 17:00 America/New_York in
 * "trading days" that roll at 17:00 New York (trading day D runs from D-1 17:00 to D 17:00 New York time), so the
 * UTC boundary is 21:00 during US daylight saving time and 22:00 otherwise. The 17:00-18:00 New York hour that
 * starts every trading day is the dealers' rollover/maintenance window, and the 25 Dec and 1 Jan trading days are
 * treated as closed. A bar opening in the weekend closure is refused as OFF_SESSION. A bar printed in the
 * maintenance hour or on a holiday is accepted (feeds print them), but it is not a tradeable bar
 * (`fxSessionState`), and a missing bar there is not a gap. Daily bars follow the market convention (OANDA
 * `dailyAlignment=17`, `alignmentTimezone=America/New_York`): each opens at 17:00 New York and is dated by the
 * trading day it closes; a daily bar opening at any other time is MISALIGNED. US DST changes happen at 02:00 on
 * a Sunday, inside the weekend closure, so every trading day is exactly 24 hours long.
 * (horizon-calendar 1.0.0 used a fixed 22:00 UTC roll and refused real summer Sunday-open bars; replaced.)
 */

export type SessionCalendar = "CRYPTO_24_7" | "US_EQUITY" | "FX_24_5";

export function toSessionCalendar(c: SessionCalendar | MarketCalendar | undefined): SessionCalendar {
  if (c === "US_EQUITY" || c === "WEEKDAYS") return "US_EQUITY";
  if (c === "FX_24_5") return "FX_24_5";
  return "CRYPTO_24_7";
}

/** The regime engine's coarser calendar for a session calendar. */
export function regimeCalendarFor(c: SessionCalendar): MarketCalendar {
  return c === "CRYPTO_24_7" ? "CONTINUOUS" : "WEEKDAYS";
}

export type FxSessionState = "OPEN" | "MAINTENANCE" | "HOLIDAY" | "WEEKEND";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FX_HOLIDAYS = new Set(["12-25", "01-01"]);

function nthSundayUtc(year: number, month0: number, n: number): number {
  const first = Date.UTC(year, month0, 1);
  return first + ((7 - new Date(first).getUTCDay()) % 7) * DAY_MS + (n - 1) * 7 * DAY_MS;
}

/** US Eastern daylight time in force at `t` (2007+ rule: second Sunday of March to first Sunday of November, 02:00 local). */
export function usEasternDst(t: number): boolean {
  const y = new Date(t).getUTCFullYear();
  return t >= nthSundayUtc(y, 2, 2) + 7 * HOUR_MS && t < nthSundayUtc(y, 10, 1) + 6 * HOUR_MS;
}

/** New York wall-clock time of `t`, as a fake-UTC epoch (read it with getUTC*). Arithmetic, no Intl. */
function nyWall(t: number): number {
  return t - (usEasternDst(t) ? 4 : 5) * HOUR_MS;
}

/** Roll-shifted wall clock: New York time + 7 h, so 17:00 New York becomes 00:00 of the trading day it opens. */
function fxShifted(t: number): Date {
  return new Date(nyWall(t) + 7 * HOUR_MS);
}

/** The FX trading day (YYYY-MM-DD) that the instant `t` belongs to: it rolls at 17:00 New York. */
export function fxTradingDay(t: number): string {
  return fxShifted(t).toISOString().slice(0, 10);
}

/** FX/metals session state of the instant `t` (17:00 New York roll, DST-aware). */
export function fxSessionState(t: number): FxSessionState {
  const shifted = fxShifted(t);
  const dow = shifted.getUTCDay();
  if (dow === 0 || dow === 6) return "WEEKEND";
  if (FX_HOLIDAYS.has(shifted.toISOString().slice(5, 10))) return "HOLIDAY";
  // 17:00-18:00 New York opens every trading day (00:00 in roll-shifted time).
  if (shifted.getUTCHours() === 0) return "MAINTENANCE";
  return "OPEN";
}

/** New York wall-clock hour (0-23) and weekday (0 = Sunday) of `t`. */
export function nyHourAndWeekday(t: number): { hour: number; weekday: number } {
  const w = new Date(nyWall(t));
  return { hour: w.getUTCHours(), weekday: w.getUTCDay() };
}

/** True when `t` is exactly 17:00:00.000 New York time: the open of an FX/metals daily bar. */
export function isFxDailyOpen(t: number): boolean {
  return ((nyWall(t) % DAY_MS) + DAY_MS) % DAY_MS === 17 * HOUR_MS;
}

function fxTradingDayExpected(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !FX_HOLIDAYS.has(day.slice(5));
}

/** True when a bar of `barMs` opening at `t` is one the FX calendar expects to print (a missing one is a gap). */
function fxExpectsBar(t: number, barMs: number): boolean {
  if (barMs >= DAY_MS) return fxTradingDayExpected(fxTradingDay(t));
  return fxSessionState(t) === "OPEN";
}

/**
 * Number of bar slots of `barMs` from `fromT` to `toT` inclusive (both bar opens) that `calendar` expects to print.
 * CRYPTO_24_7 and US_EQUITY count every interval (the US intraday regime clock is unchanged); FX_24_5 skips the
 * weekend, the maintenance hour and holidays. Used so regime coverage is measured on the session grid.
 */
export function expectedBarCount(fromT: number, toT: number, barMs: number, calendar: SessionCalendar): number {
  if (calendar !== "FX_24_5") return Math.max(1, Math.round((toT - fromT) / barMs) + 1);
  if (barMs >= DAY_MS) {
    let n = 0;
    const last = fxTradingDay(toT);
    for (let day = fxTradingDay(fromT); day <= last; day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) if (fxTradingDayExpected(day)) n += 1;
    return Math.max(1, n);
  }
  let n = 0;
  for (let t = fromT; t <= toT; t += barMs) if (fxExpectsBar(t, barMs)) n += 1;
  return Math.max(1, n);
}

const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export type NyParts = { ymd: string; hour: number; minute: number; second: number; ms: number };

export function nyLocalParts(t: number): NyParts {
  const parts = Object.fromEntries(NY.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), ms: ((t % 1000) + 1000) % 1000 };
}

const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const utcDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function nthWeekday(y: number, m: number, weekday: number, n: number): Date {
  const first = utcDate(y, m, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(y, m, 1 + offset + 7 * (n - 1));
}

function lastWeekday(y: number, m: number, weekday: number): Date {
  const last = utcDate(y, m + 1, 0);
  return utcDate(y, m, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}

/** Gregorian Easter Sunday (anonymous algorithm). */
function easter(y: number): Date {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(y, month, day);
}

/** Saturday → Friday, Sunday → Monday. */
function observed(d: Date): Date {
  const w = d.getUTCDay();
  if (w === 6) return new Date(d.getTime() - 86_400_000);
  if (w === 0) return new Date(d.getTime() + 86_400_000);
  return d;
}

const SPECIAL_CLOSURES = ["2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09"];

const holidayCache = new Map<number, Set<string>>();

/** Full-day NYSE closures in year `y` as YYYY-MM-DD. */
export function nyseHolidays(y: number): Set<string> {
  const cached = holidayCache.get(y);
  if (cached) return cached;
  const days: Date[] = [];
  const ny = utcDate(y, 1, 1);
  // New Year's Day on a Saturday is not observed on the preceding Friday (NYSE rule).
  if (ny.getUTCDay() !== 6) days.push(observed(ny));
  if (y >= 1998) days.push(nthWeekday(y, 1, 1, 3)); // Martin Luther King Jr. Day
  days.push(nthWeekday(y, 2, 1, 3)); // Washington's Birthday
  days.push(new Date(easter(y).getTime() - 2 * 86_400_000)); // Good Friday
  days.push(lastWeekday(y, 5, 1)); // Memorial Day
  if (y >= 2022) days.push(observed(utcDate(y, 6, 19))); // Juneteenth
  days.push(observed(utcDate(y, 7, 4)));
  days.push(nthWeekday(y, 9, 1, 1)); // Labor Day
  days.push(nthWeekday(y, 11, 4, 4)); // Thanksgiving
  days.push(observed(utcDate(y, 12, 25)));
  const set = new Set(days.map(ymdOf).filter((d) => d.startsWith(`${y}-`)));
  for (const s of SPECIAL_CLOSURES) if (s.startsWith(`${y}-`)) set.add(s);
  holidayCache.set(y, set);
  return set;
}

export function isUsEquitySessionDate(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00Z`);
  const w = d.getUTCDay();
  return w !== 0 && w !== 6 && !nyseHolidays(d.getUTCFullYear()).has(ymd);
}

export function nextUsEquitySessionDate(ymd: string): string {
  let d = new Date(`${ymd}T00:00:00Z`);
  for (let k = 0; k < 15; k += 1) {
    d = new Date(d.getTime() + 86_400_000);
    const s = ymdOf(d);
    if (isUsEquitySessionDate(s)) return s;
  }
  throw new Error(`no US equity session within 15 days after ${ymd}`);
}

/** Why a bar's open time does not fit the calendar (null when it fits). */
export function sessionAlignmentIssue(t: number, barMs: number, calendar: SessionCalendar, gridOrigin: number): { code: "MISALIGNED" | "OFF_SESSION"; detail: string } | null {
  if (calendar === "FX_24_5") {
    if (barMs >= DAY_MS) {
      // Market convention: daily bars open at 17:00 New York (21:00Z in US summer, 22:00Z in winter).
      if (!isFxDailyOpen(t)) return { code: "MISALIGNED", detail: `daily bar opens ${new Date(t).toISOString()}, not 17:00 New York (re-backfill with the New York 17:00 daily alignment)` };
      const day = fxTradingDay(t);
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      return dow === 0 || dow === 6 ? { code: "OFF_SESSION", detail: `daily bar for trading day ${day} falls in the FX weekend closure` } : null;
    }
    const off = barMs > 0 ? (((t - gridOrigin) % barMs) + barMs) % barMs : 0;
    if (off !== 0) return { code: "MISALIGNED", detail: `offset ${off} ms from the ${barMs} ms UTC grid` };
    // A bar is off-session only when it lies wholly in the closure (a UTC-aligned 4-hour bar may straddle the open).
    return fxSessionState(t) === "WEEKEND" && fxSessionState(t + barMs - 1) === "WEEKEND" ? { code: "OFF_SESSION", detail: `${new Date(t).toISOString()} is inside the FX weekend closure (Fri 17:00 to Sun 17:00 New York)` } : null;
  }
  if (calendar === "CRYPTO_24_7") {
    const off = (t - gridOrigin) % barMs;
    return barMs > 0 && off !== 0 ? { code: "MISALIGNED", detail: `offset ${off} ms from the ${barMs} ms UTC grid` } : null;
  }
  const p = nyLocalParts(t);
  if (!isUsEquitySessionDate(p.ymd)) return { code: "OFF_SESSION", detail: `${p.ymd} is not a NYSE trading day` };
  if (barMs >= 86_400_000) {
    if (p.hour || p.minute || p.second || p.ms) return { code: "MISALIGNED", detail: `daily bar opens ${p.ymd} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")} New York time, not midnight` };
    return null;
  }
  const msOfDay = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + p.ms;
  return msOfDay % barMs !== 0 ? { code: "MISALIGNED", detail: `opens ${msOfDay % barMs} ms off the ${barMs} ms New York-time grid` } : null;
}

/** True when `nextT` is the bar that should follow `prevT` with no missing bar in between. */
export function isContiguous(prevT: number, nextT: number, barMs: number, calendar: SessionCalendar): boolean {
  if (calendar === "CRYPTO_24_7") return nextT - prevT === barMs;
  if (calendar === "FX_24_5") {
    if (barMs >= DAY_MS) {
      // Daily bars: the next bar's trading day must be the next expected trading day (stepping by trading day, not
      // by 24 h of UTC, so the weekend DST change cannot shift the grid).
      const next = fxTradingDay(nextT);
      let day = fxTradingDay(prevT);
      for (let k = 0; k < 10; k += 1) {
        day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
        // A printed holiday bar is accepted in sequence; a missing one is skipped.
        if (day === next) return true;
        if (fxTradingDayExpected(day)) return false;
      }
      return false;
    }
    if (nextT - prevT === barMs) return true;
    // Skip only bars the calendar does not expect (weekend, maintenance hour, holiday trading days); bounded at
    // 10 days so a long outage is a gap, not a search.
    const limit = Math.min(nextT, prevT + 10 * DAY_MS);
    for (let t = prevT + barMs; t <= limit; t += barMs) {
      if (t === nextT) return true;
      if (fxExpectsBar(t, barMs)) return false;
    }
    return false;
  }
  const a = nyLocalParts(prevT).ymd;
  const b = nyLocalParts(nextT).ymd;
  if (barMs >= 86_400_000) return b === nextUsEquitySessionDate(a);
  if (nextT - prevT === barMs && a === b) return true;
  // Session boundary: the next bar is the first one printed in the next trading session.
  return b === nextUsEquitySessionDate(a);
}

/** Most ticks a weekend stub print may carry; real sessions carry thousands. */
export const WEEKEND_STUB_MAX_TICKS = 10;
/** Without a tick count, a weekend stub must be near-flat: high − low within this share of the close (5 bps). */
export const WEEKEND_STUB_MAX_RANGE = 0.0005;

export type StubExclusion = { t: number; reason: string };

/**
 * FX/metals providers occasionally print a stub bar after the Friday close (one to a few ticks, flat), which
 * dates into the weekend closure. Such a bar carries no tradeable information, so it is excluded and reported
 * rather than refusing the whole dataset. Any other off-session bar is kept, so validation still refuses it.
 */
export function excludeWeekendStubBars<B extends { t: number; high: number; low: number; close: number }>(
  bars: readonly B[],
  options: { barMs: number; calendar: SessionCalendar; tickVolumes?: ReadonlyArray<number | null>; availableAt?: readonly number[] },
): { bars: B[]; availableAt: number[] | undefined; excluded: StubExclusion[] } {
  if (options.calendar !== "FX_24_5" || bars.length === 0) {
    return { bars: [...bars], availableAt: options.availableAt ? [...options.availableAt] : undefined, excluded: [] };
  }
  const t0 = bars[0]!.t;
  const kept: B[] = [];
  const keptAvailable: number[] = [];
  const excluded: StubExclusion[] = [];
  bars.forEach((bar, i) => {
    const issue = sessionAlignmentIssue(bar.t, options.barMs, options.calendar, t0);
    const ticks = options.tickVolumes?.[i] ?? null;
    const range = bar.close > 0 ? (bar.high - bar.low) / bar.close : Infinity;
    const stub = ticks !== null ? ticks <= WEEKEND_STUB_MAX_TICKS : range <= WEEKEND_STUB_MAX_RANGE;
    if (issue?.code === "OFF_SESSION" && stub) {
      excluded.push({ t: bar.t, reason: ticks !== null ? `weekend stub: ${ticks} tick(s)` : `weekend stub: range ${(range * 10_000).toFixed(2)} bps` });
      return;
    }
    kept.push(bar);
    if (options.availableAt) keptAvailable.push(options.availableAt[i]!);
  });
  return { bars: kept, availableAt: options.availableAt ? keptAvailable : undefined, excluded };
}
