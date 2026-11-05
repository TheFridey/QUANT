import { assertAllowlistedHttpsUrl, ALPACA_DATA_HOSTS_STRICT, type AllowedHost } from "../practice-url.js";
import type { BarAlignment, RawBar } from "./integrity.js";
import { nyseSessionPhase } from "./calendar.js";
import { OandaPracticeMarketData, type OandaGranularity } from "../providers/oanda-practice.js";

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

/** Alpaca stock data feeds. `sip` needs a paid plan; `delayed_sip` is the 15-minute-delayed consolidated feed. */
export type AlpacaFeed = "iex" | "sip" | "delayed_sip";

/** Retry delay from a 429: Retry-After seconds, else X-RateLimit-Reset (epoch seconds), else a minute. */
export function retryAfterMs(headers: Headers, nowMs: number = Date.now()): number {
  const after = Number(headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 300_000);
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset * 1000 > nowMs) return Math.min(reset * 1000 - nowMs, 300_000);
  return 60_000;
}

/**
 * Alpaca market-data v2 stock/ETF bars (`instrumentKey` = ticker). Uses the paper account's data keys and
 * (by default) the free IEX feed; prices are unadjusted (`adjustment=raw`) so corporate actions are
 * recorded, not silently rewritten. IEX is a single venue: volume is a fraction of consolidated volume.
 * Each bar records its feed in `extra.feed`; intraday bars also record their New York session phase in
 * `extra.nySession` (PRE/RTH/POST/CLOSED) so research can drop extended-hours bars explicitly. The source
 * id names the feed (`alpaca_iex`, `alpaca_delayed_sip`, …), so feeds never share a dataset.
 */
export class AlpacaBarsSource implements HistoricalBarSource {
  readonly id: string;
  readonly licence: SourceLicence;
  readonly maxRequestsPerMinute: number;
  private readonly feed: AlpacaFeed;

  constructor(
    private readonly credentials: { keyId: string | undefined; secret: string | undefined; dataUrl?: string },
    private readonly options: { fetchImpl?: typeof fetch; maxRequestsPerMinute?: number; feed?: AlpacaFeed; now?: () => number } = {},
  ) {
    // The free plan allows 200/min; research takes a small share so live quotes keep priority.
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 30;
    this.feed = options.feed ?? "iex";
    this.id = `alpaca_${this.feed}`;
    this.licence = {
      provider: `Alpaca Market Data (${this.feed.toUpperCase()} feed)`,
      terms: "Alpaca customer agreement; for the account holder's own use; no redistribution",
      attribution: null,
      redistribution: "NO",
    };
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
    url.searchParams.set("feed", this.feed);
    url.searchParams.set("sort", "asc");
    if (input.cursor) url.searchParams.set("page_token", input.cursor);
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json", "APCA-API-KEY-ID": this.credentials.keyId, "APCA-API-SECRET-KEY": this.credentials.secret },
      redirect: "error",
    });
    if (response.status === 429) return { ok: false, code: "RATE_LIMITED", error: "alpaca 429", retryAfterMs: retryAfterMs(response.headers, (this.options.now ?? Date.now)()) };
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
        extra: {
          trades: (row.n as number | undefined) ?? null,
          vwap: (row.vw as number | undefined) ?? null,
          feed: this.feed,
          ...(input.interval === "1d" ? {} : { nySession: nyseSessionPhase(t) }),
        },
      });
    }
    // Credentials are headers only; the request description carries no secret.
    return { ok: true, bars, nextCursor: payload.next_page_token ?? null, requestDescription: `${url.pathname}?${url.searchParams.toString()}`, payload };
  }
}

const OANDA_GRANULARITY: Record<HistoryInterval, OandaGranularity> = {
  "1m": "M1",
  "5m": "M5",
  "15m": "M15",
  "1h": "H1",
  "4h": "H4",
  "1d": "D",
};

const OANDA_PAGE_SIZE = 5000;

/**
 * OANDA v20 practice candles (`instrumentKey` = OANDA name such as EUR_USD or XAU_USD). Requests `price=MBA`:
 * the stored OHLC is the mid, and the bid and ask OHLC are kept in `extra` (`bid_o`…`ask_c`) with the spread
 * at the close. Volume is null because OANDA reports tick volume (kept as `extra.tickVolume`), not traded
 * volume. Daily and 4-hour candles are aligned to 00:00 UTC so they sit on the UTC grid. Only candles OANDA
 * marks complete are returned; availableAt is the candle close (applied by normaliseBars).
 * Pages forward from the window start with `from` + `count`; the cursor is the next `from` in epoch ms.
 */
export class OandaCandlesSource implements HistoricalBarSource {
  readonly id = "oanda_practice";
  readonly licence: SourceLicence = {
    provider: "OANDA fxTrade Practice (v20 REST)",
    terms: "OANDA practice account terms; for the account holder's own use; no redistribution",
    attribution: null,
    redistribution: "NO",
  };
  readonly maxRequestsPerMinute: number;

  constructor(
    private readonly credentials: { token: string | undefined; apiUrl?: string },
    private readonly options: { fetchImpl?: typeof fetch; maxRequestsPerMinute?: number; now?: () => Date } = {},
  ) {
    // OANDA allows far more; research stays small and polite.
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 30;
  }

  async fetchPage(input: { instrumentKey: string; interval: HistoryInterval; startMs: number; endMs: number; cursor: string | null }): Promise<SourcePage> {
    const token = this.credentials.token;
    const client = new OandaPracticeMarketData(
      { tokenPresent: Boolean(token), accountIdPresent: false, apiUrl: this.credentials.apiUrl ?? "https://api-fxpractice.oanda.com", accountId: "" },
      { fetchImpl: this.options.fetchImpl, now: this.options.now, token: () => token ?? "" },
    );
    const fromMs = input.cursor ? Number(input.cursor) : input.startMs;
    if (!Number.isFinite(fromMs)) return { ok: false, code: "INVALID", error: "oanda cursor is not epoch ms" };
    if (fromMs >= input.endMs) return { ok: true, bars: [], nextCursor: null, requestDescription: "(window exhausted)", payload: null };
    const result = await client.candles({ instrument: input.instrumentKey, granularity: OANDA_GRANULARITY[input.interval], price: "MBA", fromMs, count: OANDA_PAGE_SIZE });
    if (!result.ok) {
      const code = result.code === "AUTH_FAILED" ? "MISSING_CREDENTIALS" : result.code === "HTTP_ERROR" ? "HTTP_ERROR" : result.code;
      return { ok: false, code, error: result.error, ...(result.code === "RATE_LIMITED" ? { retryAfterMs: 60_000 } : {}) };
    }
    const { candles, request, payload } = result.data;
    const bars: RawBar[] = [];
    let lastOpen = Number.NEGATIVE_INFINITY;
    for (const candle of candles) {
      lastOpen = Math.max(lastOpen, candle.openTime);
      if (!candle.complete || !candle.mid) continue;
      if (candle.openTime < input.startMs || candle.openTime >= input.endMs) continue;
      const extra: Record<string, string | number | null> = { tickVolume: candle.tickVolume, priceComponents: "MBA" };
      for (const [side, ohlc] of [
        ["bid", candle.bid],
        ["ask", candle.ask],
      ] as const) {
        extra[`${side}_o`] = ohlc?.o ?? null;
        extra[`${side}_h`] = ohlc?.h ?? null;
        extra[`${side}_l`] = ohlc?.l ?? null;
        extra[`${side}_c`] = ohlc?.c ?? null;
      }
      extra.spread_c = candle.bid && candle.ask ? (Number(candle.ask.c) - Number(candle.bid.c)).toFixed(10).replace(/\.?0+$/, "") : null;
      bars.push({ openTime: candle.openTime, open: candle.mid.o, high: candle.mid.h, low: candle.mid.l, close: candle.mid.c, volume: null, extra });
    }
    const next = lastOpen + INTERVAL_MS[input.interval];
    // Short page or past the window end: done. An incomplete (in-progress) candle also ends the walk.
    const sawIncomplete = candles.some((c) => !c.complete);
    const done = candles.length < OANDA_PAGE_SIZE || !Number.isFinite(next) || next >= input.endMs || sawIncomplete;
    return { ok: true, bars, nextCursor: done ? null : String(next), requestDescription: request, payload };
  }
}
