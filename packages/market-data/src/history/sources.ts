import { assertAllowlistedHttpsUrl, ALPACA_DATA_HOSTS_STRICT, type AllowedHost } from "../practice-url.js";
import type { BarAlignment, RawBar } from "./integrity.js";

/**
 * ASCEND-01 historical bar sources. Read-only GETs against documented public endpoints; no order flow.
 * Each page call returns raw bars plus the cursor for the next (older or newer) page. Credentials, when a
 * source needs them, are sent only to that source's allowlisted host and never appear in provenance.
 */

export type HistoryInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export const INTERVAL_MS: Record<HistoryInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export type SourcePage =
  | { ok: true; bars: RawBar[]; nextCursor: string | null; requestDescription: string; payload: unknown }
  | { ok: false; code: "RATE_LIMITED" | "HTTP_ERROR" | "INVALID" | "MISSING_CREDENTIALS" | "INVALID_CONFIGURATION"; error: string; retryAfterMs?: number };

export type SourceLicence = { provider: string; terms: string; attribution: string | null; redistribution: "NO" | "ATTRIBUTION" | "UNKNOWN" };

export interface HistoricalBarSource {
  readonly id: string;
  readonly licence: SourceLicence;
  /** Conservative request budget the backfill runner must respect. */
  readonly maxRequestsPerMinute: number;
  /** How this source stamps bar opens for an interval. Defaults to UTC_GRID. */
  barAlignment?(interval: HistoryInterval): BarAlignment;
  /**
   * One page of bars for `instrumentKey` in [startMs, endMs). `cursor` is opaque and comes from the
   * previous page; null starts a fresh window.
   */
  fetchPage(input: { instrumentKey: string; interval: HistoryInterval; startMs: number; endMs: number; cursor: string | null }): Promise<SourcePage>;
}

const GECKO_HOSTS: readonly AllowedHost[] = [{ hostname: "api.geckoterminal.com", port: 443 }];

const GECKO_TIMEFRAME: Partial<Record<HistoryInterval, { timeframe: "minute" | "hour" | "day"; aggregate: number }>> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "1d": { timeframe: "day", aggregate: 1 },
};

/**
 * GeckoTerminal public on-chain OHLCV for a Solana pool (`instrumentKey` = pool address). Pages backwards
 * with `before_timestamp`. `include_empty_intervals` stays false, so a pool's no-trade intervals appear as
 * gaps rather than as invented flat bars. History on the keyless tier is limited (about six months).
 */
export class GeckoTerminalPoolSource implements HistoricalBarSource {
  readonly id = "geckoterminal";
  readonly licence: SourceLicence = {
    provider: "GeckoTerminal (CoinGecko) public API",
    terms: "Keyless public tier; attribution to GeckoTerminal required; commercial redistribution not assumed",
    attribution: "Data: GeckoTerminal",
    redistribution: "ATTRIBUTION",
  };
  readonly maxRequestsPerMinute: number;

  constructor(
    private readonly options: { fetchImpl?: typeof fetch; baseUrl?: string; network?: string; maxRequestsPerMinute?: number } = {},
  ) {
    // The documented keyless limit is about 30/min; stay well under it on a shared VPS.
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 10;
  }

  async fetchPage(input: { instrumentKey: string; interval: HistoryInterval; startMs: number; endMs: number; cursor: string | null }): Promise<SourcePage> {
    const tf = GECKO_TIMEFRAME[input.interval];
    if (!tf) return { ok: false, code: "INVALID", error: `unsupported interval ${input.interval}` };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.instrumentKey)) return { ok: false, code: "INVALID", error: "pool address is not base58" };
    const base = this.options.baseUrl ?? "https://api.geckoterminal.com/api/v2";
    const checked = assertAllowlistedHttpsUrl(base, GECKO_HOSTS);
    if (!checked.ok) return { ok: false, code: "INVALID_CONFIGURATION", error: "geckoterminal base URL not allowlisted" };
    const before = input.cursor ? Number(input.cursor) : Math.floor(input.endMs / 1000);
    const url = new URL(`${base}/networks/${this.options.network ?? "solana"}/pools/${input.instrumentKey}/ohlcv/${tf.timeframe}`);
    url.searchParams.set("aggregate", String(tf.aggregate));
    url.searchParams.set("before_timestamp", String(before));
    url.searchParams.set("limit", "1000");
    url.searchParams.set("currency", "usd");
    url.searchParams.set("include_empty_intervals", "false");
    const response = await (this.options.fetchImpl ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "error" });
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      return { ok: false, code: "RATE_LIMITED", error: "geckoterminal 429", retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : 60_000 };
    }
    if (!response.ok) return { ok: false, code: "HTTP_ERROR", error: `geckoterminal http_${response.status}` };
    const payload = (await response.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
    const list = payload?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return { ok: false, code: "INVALID", error: "geckoterminal payload has no ohlcv_list" };
    const bars: RawBar[] = [];
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 6) return { ok: false, code: "INVALID", error: "geckoterminal ohlcv row malformed" };
      const ts = Number(row[0]) * 1000;
      if (ts < input.startMs || ts >= input.endMs) continue;
      bars.push({ openTime: ts, open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] ?? null });
    }
    const oldest = list.reduce((min: number, row) => Math.min(min, Number((row as unknown[])[0])), Number.POSITIVE_INFINITY);
    // Stop when the page was short or already reaches the window start.
    const done = list.length < 1000 || !Number.isFinite(oldest) || oldest * 1000 <= input.startMs;
    return {
      ok: true,
      bars,
      nextCursor: done ? null : String(oldest),
      requestDescription: `${url.pathname}?${url.searchParams.toString()}`,
      payload,
    };
  }
}

export type PoolReserve = { reserveUsd: number; fetchedAt: number; poolCreatedAt: string | null };

/**
 * Current whole-pool reserves in USD for a Solana pool (GeckoTerminal `reserve_in_usd`, the same meaning
 * as DexScreener `liquidityUsd`). A present-day value: callers must label it as such, never as history.
 */
export async function fetchGeckoTerminalPoolReserve(
  pool: string,
  options: { fetchImpl?: typeof fetch; baseUrl?: string; network?: string; now?: () => number } = {},
): Promise<{ ok: true; data: PoolReserve } | { ok: false; error: string }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) return { ok: false, error: "pool address is not base58" };
  const base = options.baseUrl ?? "https://api.geckoterminal.com/api/v2";
  if (!assertAllowlistedHttpsUrl(base, GECKO_HOSTS).ok) return { ok: false, error: "geckoterminal base URL not allowlisted" };
  const response = await (options.fetchImpl ?? fetch)(new URL(`${base}/networks/${options.network ?? "solana"}/pools/${pool}`), { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) return { ok: false, error: `geckoterminal http_${response.status}` };
  const payload = (await response.json()) as { data?: { attributes?: { reserve_in_usd?: unknown; pool_created_at?: unknown } } };
  const reserve = Number(payload?.data?.attributes?.reserve_in_usd);
  if (!Number.isFinite(reserve) || reserve <= 0) return { ok: false, error: "geckoterminal pool has no positive reserve_in_usd" };
  const created = payload.data?.attributes?.pool_created_at;
  return { ok: true, data: { reserveUsd: reserve, fetchedAt: (options.now ?? Date.now)(), poolCreatedAt: typeof created === "string" ? created : null } };
}

const ALPACA_TIMEFRAME: Partial<Record<HistoryInterval, string>> = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "1h": "1Hour",
  "4h": "4Hour",
  "1d": "1Day",
};

/**
 * Alpaca market-data v2 stock/ETF bars (`instrumentKey` = ticker). Uses the paper account's data keys and
 * the free IEX feed; prices are unadjusted (`adjustment=raw`) so corporate actions are recorded, not
 * silently rewritten. IEX is a single venue: volume is a fraction of consolidated volume.
 */
export class AlpacaBarsSource implements HistoricalBarSource {
  readonly id = "alpaca_iex";
  readonly licence: SourceLicence = {
    provider: "Alpaca Market Data (IEX feed)",
    terms: "Alpaca customer agreement; for the account holder's own use; no redistribution",
    attribution: null,
    redistribution: "NO",
  };
  readonly maxRequestsPerMinute: number;

  constructor(
    private readonly credentials: { keyId: string | undefined; secret: string | undefined; dataUrl?: string },
    private readonly options: { fetchImpl?: typeof fetch; maxRequestsPerMinute?: number; feed?: "iex" } = {},
  ) {
    // The free plan allows 200/min; research takes a small share so live quotes keep priority.
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 30;
  }

  barAlignment(interval: HistoryInterval): BarAlignment {
    return interval === "1d" ? "NEW_YORK_DAY" : "UTC_GRID";
  }

  async fetchPage(input: { instrumentKey: string; interval: HistoryInterval; startMs: number; endMs: number; cursor: string | null }): Promise<SourcePage> {
    if (!this.credentials.keyId || !this.credentials.secret) {
      return { ok: false, code: "MISSING_CREDENTIALS", error: "BLOCKED_EXTERNAL: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set" };
    }
    const base = this.credentials.dataUrl ?? "https://data.alpaca.markets";
    const checked = assertAllowlistedHttpsUrl(base, ALPACA_DATA_HOSTS_STRICT);
    if (!checked.ok) return { ok: false, code: "INVALID_CONFIGURATION", error: "alpaca data URL not allowlisted" };
    const timeframe = ALPACA_TIMEFRAME[input.interval];
    if (!timeframe) return { ok: false, code: "INVALID", error: `unsupported interval ${input.interval}` };
    if (!/^[A-Z.]{1,10}$/.test(input.instrumentKey)) return { ok: false, code: "INVALID", error: "ticker is not upper-case alphanumeric" };
    const url = new URL(`${base}/v2/stocks/bars`);
    url.searchParams.set("symbols", input.instrumentKey);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", new Date(input.startMs).toISOString());
    url.searchParams.set("end", new Date(input.endMs).toISOString());
    url.searchParams.set("limit", "10000");
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", this.options.feed ?? "iex");
    url.searchParams.set("sort", "asc");
    if (input.cursor) url.searchParams.set("page_token", input.cursor);
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json", "APCA-API-KEY-ID": this.credentials.keyId, "APCA-API-SECRET-KEY": this.credentials.secret },
      redirect: "error",
    });
    if (response.status === 429) return { ok: false, code: "RATE_LIMITED", error: "alpaca 429", retryAfterMs: 60_000 };
    if (!response.ok) return { ok: false, code: "HTTP_ERROR", error: `alpaca http_${response.status}` };
    const payload = (await response.json()) as { bars?: Record<string, unknown>; next_page_token?: string | null };
    const rows = payload?.bars?.[input.instrumentKey] ?? [];
    if (!Array.isArray(rows)) return { ok: false, code: "INVALID", error: "alpaca bars payload malformed" };
    const bars: RawBar[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const t = Date.parse(String(row.t));
      if (!Number.isFinite(t)) return { ok: false, code: "INVALID", error: "alpaca bar timestamp invalid" };
      bars.push({
        openTime: t,
        open: row.o as number,
        high: row.h as number,
        low: row.l as number,
        close: row.c as number,
        volume: (row.v as number | undefined) ?? null,
        extra: { trades: (row.n as number | undefined) ?? null, vwap: (row.vw as number | undefined) ?? null },
      });
    }
    // Credentials are headers only; the request description carries no secret.
    return { ok: true, bars, nextCursor: payload.next_page_token ?? null, requestDescription: `${url.pathname}?${url.searchParams.toString()}`, payload };
  }
}
