import { d, usd } from "./money.js";

/**
 * Roll session-start equity at Europe/London midnight when the London calendar day changes.
 * The daily loss limit is a percentage of this start-of-day equity (audit L3).
 * HWM is ratcheted up only — never lowered on session roll.
 * Session-low equity ratchets down only within a London day and resets on the roll, so the
 * worst daily P&L latches the daily loss limit for the rest of the day (ASCEND-00 F1).
 */
export function rollSessionEquity(input: {
  now: Date;
  sessionStartedAt: Date | null;
  sessionStartEquityUsd: string | null;
  currentEquityUsd: string | null;
  highWaterMarkUsd: string | null;
  /** Lowest known equity this London day; null before the first known valuation. */
  sessionLowEquityUsd?: string | null;
  /**
   * False when current equity rests on marks that are not LIVE (stale, delayed, demo, replay). The
   * session low then does not ratchet from it, matching the LIVE/CASH_ONLY rule for daily P&L.
   */
  equityTrusted?: boolean;
  startingBalanceUsd: string;
}): {
  sessionStartedAt: Date;
  sessionStartEquityUsd: string;
  highWaterMarkUsd: string;
  /** Lowest known equity this London day; null when no equity has been known this day. */
  sessionLowEquityUsd: string | null;
  rolled: boolean;
  /** Daily PnL vs session-start equity; null when equity incomplete. */
  dailyPnlUsd: string | null;
  /** Worst daily PnL seen this London day (session low − session start); null when never known. */
  worstDailyPnlUsd: string | null;
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
      sessionLowEquityUsd: input.currentEquityUsd == null || input.equityTrusted === false ? null : usd(d(input.currentEquityUsd)),
      rolled: true,
      dailyPnlUsd: input.currentEquityUsd == null ? null : "0.00000000",
      worstDailyPnlUsd: input.currentEquityUsd == null ? null : "0.00000000",
    };
  }

  const sessionDay = startOfLondonDay(input.sessionStartedAt).getTime();
  const today = startOfLondonDay(input.now).getTime();
  if (today > sessionDay && input.currentEquityUsd == null) {
    // Never base a new day on startingBalanceUsd because marks are missing at the boundary (review F6).
    // Keep the old session, report daily P&L unavailable (entries blocked), and roll once equity is known.
    // The old day's low still applies until the roll happens.
    const low = input.sessionLowEquityUsd ?? null;
    return {
      sessionStartedAt: input.sessionStartedAt,
      sessionStartEquityUsd: input.sessionStartEquityUsd,
      highWaterMarkUsd: hwm,
      sessionLowEquityUsd: low,
      rolled: false,
      dailyPnlUsd: null,
      worstDailyPnlUsd: low == null ? null : usd(d(low).minus(d(input.sessionStartEquityUsd))),
    };
  }
  if (today > sessionDay) {
    return {
      sessionStartedAt: startOfLondonDay(input.now),
      sessionStartEquityUsd: usd(d(equity)),
      highWaterMarkUsd: hwm,
      sessionLowEquityUsd: input.equityTrusted === false ? null : usd(d(equity)),
      rolled: true,
      dailyPnlUsd: "0.00000000",
      worstDailyPnlUsd: input.equityTrusted === false ? null : "0.00000000",
    };
  }

  const dailyPnlUsd =
    input.currentEquityUsd == null
      ? null
      : usd(d(input.currentEquityUsd).minus(d(input.sessionStartEquityUsd)));
  const low = lowerOf(input.sessionLowEquityUsd ?? null, input.equityTrusted === false ? null : input.currentEquityUsd);

  return {
    sessionStartedAt: input.sessionStartedAt,
    sessionStartEquityUsd: input.sessionStartEquityUsd,
    highWaterMarkUsd: hwm,
    sessionLowEquityUsd: low,
    rolled: false,
    dailyPnlUsd,
    worstDailyPnlUsd: low == null ? null : usd(d(low).minus(d(input.sessionStartEquityUsd))),
  };
}

function lowerOf(left: string | null, right: string | null): string | null {
  if (left == null) return right == null ? null : usd(d(right));
  if (right == null) return left;
  return usd(d(left).lte(right) ? d(left) : d(right));
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
