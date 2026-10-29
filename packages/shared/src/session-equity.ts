import { d, usd } from "./money.js";

/**
 * Roll session-start equity at UTC midnight when the calendar day changes.
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
    const start = startOfUtcDay(input.now);
    return {
      sessionStartedAt: start,
      sessionStartEquityUsd: usd(d(equity)),
      highWaterMarkUsd: hwm,
      rolled: true,
      dailyPnlUsd: input.currentEquityUsd == null ? null : "0.00000000",
    };
  }

  const sessionDay = startOfUtcDay(input.sessionStartedAt).getTime();
  const today = startOfUtcDay(input.now).getTime();
  if (today > sessionDay) {
    return {
      sessionStartedAt: startOfUtcDay(input.now),
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

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** True when `now` is on a later UTC calendar day than `sessionStartedAt`. */
export function isUtcMidnightRollover(sessionStartedAt: Date, now: Date): boolean {
  return startOfUtcDay(now).getTime() > startOfUtcDay(sessionStartedAt).getTime();
}
