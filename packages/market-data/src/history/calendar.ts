import type { BarAlignment } from "./integrity.js";

/**
 * GENESIS Phase 3 trading calendars for dataset quality: which bar slots a source *should* have produced.
 * Research only; the live engine's entry sessions stay in `packages/shared/src/sessions.ts`.
 *
 * - CRYPTO_24_7: every slot is expected.
 * - US_EQUITY_NYSE: regular session 09:30–16:00 America/New_York on weekdays, minus the closures and
 *   13:00 early closes in `NYSE_SPECIAL_DAYS` (the single data table). Years outside
 *   `NYSE_COVERED_YEARS` fall back to weekday rules and are reported as calendar-incomplete.
 * - FX_24_5: open Sunday 17:00 to Friday 17:00 America/New_York (21:00Z or 22:00Z by US DST; no FX holidays
 *   modelled). Was a fixed 22:00 UTC boundary, which marked real summer Sunday-open bars as off-calendar.
 *
 * A slot [open, open + interval) is expected when it overlaps an open session. New York offsets use the
 * US DST rule in force since 2007 (second Sunday of March to first Sunday of November, 02:00 local), so the
 * result does not depend on the host's timezone database.
 */

export type CalendarId = "CRYPTO_24_7" | "US_EQUITY_NYSE" | "FX_24_5" | "UNKNOWN";

export type NyseSpecialDay = { date: string; status: "CLOSED" | "EARLY_CLOSE"; name: string };

export const NYSE_COVERED_YEARS: readonly number[] = [2021, 2022, 2023, 2024, 2025, 2026];

/** NYSE full closures and 13:00 ET early closes, 2021–2026 (observed dates). The only holiday data here. */
export const NYSE_SPECIAL_DAYS: readonly NyseSpecialDay[] = [
  { date: "2021-01-01", status: "CLOSED", name: "New Year's Day" },
  { date: "2021-01-18", status: "CLOSED", name: "Martin Luther King Jr. Day" },
  { date: "2021-02-15", status: "CLOSED", name: "Washington's Birthday" },
  { date: "2021-04-02", status: "CLOSED", name: "Good Friday" },
  { date: "2021-05-31", status: "CLOSED", name: "Memorial Day" },
  { date: "2021-07-05", status: "CLOSED", name: "Independence Day (observed)" },
  { date: "2021-09-06", status: "CLOSED", name: "Labor Day" },
  { date: "2021-11-25", status: "CLOSED", name: "Thanksgiving Day" },
  { date: "2021-11-26", status: "EARLY_CLOSE", name: "Day after Thanksgiving" },
  { date: "2021-12-24", status: "CLOSED", name: "Christmas Day (observed)" },
  { date: "2022-01-17", status: "CLOSED", name: "Martin Luther King Jr. Day" },
  { date: "2022-02-21", status: "CLOSED", name: "Washington's Birthday" },
  { date: "2022-04-15", status: "CLOSED", name: "Good Friday" },
  { date: "2022-05-30", status: "CLOSED", name: "Memorial Day" },
  { date: "2022-06-20", status: "CLOSED", name: "Juneteenth (observed)" },
  { date: "2022-07-04", status: "CLOSED", name: "Independence Day" },
  { date: "2022-09-05", status: "CLOSED", name: "Labor Day" },
  { date: "2022-11-24", status: "CLOSED", name: "Thanksgiving Day" },
  { date: "2022-11-25", status: "EARLY_CLOSE", name: "Day after Thanksgiving" },
  { date: "2022-12-26", status: "CLOSED", name: "Christmas Day (observed)" },
  { date: "2023-01-02", status: "CLOSED", name: "New Year's Day (observed)" },
  { date: "2023-01-16", status: "CLOSED", name: "Martin Luther King Jr. Day" },
  { date: "2023-02-20", status: "CLOSED", name: "Washington's Birthday" },
  { date: "2023-04-07", status: "CLOSED", name: "Good Friday" },
  { date: "2023-05-29", status: "CLOSED", name: "Memorial Day" },
  { date: "2023-06-19", status: "CLOSED", name: "Juneteenth" },
  { date: "2023-07-03", status: "EARLY_CLOSE", name: "Day before Independence Day" },
  { date: "2023-07-04", status: "CLOSED", name: "Independence Day" },
  { date: "2023-09-04", status: "CLOSED", name: "Labor Day" },
  { date: "2023-11-23", status: "CLOSED", name: "Thanksgiving Day" },
  { date: "2023-11-24", status: "EARLY_CLOSE", name: "Day after Thanksgiving" },
  { date: "2023-12-25", status: "CLOSED", name: "Christmas Day" },
  { date: "2024-01-01", status: "CLOSED", name: "New Year's Day" },
  { date: "2024-01-15", status: "CLOSED", name: "Martin Luther King Jr. Day" },
  { date: "2024-02-19", status: "CLOSED", name: "Washington's Birthday" },
  { date: "2024-03-29", status: "CLOSED", name: "Good Friday" },
  { date: "2024-05-27", status: "CLOSED", name: "Memorial Day" },
  { date: "2024-06-19", status: "CLOSED", name: "Juneteenth" },
  { date: "2024-07-03", status: "EARLY_CLOSE", name: "Day before Independence Day" },
  { date: "2024-07-04", status: "CLOSED", name: "Independence Day" },
  { date: "2024-09-02", status: "CLOSED", name: "Labor Day" },
  { date: "2024-11-28", status: "CLOSED", name: "Thanksgiving Day" },
  { date: "2024-11-29", status: "EARLY_CLOSE", name: "Day after Thanksgiving" },
  { date: "2024-12-24", status: "EARLY_CLOSE", name: "Christmas Eve" },
  { date: "2024-12-25", status: "CLOSED", name: "Christmas Day" },
  { date: "2025-01-01", status: "CLOSED", name: "New Year's Day" },
  { date: "2025-01-09", status: "CLOSED", name: "National Day of Mourning (President Carter)" },
  { date: "2025-01-20", status: "CLOSED", name: "Martin Luther King Jr. Day" },
  { date: "2025-02-17", status: "CLOSED", name: "Washington's Birthday" },
  { date: "2025-04-18", status: "CLOSED", name: "Good Friday" },
  { date: "2025-05-26", status: "CLOSED", name: "Memorial Day" },
  { date: "2025-06-19", status: "CLOSED", name: "Juneteenth" },
  { date: "2025-07-03", status: "EARLY_CLOSE", name: "Day before Independence Day" },
  { date: "2025-07-04", status: "CLOSED", name: "Independence Day" },
  { date: "2025-09-01", status: "CLOSED", name: "Labor Day" },
  { date: "2025-11-27", status: "CLOSED", name: "Thanksgiving Day" },
  { date: "2025-11-28", status: "EARLY_CLOSE", name: "Day after Thanksgiving" },
  { date: "2025-12-24", status: "EARLY_CLOSE", name: "Christmas Eve" },
  { date: "2025-12-25", status: "CLOSED", name: "Christmas Day" },
  { date: "2026-01-01", status: "CLOSED", name: "New Year's Day" },
  { date: "2026-01-19", status: "CLOSED", name: "Martin Luther King Jr. Day" },
  { date: "2026-02-16", status: "CLOSED", name: "Washington's Birthday" },
  { date: "2026-04-03", status: "CLOSED", name: "Good Friday" },
  { date: "2026-05-25", status: "CLOSED", name: "Memorial Day" },
  { date: "2026-06-19", status: "CLOSED", name: "Juneteenth" },
  { date: "2026-07-03", status: "CLOSED", name: "Independence Day (observed)" },
  { date: "2026-09-07", status: "CLOSED", name: "Labor Day" },
  { date: "2026-11-26", status: "CLOSED", name: "Thanksgiving Day" },
  { date: "2026-11-27", status: "EARLY_CLOSE", name: "Day after Thanksgiving" },
  { date: "2026-12-24", status: "EARLY_CLOSE", name: "Christmas Eve" },
  { date: "2026-12-25", status: "CLOSED", name: "Christmas Day" },
];

const NYSE_BY_DATE = new Map(NYSE_SPECIAL_DAYS.map((day) => [day.date, day]));
const NYSE_OPEN_MINUTE = 9 * 60 + 30;
const NYSE_CLOSE_MINUTE = 16 * 60;
const NYSE_EARLY_CLOSE_MINUTE = 13 * 60;
/** FX week: open Sunday 22:00 UTC, close Friday 22:00 UTC. */
/** FX week boundary in New York wall-clock minutes (17:00 New York: 21:00Z in US summer, 22:00Z in winter). */
const FX_BOUNDARY_MINUTE = 17 * 60;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Calendar for a warehouse `instrumentKind` (see HistoricalDataset). Unknown kinds get no expectation. */
export function calendarForInstrumentKind(kind: string): CalendarId {
  const k = kind.toUpperCase();
  if (k === "SOLANA_POOL" || k.startsWith("CRYPTO") || k === "SPOT_CRYPTO_PAIR") return "CRYPTO_24_7";
  if (k === "EQUITY_ETF" || k === "EQUITY_ETF_PROXY" || k === "EQUITY" || k === "EQUITY_INDEX") return "US_EQUITY_NYSE";
  if (k === "FX_PAIR" || k === "FX_SPOT") return "FX_24_5";
  return "UNKNOWN";
}

function nthSundayUtc(year: number, month0: number, n: number): number {
  const first = Date.UTC(year, month0, 1);
  const dow = new Date(first).getUTCDay();
  return first + ((7 - dow) % 7) * DAY + (n - 1) * WEEK;
}

/** Whether US Eastern daylight time is in force at `ms` (2007+ rule; transitions at 02:00 local). */
export function usEasternDst(ms: number): boolean {
  const year = new Date(ms).getUTCFullYear();
  const start = nthSundayUtc(year, 2, 2) + 7 * HOUR; // 02:00 EST
  const end = nthSundayUtc(year, 10, 1) + 6 * HOUR; // 02:00 EDT
  return ms >= start && ms < end;
}

/** America/New_York calendar date (YYYY-MM-DD) of an instant. */
export function newYorkDate(ms: number): string {
  const local = ms - (usEasternDst(ms) ? 4 : 5) * HOUR;
  return new Date(local).toISOString().slice(0, 10);
}

/** UTC instant of a New York wall-clock time (`minuteOfDay` minutes after local midnight) on `date`. */
export function newYorkWallToUtc(date: string, minuteOfDay: number): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minuteOfDay * MINUTE;
  const asDst = wall + 4 * HOUR;
  return usEasternDst(asDst) ? asDst : wall + 5 * HOUR;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function nyseCoversYear(year: number): boolean {
  return NYSE_COVERED_YEARS.includes(year);
}

/** NYSE regular session for a New York date, or null when the exchange is closed that day. */
export function nyseSession(date: string): { open: number; close: number; early: boolean } | null {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const special = NYSE_BY_DATE.get(date);
  if (special?.status === "CLOSED") return null;
  const early = special?.status === "EARLY_CLOSE";
  return { open: newYorkWallToUtc(date, NYSE_OPEN_MINUTE), close: newYorkWallToUtc(date, early ? NYSE_EARLY_CLOSE_MINUTE : NYSE_CLOSE_MINUTE), early };
}

export type NysePhase = "PRE" | "RTH" | "POST" | "CLOSED";

/**
 * Phase of the US equity day at `ms`: PRE (04:00 to the open), RTH (regular session), POST (close to 20:00),
 * or CLOSED (overnight, weekends, full closures). Early-close days end RTH at 13:00. Used to tag intraday
 * ETF bars so research can keep or drop extended-hours bars explicitly.
 */
export function nyseSessionPhase(ms: number): NysePhase {
  const date = newYorkDate(ms);
  const session = nyseSession(date);
  if (!session) return "CLOSED";
  if (ms >= session.open && ms < session.close) return "RTH";
  if (ms >= newYorkWallToUtc(date, 4 * 60) && ms < session.open) return "PRE";
  if (ms >= session.close && ms < newYorkWallToUtc(date, 20 * 60)) return "POST";
  return "CLOSED";
}

function fxClosedAt(ms: number): boolean {
  // New York wall clock: closed Friday 17:00 to Sunday 17:00 (21:00Z or 22:00Z by US DST).
  const d = new Date(ms - (usEasternDst(ms) ? 4 : 5) * HOUR);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow = d.getUTCDay();
  return dow === 6 || (dow === 5 && minute >= FX_BOUNDARY_MINUTE) || (dow === 0 && minute < FX_BOUNDARY_MINUTE);
}

/** Next FX reopening (Sunday 17:00 New York) at or after `ms`. */
function fxNextOpen(ms: number): number {
  const date = newYorkDate(ms);
  const sunday = addDays(date, (7 - new Date(`${date}T00:00:00Z`).getUTCDay()) % 7);
  const open = newYorkWallToUtc(sunday, FX_BOUNDARY_MINUTE);
  return open >= ms ? open : newYorkWallToUtc(addDays(sunday, 7), FX_BOUNDARY_MINUTE);
}

/** True when any part of [startMs, endMs) falls in an open session of `calendar`. */
export function sessionOverlaps(calendar: CalendarId, startMs: number, endMs: number): boolean {
  if (endMs <= startMs) return false;
  if (calendar === "CRYPTO_24_7" || calendar === "UNKNOWN") return true;
  if (calendar === "FX_24_5") {
    if (!fxClosedAt(startMs)) return true;
    return endMs > fxNextOpen(startMs);
  }
  // US equities: check every New York date the slot touches.
  const last = newYorkDate(endMs - 1);
  for (let date = newYorkDate(startMs); date <= last; date = addDays(date, 1)) {
    const session = nyseSession(date);
    if (session && session.open < endMs && session.close > startMs) return true;
  }
  return false;
}

export type ExpectedSlots = {
  calendar: CalendarId;
  alignment: BarAlignment;
  /** Expected bar open times, ascending. */
  openTimes: number[];
  /** False when part of the range lies in a year the holiday table does not cover. */
  calendarComplete: boolean;
  unknownYears: number[];
};

export class ExpectedSlotLimitExceeded extends Error {}

/**
 * Bar opens a source should produce in [fromOpenTime, toOpenTime] (both inclusive) for this calendar.
 * UTC_GRID enumerates multiples of the interval; NEW_YORK_DAY enumerates New York midnights (daily bars).
 */
export function expectedSlots(input: { calendar: CalendarId; intervalMs: number; alignment: BarAlignment; fromOpenTime: number; toOpenTime: number; maxSlots?: number }): ExpectedSlots {
  const { calendar, intervalMs, alignment, fromOpenTime, toOpenTime } = input;
  const maxSlots = input.maxSlots ?? 2_000_000;
  const openTimes: number[] = [];
  const years = new Set<number>();
  const push = (t: number) => {
    if (openTimes.length >= maxSlots) throw new ExpectedSlotLimitExceeded(`more than ${maxSlots} expected slots`);
    openTimes.push(t);
  };
  if (toOpenTime >= fromOpenTime) {
    if (alignment === "NEW_YORK_17") {
      // FX/metals daily bars: one per 17:00 New York roll whose 24 h overlaps an open session.
      const lastDate = newYorkDate(toOpenTime);
      for (let date = newYorkDate(fromOpenTime - DAY); date <= lastDate; date = addDays(date, 1)) {
        const open = newYorkWallToUtc(date, 17 * 60);
        if (open < fromOpenTime || open > toOpenTime) continue;
        if (sessionOverlaps(calendar, open, newYorkWallToUtc(addDays(date, 1), 17 * 60))) push(open);
      }
    } else if (alignment === "NEW_YORK_DAY") {
      const lastDate = newYorkDate(toOpenTime);
      for (let date = newYorkDate(fromOpenTime); date <= lastDate; date = addDays(date, 1)) {
        const open = newYorkWallToUtc(date, 0);
        if (open < fromOpenTime || open > toOpenTime) continue;
        years.add(Number(date.slice(0, 4)));
        if (sessionOverlaps(calendar, open, newYorkWallToUtc(addDays(date, 1), 0))) push(open);
      }
    } else {
      for (let t = Math.ceil(fromOpenTime / intervalMs) * intervalMs; t <= toOpenTime; t += intervalMs) {
        if (calendar === "US_EQUITY_NYSE") years.add(Number(newYorkDate(t).slice(0, 4)));
        if (sessionOverlaps(calendar, t, t + intervalMs)) push(t);
      }
    }
  }
  const unknownYears = calendar === "US_EQUITY_NYSE" ? [...years].filter((y) => !nyseCoversYear(y)).sort((a, b) => a - b) : [];
  return { calendar, alignment, openTimes, calendarComplete: calendar !== "UNKNOWN" && unknownYears.length === 0, unknownYears };
}
