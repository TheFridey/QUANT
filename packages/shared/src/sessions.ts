import type { SessionKind } from "./instruments.js";

export type SessionStatus = "OPEN" | "CLOSED" | "UNKNOWN";

export type SessionEval = {
  status: SessionStatus;
  reason: string;
  /** ISO weekday 0=Sun … 6=Sat in the session timezone. */
  weekday: number;
  hour: number;
  minute: number;
};

/**
 * Evaluate whether a market session is open at `now`.
 * CRYPTO_24x7 is always open. Index RTH uses America/New_York approximate hours
 * (09:30–16:00 ET, Mon–Fri) without holiday calendars — holidays stay UNKNOWN→treat as closed for entries.
 */
export function evaluateSession(input: {
  session: SessionKind;
  now: Date;
}): SessionEval {
  if (input.session === "CRYPTO_24x7") {
    const parts = etParts(input.now);
    return { status: "OPEN", reason: "CRYPTO_24x7", ...parts };
  }
  const parts = etParts(input.now);
  if (parts.weekday === 0 || parts.weekday === 6) {
    return { status: "CLOSED", reason: "WEEKEND", ...parts };
  }
  const minutes = parts.hour * 60 + parts.minute;
  if (input.session === "FX_WEEKDAY") {
    // Approximate FX weekday session in ET (Sun open handled as Mon–Fri for MVP).
    return { status: "OPEN", reason: "FX_WEEKDAY", ...parts };
  }
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

function etParts(now: Date): { weekday: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: map[weekdayName] ?? 0, hour, minute };
}
