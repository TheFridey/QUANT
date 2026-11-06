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
 * FX_24_5 (spot FX and spot metals, HORIZON): the market runs Sunday 22:00 UTC to Friday 22:00 UTC in "trading
 * days" that roll at 22:00 UTC (trading day D runs from D-1 22:00 to D 22:00). The 21:00-22:00 UTC hour of every
 * trading day is the dealers' rollover/maintenance window, and the 25 Dec and 1 Jan trading days are treated as
 * closed. Assumption, stated rather than hidden: the roll is fixed at 22:00 UTC all year; in reality it follows
 * 17:00 New York, which is 21:00 UTC during US daylight saving time, so in summer the true maintenance hour is
 * 20:00-21:00 UTC and this calendar's window is one hour late. A bar opening in the weekend closure is refused as
 * OFF_SESSION. A bar printed in the maintenance hour or on a holiday is accepted (some feeds print them), but it is
 * not a tradeable bar (`fxSessionState`), and a missing bar there is not a gap.
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

const FX_ROLL_MS = 2 * 3_600_000;
const FX_HOLIDAYS = new Set(["12-25", "01-01"]);

/** The FX trading day (YYYY-MM-DD) that the instant `t` belongs to: it rolls at 22:00 UTC. */
export function fxTradingDay(t: number): string {
  return new Date(t + FX_ROLL_MS).toISOString().slice(0, 10);
}

/** FX/metals session state of the instant `t` (fixed 22:00 UTC roll; see the module comment for the DST caveat). */
export function fxSessionState(t: number): FxSessionState {
  const shifted = new Date(t + FX_ROLL_MS);
  const dow = shifted.getUTCDay();
  if (dow === 0 || dow === 6) return "WEEKEND";
  if (FX_HOLIDAYS.has(shifted.toISOString().slice(5, 10))) return "HOLIDAY";
  // 21:00 UTC is the last hour of the trading day (23:00 in roll-shifted time).
  if (shifted.getUTCHours() === 23) return "MAINTENANCE";
  return "OPEN";
}

/** True when a bar of `barMs` opening at `t` is one the FX calendar expects to print (a missing one is a gap). */
function fxExpectsBar(t: number, barMs: number): boolean {
  if (barMs >= 86_400_000) {
    const day = fxTradingDay(t);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6 && !FX_HOLIDAYS.has(day.slice(5));
  }
  return fxSessionState(t) === "OPEN";
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
    const off = barMs > 0 ? (((t - gridOrigin) % barMs) + barMs) % barMs : 0;
    if (off !== 0) return { code: "MISALIGNED", detail: `offset ${off} ms from the ${barMs} ms UTC grid` };
    const weekend = barMs >= 86_400_000 ? [0, 6].includes(new Date(`${fxTradingDay(t)}T00:00:00Z`).getUTCDay()) : fxSessionState(t) === "WEEKEND";
    return weekend ? { code: "OFF_SESSION", detail: `${new Date(t).toISOString()} is inside the FX weekend closure (Fri 22:00 to Sun 22:00 UTC)` } : null;
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
    if (nextT - prevT === barMs) return true;
    // Skip only bars the calendar does not expect (weekend, maintenance hour, holiday trading days); bounded at
    // 10 days so a long outage is a gap, not a search.
    const limit = Math.min(nextT, prevT + 10 * 86_400_000);
    for (let t = prevT + barMs; t <= limit; t += barMs) {
      if (fxExpectsBar(t, barMs)) return t === nextT;
    }
    return false;
  }
  const a =nyLocalParts(prevT).ymd;
  const b = nyLocalParts(nextT).ymd;
  if (barMs >= 86_400_000) return b === nextUsEquitySessionDate(a);
  if (nextT - prevT === barMs && a === b) return true;
  // Session boundary: the next bar is the first one printed in the next trading session.
  return b === nextUsEquitySessionDate(a);
}
