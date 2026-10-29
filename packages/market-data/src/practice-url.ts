/**
 * Exact HTTPS practice/data host allowlists (D10).
 * Substring checks are forbidden — live hosts hidden in path/query/userinfo must be rejected.
 */

export type AllowedHost = {
  hostname: string;
  /** Default 443 for https when omitted on the URL. */
  port: number;
  /** When true, http is also accepted (local test transports only). */
  allowHttp?: boolean;
};

export const ALPACA_PAPER_TRADE_HOSTS: readonly AllowedHost[] = [
  { hostname: "paper-api.alpaca.markets", port: 443 },
  { hostname: "localhost", port: 443, allowHttp: true },
  { hostname: "127.0.0.1", port: 443, allowHttp: true },
];

export const ALPACA_DATA_HOSTS: readonly AllowedHost[] = [
  { hostname: "data.alpaca.markets", port: 443 },
  { hostname: "localhost", port: 443, allowHttp: true },
  { hostname: "127.0.0.1", port: 443, allowHttp: true },
];

export const OANDA_PRACTICE_HOSTS: readonly AllowedHost[] = [
  { hostname: "api-fxpractice.oanda.com", port: 443 },
  { hostname: "localhost", port: 443, allowHttp: true },
  { hostname: "127.0.0.1", port: 443, allowHttp: true },
];

/** Hostnames that must never appear as the request host for practice adapters. */
export const LIVE_BROKER_HOSTS: readonly string[] = [
  "api.alpaca.markets",
  "api-fxtrade.oanda.com",
  "fxtrade.oanda.com",
];

export type PracticeUrlCheck =
  | { ok: true; url: URL; hostname: string; port: number }
  | { ok: false; reason: string };

function effectivePort(parsed: URL): number {
  if (parsed.port) return Number(parsed.port);
  if (parsed.protocol === "https:") return 443;
  if (parsed.protocol === "http:") return 80;
  return -1;
}

function haystackOutsideHost(parsed: URL): string {
  return [
    parsed.username,
    parsed.password,
    parsed.pathname,
    parsed.search,
    parsed.hash,
  ]
    .join("\0")
    .toLowerCase();
}

/**
 * Parse and validate a practice/data base URL against an exact host/port allowlist.
 * Rejects non-HTTPS (except allowHttp local), wrong hosts, and live hosts smuggled into path/query/userinfo.
 */
export function assertAllowlistedHttpsUrl(
  raw: string,
  allowlist: readonly AllowedHost[],
  options?: { rejectLiveHosts?: readonly string[] },
): PracticeUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "EMPTY_URL" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "UNPARSEABLE_URL" };
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = effectivePort(parsed);
  const rejectLive = options?.rejectLiveHosts ?? LIVE_BROKER_HOSTS;

  for (const live of rejectLive) {
    const liveLower = live.toLowerCase();
    if (hostname === liveLower) {
      return { ok: false, reason: `LIVE_HOST_REJECTED:${live}` };
    }
  }

  const outside = haystackOutsideHost(parsed);
  for (const live of rejectLive) {
    if (outside.includes(live.toLowerCase())) {
      return { ok: false, reason: `LIVE_HOST_IN_PATH:${live}` };
    }
  }
  // Also reject practice markers used only as path decoration on an arbitrary host
  // (e.g. https://evil.example/paper-api.alpaca.markets) — already covered when live
  // hosts appear in path; additionally reject when allowlisted hostname is only in path.
  for (const allowed of allowlist) {
    if (hostname !== allowed.hostname.toLowerCase() && outside.includes(allowed.hostname.toLowerCase())) {
      return { ok: false, reason: `ALLOWLIST_HOST_IN_PATH:${allowed.hostname}` };
    }
  }

  const match = allowlist.find(
    (entry) => entry.hostname.toLowerCase() === hostname && entry.port === port,
  );
  if (!match) {
    return { ok: false, reason: `HOST_NOT_ALLOWLISTED:${hostname}:${port}` };
  }

  if (parsed.protocol === "https:") {
    return { ok: true, url: parsed, hostname, port };
  }
  if (parsed.protocol === "http:" && match.allowHttp) {
    return { ok: true, url: parsed, hostname, port };
  }
  return { ok: false, reason: `SCHEME_REJECTED:${parsed.protocol}` };
}

export type QuoteCompletenessInput = {
  bid: number | string | null | undefined;
  ask: number | string | null | undefined;
  eventTime?: string | null;
  now?: Date;
  /** Max age of provider event time; defaults to 15 minutes. */
  maxEventAgeMs?: number;
};

export type QuoteCompletenessResult =
  | { ok: true; bid: number; ask: number; mid: number }
  | { ok: false; reason: string };

/**
 * Reject incomplete quotes: non-finite, non-positive, ask < bid, or stale event time.
 */
export function assertCompleteQuote(input: QuoteCompletenessInput): QuoteCompletenessResult {
  const bid = typeof input.bid === "string" ? Number(input.bid) : input.bid;
  const ask = typeof input.ask === "string" ? Number(input.ask) : input.ask;
  if (typeof bid !== "number" || typeof ask !== "number") {
    return { ok: false, reason: "MISSING_BID_ASK" };
  }
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return { ok: false, reason: "NON_FINITE_BID_ASK" };
  }
  if (!(bid > 0) || !(ask > 0)) {
    return { ok: false, reason: "NON_POSITIVE_BID_ASK" };
  }
  if (ask < bid) {
    return { ok: false, reason: "ASK_LT_BID" };
  }
  if (input.eventTime) {
    const eventMs = Date.parse(input.eventTime);
    if (!Number.isFinite(eventMs)) {
      return { ok: false, reason: "INVALID_EVENT_TIME" };
    }
    const now = input.now ?? new Date();
    const age = now.getTime() - eventMs;
    const maxAge = input.maxEventAgeMs ?? 15 * 60_000;
    if (age < 0) return { ok: false, reason: "FUTURE_EVENT_TIME" };
    if (age > maxAge) return { ok: false, reason: "STALE_EVENT_TIME" };
  }
  return { ok: true, bid, ask, mid: (bid + ask) / 2 };
}
