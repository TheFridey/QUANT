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
} {
  const equity = input.currentEquityUsd ?? input.startingBalanceUsd;
  const hwmBase = input.highWaterMarkUsd ?? equity;
  const hwm = usd(d(hwmBase).gte(equity) ? d(hwmBase) : d(equity));

  if (!input.sessionStartedAt || !input.sessionStartEquityUsd) {
    return {
      sessionStartedAt: startOfUtcDay(input.now),
      sessionStartEquityUsd: usd(d(equity)),
      highWaterMarkUsd: hwm,
      rolled: true,
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
    };
  }

  return {
    sessionStartedAt: input.sessionStartedAt,
    sessionStartEquityUsd: input.sessionStartEquityUsd,
    highWaterMarkUsd: hwm,
    rolled: false,
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
