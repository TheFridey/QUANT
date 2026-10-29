import type { SessionKind } from "./instruments.js";

export type SessionStatus = "OPEN" | "CLOSED" | "UNKNOWN";

export type SessionEval = {
  status: SessionStatus;
  reason: string;
  /** ISO weekday 0=Sun … 6=Sat in the session timezone. */
  weekday: number;
  hour: number;
  minute: number;
  /** America/New_York calendar date YYYY-MM-DD for holiday/DST diagnostics. */
  etDate: string;
  /** Whether DST (EDT) is in effect for America/New_York at `now`. */
  dstActive: boolean;
};

/**
 * US equity cash-session holidays (NYSE-style) used for INDEX_RTH / INDEX_EXTENDED.
 * Static observed dates — not a full exchange calendar feed.
 * Entries beyond ~2027 should be refreshed by operators.
 */
export const US_EQUITY_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  "2025-01-01",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03", // observed Independence Day (Fri)
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18", // observed Juneteenth (Fri)
  "2027-07-05", // observed Independence Day (Mon)
  "2027-09-06",
  "2027-11-25",
  "2027-12-24", // observed Christmas (Fri)
]);

/**
 * Evaluate whether a market session is open at `now`.
 *
 * - CRYPTO_24x7: always open
 * - FX_WEEKDAY: open Sun 17:00 ET → Fri 17:00 ET (weekend closure depth); closed on FX weekend
 * - INDEX_RTH: Mon–Fri 09:30–16:00 ET excluding US equity holidays
 * - INDEX_EXTENDED: Mon–Fri 04:00–20:00 ET excluding US equity holidays
 *
 * Holidays outside the static table remain OPEN/CLOSED by clock rules only
 * (UNKNOWN is reserved for unparseable timezone parts).
 */
export function evaluateSession(input: {
  session: SessionKind;
  now: Date;
}): SessionEval {
  const parts = etParts(input.now);
  if (input.session === "CRYPTO_24x7") {
    return { status: "OPEN", reason: "CRYPTO_24x7", ...parts };
  }

  if (input.session === "FX_WEEKDAY") {
    return evaluateFxWeekday(parts);
  }

  // Equity cash sessions: weekends + known holidays close entries.
  if (parts.weekday === 0 || parts.weekday === 6) {
    return { status: "CLOSED", reason: "WEEKEND", ...parts };
  }
  if (US_EQUITY_HOLIDAYS.has(parts.etDate)) {
    return { status: "CLOSED", reason: "US_EQUITY_HOLIDAY", ...parts };
  }

  const minutes = parts.hour * 60 + parts.minute;
  if (input.session === "INDEX_RTH") {
    const open = 9 * 60 + 30;
    const close = 16 * 60;
    if (minutes >= open && minutes < close) {
      return { status: "OPEN", reason: "INDEX_RTH", ...parts };
    }
    return { status: "CLOSED", reason: "OUTSIDE_RTH", ...parts };
  }

  // INDEX_EXTENDED: 04:00–20:00 ET Mon–Fri
  const open = 4 * 60;
  const close = 20 * 60;
  if (minutes >= open && minutes < close) {
    return { status: "OPEN", reason: "INDEX_EXTENDED", ...parts };
  }
  return { status: "CLOSED", reason: "OUTSIDE_EXTENDED", ...parts };
}

export function entriesAllowedInSession(session: SessionKind, now: Date): boolean {
  return evaluateSession({ session, now }).status === "OPEN";
}

export function isUsEquityHoliday(etDate: string): boolean {
  return US_EQUITY_HOLIDAYS.has(etDate);
}

/**
 * FX spot weekday session in America/New_York:
 * open from Sunday 17:00 ET inclusive through Friday 17:00 ET exclusive.
 */
function evaluateFxWeekday(parts: ReturnType<typeof etParts>): SessionEval {
  const minutes = parts.hour * 60 + parts.minute;
  const friClose = 17 * 60;
  const sunOpen = 17 * 60;

  // Saturday always closed.
  if (parts.weekday === 6) {
    return { status: "CLOSED", reason: "FX_WEEKEND", ...parts };
  }
  // Friday after 17:00 ET closed until Sunday 17:00.
  if (parts.weekday === 5 && minutes >= friClose) {
    return { status: "CLOSED", reason: "FX_WEEKEND", ...parts };
  }
  // Sunday before 17:00 ET still weekend.
  if (parts.weekday === 0 && minutes < sunOpen) {
    return { status: "CLOSED", reason: "FX_WEEKEND", ...parts };
  }
  // Sunday >= 17:00 and Mon–Thu all day + Fri before 17:00 → open.
  if (parts.weekday === 0 || (parts.weekday >= 1 && parts.weekday <= 4) || (parts.weekday === 5 && minutes < friClose)) {
    return { status: "OPEN", reason: "FX_WEEKDAY", ...parts };
  }
  return { status: "CLOSED", reason: "FX_WEEKEND", ...parts };
}

function etParts(now: Date): {
  weekday: number;
  hour: number;
  minute: number;
  etDate: string;
  dstActive: boolean;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(now);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: map[weekdayName] ?? 0,
    hour,
    minute,
    etDate: `${year}-${month}-${day}`,
    dstActive: tzName.includes("EDT") || tzName.includes("Daylight"),
  };
}
