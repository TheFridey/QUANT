import { d, usd } from "./money.js";

/**
 * Roll session-start equity at Europe/London midnight when the London calendar day changes.
 * The daily loss limit is a percentage of this start-of-day equity (audit L3).
 * HWM is ratcheted up only — never lowered on session roll.
 */
export function rollSessionEquity(input: {
  now: Date;
  sessionStartedAt: Date | null;
  sessionStartEquityUsd: string | null;
  currentEquityUsd: string | null;
  highWaterMarkUsd: string | null;
  startingBalanceUsd: string;
}): {
  sessionStartedAt: Date;
  sessionStartEquityUsd: string;
  highWaterMarkUsd: string;
  rolled: boolean;
  /** Daily PnL vs session-start equity; null when equity incomplete. */
  dailyPnlUsd: string | null;
} {
  const equity = input.currentEquityUsd ?? input.startingBalanceUsd;
  const hwmBase = input.highWaterMarkUsd ?? equity;
  const hwm = usd(d(hwmBase).gte(equity) ? d(hwmBase) : d(equity));

  if (!input.sessionStartedAt || !input.sessionStartEquityUsd) {
    const start = startOfLondonDay(input.now);
    return {
      sessionStartedAt: start,
      sessionStartEquityUsd: usd(d(equity)),
      highWaterMarkUsd: hwm,
      rolled: true,
      dailyPnlUsd: input.currentEquityUsd == null ? null : "0.00000000",
    };
  }

  const sessionDay = startOfLondonDay(input.sessionStartedAt).getTime();
  const today = startOfLondonDay(input.now).getTime();
  if (today > sessionDay) {
    return {
      sessionStartedAt: startOfLondonDay(input.now),
      sessionStartEquityUsd: usd(d(equity)),
      highWaterMarkUsd: hwm,
      rolled: true,
      dailyPnlUsd: input.currentEquityUsd == null ? null : "0.00000000",
    };
  }

  const dailyPnlUsd =
    input.currentEquityUsd == null
      ? null
      : usd(d(input.currentEquityUsd).minus(d(input.sessionStartEquityUsd)));

  return {
    sessionStartedAt: input.sessionStartedAt,
    sessionStartEquityUsd: input.sessionStartEquityUsd,
    highWaterMarkUsd: hwm,
    rolled: false,
    dailyPnlUsd,
  };
}

/** Same-day HWM ratchet without rolling the session window. */
export function ratchetHighWaterMark(currentHwmUsd: string | null, equityUsd: string | null): string | null {
  if (equityUsd == null) return currentHwmUsd;
  if (currentHwmUsd == null) return usd(d(equityUsd));
  return usd(d(currentHwmUsd).gte(equityUsd) ? d(currentHwmUsd) : d(equityUsd));
}

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** London wall-clock offset from UTC at `at`, in ms (0 in GMT, 3,600,000 in BST). */
function londonOffsetMs(at: Date): number {
  const parts = Object.fromEntries(londonParts.formatToParts(at).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of 00:00 Europe/London on the London calendar day containing `value`. */
export function startOfLondonDay(value: Date): Date {
  const parts = Object.fromEntries(londonParts.formatToParts(value).map((part) => [part.type, part.value]));
  const wallMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  // UK clocks change at 01:00 UTC, never at local midnight, so the offset an hour before is the midnight offset.
  return new Date(wallMidnight - londonOffsetMs(new Date(wallMidnight - 3_600_000)));
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** True when `now` is on a later UTC calendar day than `sessionStartedAt`. */
export function isUtcMidnightRollover(sessionStartedAt: Date, now: Date): boolean {
  return startOfUtcDay(now).getTime() > startOfUtcDay(sessionStartedAt).getTime();
}
