import {
  SEED_INSTRUMENTS,
  canPaperExecute,
  describeQuoteQuality,
  evaluateSession,
  type Instrument,
  type ProviderReadiness,
  type QuoteFeed,
  type QuoteQuality,
} from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "../market-provider.js";
import type { ProviderResult } from "../provider.js";
import {
  ALPACA_DATA_HOSTS_STRICT,
  ALPACA_PAPER_TRADE_HOSTS_STRICT,
  assertAllowlistedHttpsUrl,
  assertCompleteQuote,
} from "../practice-url.js";
import { AlpacaBarsSource, retryAfterMs, type AlpacaFeed, type HistoryInterval } from "../history/sources.js";
import type { RawBar } from "../history/integrity.js";

export type AlpacaPaperCredentials = {
  apiKeyPresent: boolean;
  apiSecretPresent: boolean;
  baseUrl: string;
  dataUrl: string;
};

/**
 * Alpaca Markets Paper Trading adapter (US equities/ETFs).
 * Docs: https://docs.alpaca.markets/docs/trading-api
 * Paper base: https://paper-api.alpaca.markets
 * Requires ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY (paper keys).
 * Never places live-money orders; refuses when credentials missing.
 */
export class AlpacaPaperProvider implements MarketDataProvider {
  readonly id = "alpaca_paper" as const;
  private authFailed = false;
  private authenticatedOk = false;

  constructor(
    private readonly credentials: AlpacaPaperCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      /** Injected for offline contract tests — sanitised payloads only. */
      quoteFixture?: Record<string, { bid: string; ask: string; mid: string; eventTime?: string }>;
      /** Max quote event age before rejection (ms). */
      maxEventAgeMs?: number;
      /**
       * HORIZON: request this feed explicitly on the latest-quote call. Unset keeps the historical behaviour
       * (Alpaca picks the account default) and the quote's quality records the feed as unspecified.
       */
      feed?: AlpacaFeed;
    } = {},
  ) {}

  /** Mark AUTH_FAILED after an upstream 401/403 (D10). */
  noteAuthFailure(): void {
    this.authFailed = true;
    this.authenticatedOk = false;
  }

  noteAuthSuccess(): void {
    this.authFailed = false;
    this.authenticatedOk = true;
  }

  private urlsValid(): boolean {
    // Audit L5: strict allowlist — HTTPS to Alpaca's own paper/data hosts only; no localhost or plain HTTP,
    // so practice credentials can never be sent to another host.
    const trade = assertAllowlistedHttpsUrl(this.credentials.baseUrl, ALPACA_PAPER_TRADE_HOSTS_STRICT);
    const data = assertAllowlistedHttpsUrl(this.credentials.dataUrl, ALPACA_DATA_HOSTS_STRICT);
    return trade.ok && data.ok;
  }

  readiness(): ProviderReadiness {
    if (!this.credentials.apiKeyPresent || !this.credentials.apiSecretPresent) {
      return "MISSING_CREDENTIALS";
    }
    if (!this.urlsValid()) {
      return "INVALID_CONFIGURATION";
    }
    if (this.authFailed) {
      return "AUTH_FAILED";
    }
    // Offline fixtures are an explicit test transport — READY without network.
    if (this.options.quoteFixture) {
      return "READY";
    }
    // Key presence alone is not READY — require a successful authenticated response.
    if (!this.authenticatedOk) {
      return "CONNECTING";
    }
    return "READY";
  }

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter(
      (item) => item.assetClass === "EQUITY_ETF_PROXY" || item.providerId === "alpaca_paper",
    );
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS") {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error:
          "BLOCKED_EXTERNAL_TEST: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper). See docs/mvp/PROVIDER_CAPABILITIES.md",
      };
    }
    if (ready === "INVALID_CONFIGURATION") {
      return { ok: false, code: "UNAVAILABLE", error: `Alpaca paper readiness=${ready}` };
    }
    if (ready === "AUTH_FAILED") {
      return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: Alpaca rejected credentials" };
    }

    const now = (this.options.now ?? (() => new Date))();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));

    if (this.options.quoteFixture) {
      const data: InstrumentQuote[] = [];
      for (const instrument of instruments) {
        const fix = this.options.quoteFixture![instrument.symbol] ?? this.options.quoteFixture![instrument.id];
        const session = evaluateSession({ session: instrument.session, now });
        if (!fix) {
          data.push(empty(instrument, now, session.status, "alpaca:missing_fixture"));
          continue;
        }
        const complete = assertCompleteQuote({
          bid: fix.bid,
          ask: fix.ask,
          eventTime: fix.eventTime ?? now.toISOString(),
          now,
          maxEventAgeMs: this.options.maxEventAgeMs,
        });
        if (!complete.ok) {
          data.push(empty(instrument, now, session.status, `alpaca:rejected_quote:${complete.reason}`));
          continue;
        }
        data.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: "USD",
          dataState: "DEMO" as const,
          provenance: "alpaca_paper:offline_fixture — sanitised contract test; not live",
          session: session.status === "OPEN" ? ("OPEN" as const) : session.status === "CLOSED" ? ("CLOSED" as const) : ("UNKNOWN" as const),
          receivedAt: now.toISOString(),
          providerId: "alpaca_paper" as const,
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: fix.eventTime ?? now.toISOString(),
          quality: describeQuoteQuality({ source: "alpaca_paper", feed: "OFFLINE_FIXTURE", now, eventTime: fix.eventTime ?? null, bid: fix.bid, ask: fix.ask }),
        });
      }
      return { ok: true, fetchedAt: now.toISOString(), data };
    }

    // Network path: CONNECTING is allowed to attempt — success promotes to READY.
    if (ready !== "CONNECTING" && ready !== "READY") {
      return { ok: false, code: "UNAVAILABLE", error: `Alpaca paper readiness=${ready}` };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const quotes: InstrumentQuote[] = [];
    for (const instrument of instruments) {
      const session = evaluateSession({ session: instrument.session, now });
      try {
        const symbol = encodeURIComponent(instrument.providerSymbol || instrument.symbol);
        const feedParam = this.options.feed ? `?feed=${this.options.feed}` : "";
        const url = `${this.credentials.dataUrl.replace(/\/$/, "")}/v2/stocks/${symbol}/quotes/latest${feedParam}`;
        const response = await fetchImpl(url, {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "",
            "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "",
          },
        });
        if (response.status === 401 || response.status === 403) {
          this.noteAuthFailure();
          return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: Alpaca rejected credentials" };
        }
        if (!response.ok) {
          quotes.push(empty(instrument, now, session.status, `alpaca:http_${response.status}`));
          continue;
        }
        this.noteAuthSuccess();
        const body = (await response.json()) as {
          quote?: { bp?: number; ap?: number; t?: string };
        };
        const complete = assertCompleteQuote({
          bid: body.quote?.bp,
          ask: body.quote?.ap,
          eventTime: body.quote?.t ?? null,
          now,
          maxEventAgeMs: this.options.maxEventAgeMs,
        });
        if (!complete.ok) {
          quotes.push(empty(instrument, now, session.status, `alpaca:rejected_quote:${complete.reason}`));
          continue;
        }
        quotes.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: "USD",
          dataState: "DEMO",
          provenance: "alpaca_paper:latest_quote — paper/sandbox market data",
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: now.toISOString(),
          providerId: "alpaca_paper",
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: body.quote?.t ?? null,
          quality: describeQuoteQuality({
            source: "alpaca_paper",
            feed: this.options.feed ? ALPACA_QUALITY_FEED[this.options.feed] : "ALPACA_ACCOUNT_DEFAULT",
            now,
            eventTime: body.quote?.t ?? null,
            bid: body.quote?.bp,
            ask: body.quote?.ap,
          }),
        });
      } catch (error) {
        quotes.push(
          empty(instrument, now, session.status, `alpaca:error:${error instanceof Error ? error.message : "unknown"}`),
        );
      }
    }
    return { ok: true, fetchedAt: now.toISOString(), data: quotes };
  }

  async getSession(instrumentId: string): Promise<MarketSessionStatus> {
    const instrument = (await this.listInstruments()).find((item) => item.id === instrumentId);
    if (!instrument) return "UNKNOWN";
    const status = evaluateSession({
      session: instrument.session,
      now: (this.options.now ?? (() => new Date))(),
    }).status;
    return status === "OPEN" ? "OPEN" : status === "CLOSED" ? "CLOSED" : "UNKNOWN";
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS" || ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return {
        instrumentId,
        side,
        allowed: false,
        reasonCodes: [ready, "BLOCKED_EXTERNAL"],
      };
    }
    if (ready !== "READY" && ready !== "CONNECTING") {
      return { instrumentId, side, allowed: false, reasonCodes: [ready, "BLOCKED_EXTERNAL"] };
    }
    const instrument = SEED_INSTRUMENTS.find((item) => item.id === instrumentId);
    if (!instrument || !canPaperExecute(instrument)) {
      return { instrumentId, side, allowed: false, reasonCodes: ["NO_EXECUTION"] };
    }
    return { instrumentId, side, allowed: true, reasonCodes: ["EXTERNAL_DEMO"] };
  }

  /** Submit paper order — only when READY. Offline tests should mock fetch. Does not auto-fire from key presence. */
  async submitPaperOrder(input: {
    symbol: string;
    side: "buy" | "sell";
    qty: string;
    type?: "market" | "limit";
    clientOrderId: string;
    /** Optional bracket protection — desired until venue ACK; never invent success. */
    bracket?: { takeProfitLimit: string; stopLossStop: string };
  }): Promise<{ ok: true; brokerOrderId: string; status: string } | { ok: false; error: string; readiness: ProviderReadiness }> {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS" || ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return { ok: false, error: `Cannot submit: readiness=${ready}`, readiness: ready };
    }
    if (ready !== "READY" && ready !== "CONNECTING") {
      return { ok: false, error: `Cannot submit: readiness=${ready}`, readiness: ready };
    }
    if (!this.urlsValid()) {
      return { ok: false, error: "Cannot submit: INVALID_CONFIGURATION", readiness: "INVALID_CONFIGURATION" };
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      qty: input.qty,
      side: input.side,
      type: input.type ?? "market",
      time_in_force: "day",
      client_order_id: input.clientOrderId,
    };
    if (input.bracket) {
      body.order_class = "bracket";
      body.take_profit = { limit_price: input.bracket.takeProfitLimit };
      body.stop_loss = { stop_price: input.bracket.stopLossStop };
    }
    const response = await fetchImpl(`${this.credentials.baseUrl.replace(/\/$/, "")}/v2/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "",
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      this.noteAuthFailure();
      return { ok: false, error: "AUTH_FAILED: Alpaca rejected credentials", readiness: "AUTH_FAILED" };
    }
    if (!response.ok) {
      return { ok: false, error: `alpaca_submit:http_${response.status}`, readiness: this.readiness() };
    }
    this.noteAuthSuccess();
    const payload = (await response.json()) as { id?: string; status?: string };
    if (!payload.id) return { ok: false, error: "alpaca_submit:missing_id", readiness: this.readiness() };
    return { ok: true, brokerOrderId: payload.id, status: payload.status ?? "accepted" };
  }
}

export function inventoryAlpacaCredentials(env: NodeJS.ProcessEnv = process.env): AlpacaPaperCredentials {
  return {
    apiKeyPresent: Boolean(env.ALPACA_API_KEY_ID?.trim()),
    apiSecretPresent: Boolean(env.ALPACA_API_SECRET_KEY?.trim()),
    baseUrl: env.ALPACA_PAPER_BASE_URL?.trim() || "https://paper-api.alpaca.markets",
    dataUrl: env.ALPACA_DATA_BASE_URL?.trim() || "https://data.alpaca.markets",
  };
}

function empty(
  instrument: Instrument,
  now: Date,
  sessionStatus: string,
  provenance: string,
): InstrumentQuote {
  return {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    level: null,
    currency: "USD",
    dataState: "DEMO",
    provenance: `${provenance} — null; never invent`,
    session: sessionStatus === "OPEN" ? "OPEN" : sessionStatus === "CLOSED" ? "CLOSED" : "UNKNOWN",
    receivedAt: now.toISOString(),
    providerId: "alpaca_paper",
    bid: null,
    ask: null,
    eventTime: null,
  };
}

/* ------------------------------------------------------------------------------------------------------
 * HORIZON: read-only Alpaca market data (latest quotes and historical bars) with the feed recorded.
 * Observation only: GETs against the data host; no order flow, not routed into the paper pipeline.
 * ---------------------------------------------------------------------------------------------------- */

export const ALPACA_QUALITY_FEED: Record<AlpacaFeed, QuoteFeed> = {
  iex: "ALPACA_IEX",
  sip: "ALPACA_SIP",
  delayed_sip: "ALPACA_DELAYED_SIP",
};

export type AlpacaQuoteSnapshot = {
  symbol: string;
  /** Feed explicitly requested for this quote. */
  feed: AlpacaFeed;
  bid: string | null;
  ask: string | null;
  /** Sizes in shares as reported by the feed (IEX sizes are IEX-only). */
  bidSize: number | null;
  askSize: number | null;
  bidExchange: string | null;
  askExchange: string | null;
  /** Quote condition flags as reported (e.g. "R" regular). */
  conditions: string[];
  tape: string | null;
  /** Quote timestamp (ISO, ms precision). */
  time: string | null;
  quality: QuoteQuality;
};

export type AlpacaDataFailure = { ok: false; code: "MISSING_CREDENTIALS" | "INVALID_CONFIGURATION" | "AUTH_FAILED" | "RATE_LIMITED" | "HTTP_ERROR" | "INVALID"; error: string; retryAfterMs?: number };

/** Trim RFC 3339 nanosecond timestamps to milliseconds. */
function isoMillis(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value.trim());
  if (!match) return null;
  const iso = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse `/v2/stocks/quotes/latest?symbols=…`. Missing symbols are simply absent; nothing is invented. */
export function parseAlpacaLatestQuotes(payload: unknown, feed: AlpacaFeed, now: Date): AlpacaQuoteSnapshot[] | null {
  const quotes = (payload as { quotes?: unknown } | null)?.quotes;
  if (!quotes || typeof quotes !== "object" || Array.isArray(quotes)) return null;
  const out: AlpacaQuoteSnapshot[] = [];
  for (const [symbol, raw] of Object.entries(quotes as Record<string, Record<string, unknown>>)) {
    const bp = finiteNumber(raw?.bp);
    const ap = finiteNumber(raw?.ap);
    // Alpaca reports 0 for an empty side; that is "no price", not a zero price.
    const bid = bp !== null && bp > 0 ? String(bp) : null;
    const ask = ap !== null && ap > 0 ? String(ap) : null;
    const time = isoMillis(raw?.t);
    out.push({
      symbol,
      feed,
      bid,
      ask,
      bidSize: finiteNumber(raw?.bs),
      askSize: finiteNumber(raw?.as),
      bidExchange: typeof raw?.bx === "string" ? raw.bx : null,
      askExchange: typeof raw?.ax === "string" ? raw.ax : null,
      conditions: Array.isArray(raw?.c) ? (raw.c as unknown[]).filter((c): c is string => typeof c === "string") : [],
      tape: typeof raw?.z === "string" ? raw.z : null,
      time,
      quality: describeQuoteQuality({ source: "alpaca_paper", feed: ALPACA_QUALITY_FEED[feed], now, eventTime: time, bid, ask }),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const ALPACA_SYMBOL = /^[A-Z.]{1,10}$/;

/**
 * Read-only Alpaca stock data client. Keys are read at call time and sent only to the strict data host.
 * Default feed is IEX (the free plan); SIP needs a paid plan and is never assumed.
 */
export class AlpacaMarketData {
  readonly feed: AlpacaFeed;

  constructor(
    private readonly credentials: AlpacaPaperCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      feed?: AlpacaFeed;
      keys?: () => { keyId: string; secret: string };
      /** Request budget for paginated bars (default 30/min, well under the free plan's 200/min). */
      maxRequestsPerMinute?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.feed = options.feed ?? "iex";
  }

  private keys(): { keyId: string; secret: string } {
    return (this.options.keys ?? (() => ({ keyId: process.env.ALPACA_API_KEY_ID ?? "", secret: process.env.ALPACA_API_SECRET_KEY ?? "" })))();
  }

  private preflight(): { ok: true; base: string } | AlpacaDataFailure {
    if (!this.credentials.apiKeyPresent || !this.credentials.apiSecretPresent) {
      return { ok: false, code: "MISSING_CREDENTIALS", error: "BLOCKED_EXTERNAL: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set" };
    }
    if (!assertAllowlistedHttpsUrl(this.credentials.dataUrl, ALPACA_DATA_HOSTS_STRICT).ok) {
      return { ok: false, code: "INVALID_CONFIGURATION", error: "ALPACA_DATA_BASE_URL must be https://data.alpaca.markets" };
    }
    return { ok: true, base: this.credentials.dataUrl.replace(/\/$/, "") };
  }

  /** Latest quote per symbol (1-50 symbols) on the configured feed. */
  async latestQuotes(symbols: readonly string[]): Promise<{ ok: true; data: AlpacaQuoteSnapshot[]; fetchedAt: string; request: string } | AlpacaDataFailure> {
    const pre = this.preflight();
    if (!pre.ok) return pre;
    if (symbols.length === 0 || symbols.length > 50 || !symbols.every((s) => ALPACA_SYMBOL.test(s))) {
      return { ok: false, code: "INVALID", error: "latestQuotes needs 1-50 upper-case tickers" };
    }
    const url = new URL(`${pre.base}/v2/stocks/quotes/latest`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("feed", this.feed);
    const keys = this.keys();
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json", "APCA-API-KEY-ID": keys.keyId, "APCA-API-SECRET-KEY": keys.secret },
        redirect: "error",
      });
    } catch (error) {
      return { ok: false, code: "HTTP_ERROR", error: `alpaca:error:${error instanceof Error ? error.message : "unknown"}` };
    }
    const now = (this.options.now ?? (() => new Date()))();
    if (response.status === 401 || response.status === 403) return { ok: false, code: "AUTH_FAILED", error: `AUTH_FAILED: Alpaca http_${response.status} (keys rejected or feed ${this.feed} not entitled)` };
    if (response.status === 429) return { ok: false, code: "RATE_LIMITED", error: "alpaca 429", retryAfterMs: retryAfterMs(response.headers, now.getTime()) };
    if (!response.ok) return { ok: false, code: "HTTP_ERROR", error: `alpaca http_${response.status}` };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, code: "INVALID", error: "alpaca invalid json" };
    }
    const data = parseAlpacaLatestQuotes(payload, this.feed, now);
    if (!data) return { ok: false, code: "INVALID", error: "alpaca latest quotes payload malformed" };
    return { ok: true, data, fetchedAt: now.toISOString(), request: `${url.pathname}?${url.searchParams.toString()}` };
  }

  /**
   * Historical bars for one symbol, following `next_page_token` up to `maxPages`, spaced to the request
   * budget. A 429 stops the walk and reports how long to wait; partial bars are returned with
   * `complete: false`, never padded.
   */
  async bars(input: { symbol: string; interval: HistoryInterval; startMs: number; endMs: number; maxPages?: number }): Promise<
    | { ok: true; bars: RawBar[]; pages: number; complete: boolean; stoppedBy: "DONE" | "PAGE_LIMIT" | "RATE_LIMITED"; retryAfterMs: number | null }
    | AlpacaDataFailure
  > {
    const pre = this.preflight();
    if (!pre.ok) return pre;
    const keys = this.keys();
    const perMinute = Math.max(1, this.options.maxRequestsPerMinute ?? 30);
    const source = new AlpacaBarsSource(
      { keyId: keys.keyId, secret: keys.secret, dataUrl: this.credentials.dataUrl },
      { fetchImpl: this.options.fetchImpl, feed: this.feed, maxRequestsPerMinute: perMinute },
    );
    const maxPages = Math.min(Math.max(Math.trunc(input.maxPages ?? 10), 1), 100);
    const spacingMs = Math.ceil(60_000 / perMinute);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const bars: RawBar[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= maxPages; page += 1) {
      if (page > 1) await sleep(spacingMs);
      const result = await source.fetchPage({ instrumentKey: input.symbol, interval: input.interval, startMs: input.startMs, endMs: input.endMs, cursor });
      if (!result.ok) {
        if (result.code === "RATE_LIMITED") return { ok: true, bars, pages: page - 1, complete: false, stoppedBy: "RATE_LIMITED", retryAfterMs: result.retryAfterMs ?? 60_000 };
        return { ok: false, code: result.code === "MISSING_CREDENTIALS" ? "MISSING_CREDENTIALS" : result.code === "INVALID_CONFIGURATION" ? "INVALID_CONFIGURATION" : result.code === "INVALID" ? "INVALID" : "HTTP_ERROR", error: result.error };
      }
      bars.push(...result.bars);
      cursor = result.nextCursor;
      if (cursor === null) return { ok: true, bars, pages: page, complete: true, stoppedBy: "DONE", retryAfterMs: null };
    }
    return { ok: true, bars, pages: maxPages, complete: false, stoppedBy: "PAGE_LIMIT", retryAfterMs: null };
  }
}
