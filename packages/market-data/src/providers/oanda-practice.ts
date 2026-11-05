import {
  SEED_INSTRUMENTS,
  canPaperExecute,
  describeQuoteQuality,
  evaluateSession,
  type Instrument,
  type ProviderReadiness,
  type QuoteQuality,
} from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "../market-provider.js";
import type { ProviderResult } from "../provider.js";
import {
  OANDA_PRACTICE_HOSTS,
  assertAllowlistedHttpsUrl,
  assertCompleteQuote,
  type AllowedHost,
} from "../practice-url.js";

export type OandaPracticeCredentials = {
  tokenPresent: boolean;
  accountIdPresent: boolean;
  apiUrl: string;
  accountId: string;
};

/**
 * OANDA v20 practice (fxTrade Practice) adapter.
 * Docs: https://developer.oanda.com/rest-live-v20/introduction/
 * Practice host: https://api-fxpractice.oanda.com
 * Requires OANDA_API_TOKEN + OANDA_ACCOUNT_ID on the practice environment.
 */
export class OandaPracticeProvider implements MarketDataProvider {
  readonly id = "oanda_practice" as const;
  private authFailed = false;
  private authenticatedOk = false;

  constructor(
    private readonly credentials: OandaPracticeCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      pricingFixture?: Record<string, { bid: string; ask: string; eventTime?: string }>;
      maxEventAgeMs?: number;
    } = {},
  ) {}

  noteAuthFailure(): void {
    this.authFailed = true;
    this.authenticatedOk = false;
  }

  noteAuthSuccess(): void {
    this.authFailed = false;
    this.authenticatedOk = true;
  }

  private urlValid(): boolean {
    return assertAllowlistedHttpsUrl(this.credentials.apiUrl, OANDA_PRACTICE_HOSTS).ok;
  }

  readiness(): ProviderReadiness {
    if (!this.credentials.tokenPresent || !this.credentials.accountIdPresent) {
      return "MISSING_CREDENTIALS";
    }
    if (!this.urlValid()) {
      return "INVALID_CONFIGURATION";
    }
    if (this.authFailed) {
      return "AUTH_FAILED";
    }
    if (this.options.pricingFixture) {
      return "READY";
    }
    if (!this.authenticatedOk) {
      return "CONNECTING";
    }
    return "READY";
  }

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter((item) => item.assetClass === "FX_SPOT");
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS") {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error:
          "BLOCKED_EXTERNAL_TEST: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID (fxpractice). See docs/mvp/PROVIDER_CAPABILITIES.md",
      };
    }
    if (ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return { ok: false, code: "UNAVAILABLE", error: `OANDA practice readiness=${ready}` };
    }

    const now = (this.options.now ?? (() => new Date))();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));

    if (this.options.pricingFixture) {
      const data: InstrumentQuote[] = [];
      for (const instrument of instruments) {
        const underscored = `${instrument.base}_${instrument.quote}`;
        const fix =
          this.options.pricingFixture![instrument.providerSymbol] ??
          this.options.pricingFixture![underscored] ??
          this.options.pricingFixture![instrument.symbol] ??
          this.options.pricingFixture![instrument.id];
        const session = evaluateSession({ session: instrument.session, now });
        if (!fix) {
          data.push(empty(instrument, now, session.status, "oanda:missing_fixture"));
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
          data.push(empty(instrument, now, session.status, `oanda:rejected_quote:${complete.reason}`));
          continue;
        }
        data.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: instrument.quote,
          dataState: "DEMO" as const,
          provenance: "oanda_practice:offline_fixture — sanitised contract test",
          session: session.status === "OPEN" ? ("OPEN" as const) : session.status === "CLOSED" ? ("CLOSED" as const) : ("UNKNOWN" as const),
          receivedAt: now.toISOString(),
          providerId: "oanda_practice" as const,
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: fix.eventTime ?? now.toISOString(),
          quality: describeQuoteQuality({ source: "oanda_practice", feed: "OFFLINE_FIXTURE", now, eventTime: fix.eventTime ?? null, bid: fix.bid, ask: fix.ask }),
        });
      }
      return { ok: true, fetchedAt: now.toISOString(), data };
    }

    if (ready !== "CONNECTING" && ready !== "READY") {
      return { ok: false, code: "UNAVAILABLE", error: `OANDA practice readiness=${ready}` };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const instrumentsParam = instruments
      .map((i) => (i.providerSymbol.includes("_") ? i.providerSymbol : `${i.base}_${i.quote}`))
      .join(",");
    try {
      const url = `${this.credentials.apiUrl.replace(/\/$/, "")}/v3/accounts/${this.credentials.accountId}/pricing?instruments=${encodeURIComponent(instrumentsParam)}`;
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${process.env.OANDA_API_TOKEN ?? ""}`,
          "content-type": "application/json",
        },
      });
      if (response.status === 401 || response.status === 403) {
        this.noteAuthFailure();
        return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: OANDA rejected token" };
      }
      if (!response.ok) {
        return { ok: false, code: "UNAVAILABLE", error: `oanda:http_${response.status}` };
      }
      this.noteAuthSuccess();
      const body = (await response.json()) as {
        prices?: Array<{
          instrument?: string;
          time?: string;
          bids?: Array<{ price?: string }>;
          asks?: Array<{ price?: string }>;
          tradeable?: boolean;
        }>;
      };
      const byInst = new Map(
        (body.prices ?? []).map((p) => [p.instrument?.replace("_", "") ?? "", p]),
      );
      const quotes: InstrumentQuote[] = instruments.map((instrument) => {
        const session = evaluateSession({ session: instrument.session, now });
        const row =
          byInst.get(instrument.symbol) ??
          byInst.get(`${instrument.base}${instrument.quote}`);
        const complete = assertCompleteQuote({
          bid: row?.bids?.[0]?.price,
          ask: row?.asks?.[0]?.price,
          eventTime: row?.time ?? null,
          now,
          maxEventAgeMs: this.options.maxEventAgeMs,
        });
        if (!complete.ok) {
          return empty(instrument, now, session.status, `oanda:rejected_quote:${complete.reason}`);
        }
        return {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: instrument.quote,
          dataState: "DEMO",
          provenance: "oanda_practice:pricing — fxTrade Practice demo",
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: now.toISOString(),
          providerId: "oanda_practice",
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: row?.time ?? null,
          quality: describeQuoteQuality({
            source: "oanda_practice",
            feed: "OANDA_PRACTICE",
            now,
            eventTime: row?.time ? normaliseOandaTime(row.time) : null,
            bid: row?.bids?.[0]?.price,
            ask: row?.asks?.[0]?.price,
            providerTradeable: typeof row?.tradeable === "boolean" ? row.tradeable : null,
          }),
        };
      });
      return { ok: true, fetchedAt: now.toISOString(), data: quotes };
    } catch (error) {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error: `oanda:error:${error instanceof Error ? error.message : "unknown"}`,
      };
    }
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

  /**
   * Submit STOP_LOSS / TAKE_PROFIT against an open trade on practice.
   * Returns desired≠acked failure when credentials missing — never invents ACK.
   */
  async submitProtectiveOrders(input: {
    tradeId: string;
    stopLossPrice?: string | null;
    takeProfitPrice?: string | null;
  }): Promise<
    | { ok: true; orderIds: string[]; status: string }
    | { ok: false; error: string; readiness: ProviderReadiness }
  > {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS" || ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return { ok: false, error: `Cannot submit protective orders: readiness=${ready}`, readiness: ready };
    }
    if (ready !== "READY" && ready !== "CONNECTING") {
      return { ok: false, error: `Cannot submit protective orders: readiness=${ready}`, readiness: ready };
    }
    if (!input.stopLossPrice && !input.takeProfitPrice) {
      return { ok: false, error: "NO_PROTECTIVE_PRICES", readiness: ready };
    }
    if (!this.urlValid()) {
      return { ok: false, error: "Cannot submit: INVALID_CONFIGURATION", readiness: "INVALID_CONFIGURATION" };
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const orderIds: string[] = [];
    const specs: Array<{ type: string; price: string }> = [];
    if (input.stopLossPrice) specs.push({ type: "STOP_LOSS", price: input.stopLossPrice });
    if (input.takeProfitPrice) specs.push({ type: "TAKE_PROFIT", price: input.takeProfitPrice });
    for (const spec of specs) {
      const response = await fetchImpl(
        `${this.credentials.apiUrl.replace(/\/$/, "")}/v3/accounts/${this.credentials.accountId}/orders`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OANDA_API_TOKEN ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            order: {
              type: spec.type,
              tradeID: input.tradeId,
              price: spec.price,
              timeInForce: "GTC",
            },
          }),
        },
      );
      if (response.status === 401 || response.status === 403) {
        this.noteAuthFailure();
        return { ok: false, error: "AUTH_FAILED: OANDA rejected token", readiness: "AUTH_FAILED" };
      }
      if (!response.ok) {
        return { ok: false, error: `oanda_protect:http_${response.status}`, readiness: this.readiness() };
      }
      this.noteAuthSuccess();
      const body = (await response.json()) as {
        orderCreateTransaction?: { id?: string };
        orderFillTransaction?: { id?: string };
      };
      const id = body.orderCreateTransaction?.id ?? body.orderFillTransaction?.id;
      if (!id) return { ok: false, error: "oanda_protect:missing_id", readiness: this.readiness() };
      orderIds.push(id);
    }
    return { ok: true, orderIds, status: "accepted" };
  }
}

export function inventoryOandaCredentials(env: NodeJS.ProcessEnv = process.env): OandaPracticeCredentials {
  return {
    tokenPresent: Boolean(env.OANDA_API_TOKEN?.trim()),
    accountIdPresent: Boolean(env.OANDA_ACCOUNT_ID?.trim()),
    apiUrl: env.OANDA_API_URL?.trim() || "https://api-fxpractice.oanda.com",
    accountId: env.OANDA_ACCOUNT_ID?.trim() || "",
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
    currency: instrument.quote,
    dataState: "DEMO",
    provenance: `${provenance} — null; never invent`,
    session: sessionStatus === "OPEN" ? "OPEN" : sessionStatus === "CLOSED" ? "CLOSED" : "UNKNOWN",
    receivedAt: now.toISOString(),
    providerId: "oanda_practice",
    bid: null,
    ask: null,
    eventTime: null,
  };
}

/* ------------------------------------------------------------------------------------------------------
 * HORIZON: read-only OANDA v20 practice market data (instruments, pricing, candles).
 *
 * Observation only. Every call here is a GET against the practice host; nothing places, amends or cancels
 * orders, and nothing is routed into the gateway's quote path or the paper pipeline. Results are typed so
 * the system can say plainly, for example, "XAU_USD not available on this account".
 * Fixtures under packages/market-data/fixtures/oanda-practice/ are modelled on the documented v20 response
 * shapes; they are not recordings from a real account (none exists yet).
 * ---------------------------------------------------------------------------------------------------- */

/** Credential-bearing OANDA calls go only to the practice host over HTTPS (no loopback, no live host). */
export const OANDA_PRACTICE_HOSTS_STRICT: readonly AllowedHost[] = [{ hostname: "api-fxpractice.oanda.com", port: 443 }];

/** Registry instrument id → OANDA instrument name. WTI maps to OANDA's WTICO_USD CFD (availability varies by region). */
export const OANDA_REGISTRY_MAP: Readonly<Record<string, string>> = {
  "fx:EURUSD": "EUR_USD",
  "fx:GBPUSD": "GBP_USD",
  "fx:USDJPY": "USD_JPY",
  "commodity:XAUUSD": "XAU_USD",
  "commodity:WTI": "WTICO_USD",
};

export const OANDA_GRANULARITIES = ["M1", "M5", "M15", "M30", "H1", "H4", "D"] as const;
export type OandaGranularity = (typeof OANDA_GRANULARITIES)[number];

export const OANDA_GRANULARITY_MS: Record<OandaGranularity, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D: 86_400_000,
};

export type OandaInstrumentSpec = {
  name: string;
  type: string;
  displayName: string;
  /** Decimal places OANDA displays for prices. */
  displayPrecision: number;
  /** Power of ten of one pip (−4 → 0.0001). */
  pipLocation: number;
  /** Decimal places allowed in order units. */
  tradeUnitsPrecision: number;
  minimumTradeSize: string;
  /** Shown for information only: QUANT does no margin execution. */
  marginRate: string | null;
};

export type OandaFailureCode = "MISSING_CREDENTIALS" | "INVALID_CONFIGURATION" | "AUTH_FAILED" | "HTTP_ERROR" | "RATE_LIMITED" | "INVALID";

export type OandaResult<T> = { ok: true; data: T; fetchedAt: string } | { ok: false; code: OandaFailureCode; error: string };

export type OandaAvailability = {
  instrument: string;
  available: boolean;
  /** Null when available; otherwise a plain sentence for operators. */
  reason: string | null;
  spec: OandaInstrumentSpec | null;
};

export type OandaPriceSnapshot = {
  instrument: string;
  /** Provider event time (ISO, ms precision). */
  time: string | null;
  bid: string | null;
  ask: string | null;
  mid: string | null;
  spread: string | null;
  /** Liquidity available at the top bid/ask level, when reported. */
  bidLiquidity: number | null;
  askLiquidity: number | null;
  closeoutBid: string | null;
  closeoutAsk: string | null;
  /** OANDA's `tradeable` flag: false outside market hours or when the instrument is halted. */
  tradeable: boolean | null;
  quality: QuoteQuality;
};

export type OandaCandlePrice = { o: string; h: string; l: string; c: string };

export type OandaCandle = {
  /** Candle open, epoch ms (UTC). */
  openTime: number;
  /** Earliest time a decision could use the candle: its close. */
  closeTime: number;
  complete: boolean;
  /** OANDA reports tick volume (price updates), not traded volume. */
  tickVolume: number | null;
  mid: OandaCandlePrice | null;
  bid: OandaCandlePrice | null;
  ask: OandaCandlePrice | null;
};

/** Trim OANDA's nanosecond RFC 3339 timestamps to milliseconds so Date.parse is exact and portable. */
export function normaliseOandaTime(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value.trim());
  if (!match) return null;
  const ms = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const iso = `${match[1]}.${ms}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

/** Parse `/v3/accounts/{id}/instruments`. Rows missing precision fields are dropped, never defaulted. */
export function parseOandaInstruments(payload: unknown): OandaInstrumentSpec[] | null {
  const rows = (payload as { instruments?: unknown } | null)?.instruments;
  if (!Array.isArray(rows)) return null;
  const out: OandaInstrumentSpec[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const name = text(row?.name);
    const displayPrecision = int(row?.displayPrecision);
    const pipLocation = int(row?.pipLocation);
    const tradeUnitsPrecision = int(row?.tradeUnitsPrecision);
    const minimumTradeSize = text(row?.minimumTradeSize);
    if (!name || displayPrecision === null || pipLocation === null || tradeUnitsPrecision === null || !minimumTradeSize) continue;
    out.push({
      name,
      type: text(row.type) ?? "UNKNOWN",
      displayName: text(row.displayName) ?? name,
      displayPrecision,
      pipLocation,
      tradeUnitsPrecision,
      minimumTradeSize,
      marginRate: text(row.marginRate),
    });
  }
  return out;
}

/** Per requested instrument: is it available on THIS account, and if not, say so plainly. */
export function oandaAvailability(specs: readonly OandaInstrumentSpec[], requested: readonly string[]): OandaAvailability[] {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  return requested.map((instrument) => {
    const spec = byName.get(instrument) ?? null;
    return spec
      ? { instrument, available: true, reason: null, spec }
      : { instrument, available: false, reason: `${instrument} not available on this account`, spec: null };
  });
}

/** Tick, pip and unit steps implied by OANDA precision (display precision is the quoted price tick). */
export function oandaPrecision(spec: OandaInstrumentSpec): { tickSize: string; pipSize: string; unitStep: string } {
  const step = (dp: number) => (dp <= 0 ? "1" : `0.${"0".repeat(dp - 1)}1`);
  return {
    tickSize: step(spec.displayPrecision),
    pipSize: spec.pipLocation >= 0 ? `1${"0".repeat(spec.pipLocation)}` : step(-spec.pipLocation),
    unitStep: step(spec.tradeUnitsPrecision),
  };
}

/** Parse `/v3/accounts/{id}/pricing`. A side with no price stays null; nothing is invented. */
export function parseOandaPricing(payload: unknown, now: Date): OandaPriceSnapshot[] | null {
  const rows = (payload as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(rows)) return null;
  const out: OandaPriceSnapshot[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const instrument = text(row?.instrument);
    if (!instrument) continue;
    const bids = Array.isArray(row.bids) ? (row.bids as Array<Record<string, unknown>>) : [];
    const asks = Array.isArray(row.asks) ? (row.asks as Array<Record<string, unknown>>) : [];
    const bid = text(bids[0]?.price);
    const ask = text(asks[0]?.price);
    const time = typeof row.time === "string" ? normaliseOandaTime(row.time) : null;
    const tradeable = typeof row.tradeable === "boolean" ? row.tradeable : null;
    const quality = describeQuoteQuality({ source: "oanda_practice", feed: "OANDA_PRACTICE", now, eventTime: time, bid, ask, providerTradeable: tradeable });
    out.push({
      instrument,
      time,
      bid,
      ask,
      mid: quality.twoSided ? ((Number(bid) + Number(ask)) / 2).toFixed(8) : null,
      spread: quality.spread,
      bidLiquidity: typeof bids[0]?.liquidity === "number" ? (bids[0].liquidity as number) : null,
      askLiquidity: typeof asks[0]?.liquidity === "number" ? (asks[0].liquidity as number) : null,
      closeoutBid: text(row.closeoutBid),
      closeoutAsk: text(row.closeoutAsk),
      tradeable,
      quality,
    });
  }
  return out;
}

function candlePrice(value: unknown): OandaCandlePrice | null {
  const v = value as Record<string, unknown> | undefined;
  const o = text(v?.o);
  const h = text(v?.h);
  const l = text(v?.l);
  const c = text(v?.c);
  return o && h && l && c ? { o, h, l, c } : null;
}

/** Parse `/v3/instruments/{i}/candles`. Candles with an unparseable time are dropped. */
export function parseOandaCandles(payload: unknown, granularity: OandaGranularity): OandaCandle[] | null {
  const rows = (payload as { candles?: unknown } | null)?.candles;
  if (!Array.isArray(rows)) return null;
  const width = OANDA_GRANULARITY_MS[granularity];
  const out: OandaCandle[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const time = typeof row?.time === "string" ? normaliseOandaTime(row.time) : null;
    if (!time) continue;
    const openTime = Date.parse(time);
    out.push({
      openTime,
      closeTime: openTime + width,
      complete: row.complete === true,
      tickVolume: typeof row.volume === "number" ? row.volume : null,
      mid: candlePrice(row.mid),
      bid: candlePrice(row.bid),
      ask: candlePrice(row.ask),
    });
  }
  return out;
}

const OANDA_INSTRUMENT_NAME = /^[A-Z0-9]{2,10}_[A-Z0-9]{2,10}$/;
const OANDA_ACCOUNT_ID = /^[0-9]{3}-[0-9]{3}-[0-9]{1,12}-[0-9]{3}$/;

/**
 * Read-only OANDA practice market-data client. Separate from {@link OandaPracticeProvider} so the existing
 * quote and order behaviour is untouched. The token is read at call time and sent only to the strict
 * practice host; it never appears in a returned request description.
 */
export class OandaPracticeMarketData {
  constructor(
    private readonly credentials: OandaPracticeCredentials,
    private readonly options: { fetchImpl?: typeof fetch; now?: () => Date; token?: () => string } = {},
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private preflight(needsAccount: boolean): { ok: true; base: string } | { ok: false; code: OandaFailureCode; error: string } {
    if (!this.credentials.tokenPresent || (needsAccount && !this.credentials.accountIdPresent)) {
      return { ok: false, code: "MISSING_CREDENTIALS", error: "BLOCKED_EXTERNAL: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID (fxTrade Practice)" };
    }
    if (!assertAllowlistedHttpsUrl(this.credentials.apiUrl, OANDA_PRACTICE_HOSTS_STRICT).ok) {
      return { ok: false, code: "INVALID_CONFIGURATION", error: "OANDA_API_URL must be https://api-fxpractice.oanda.com" };
    }
    if (needsAccount && !OANDA_ACCOUNT_ID.test(this.credentials.accountId)) {
      return { ok: false, code: "INVALID_CONFIGURATION", error: "OANDA_ACCOUNT_ID is not in the v20 ddd-ddd-d-ddd form" };
    }
    return { ok: true, base: this.credentials.apiUrl.replace(/\/$/, "") };
  }

  private async get(url: URL): Promise<{ ok: true; payload: unknown } | { ok: false; code: OandaFailureCode; error: string }> {
    const token = (this.options.token ?? (() => process.env.OANDA_API_TOKEN ?? ""))();
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "accept-datetime-format": "RFC3339" },
        redirect: "error",
      });
    } catch (error) {
      return { ok: false, code: "HTTP_ERROR", error: `oanda:error:${error instanceof Error ? error.message : "unknown"}` };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, code: "AUTH_FAILED", error: "AUTH_FAILED: OANDA rejected token" };
    if (response.status === 429) return { ok: false, code: "RATE_LIMITED", error: "oanda:http_429" };
    if (!response.ok) return { ok: false, code: "HTTP_ERROR", error: `oanda:http_${response.status}` };
    try {
      return { ok: true, payload: await response.json() };
    } catch {
      return { ok: false, code: "INVALID", error: "oanda:invalid_json" };
    }
  }

  /** Instruments this account can trade, with precision. */
  async listAccountInstruments(): Promise<OandaResult<OandaInstrumentSpec[]>> {
    const pre = this.preflight(true);
    if (!pre.ok) return pre;
    const res = await this.get(new URL(`${pre.base}/v3/accounts/${this.credentials.accountId}/instruments`));
    if (!res.ok) return res;
    const specs = parseOandaInstruments(res.payload);
    if (!specs) return { ok: false, code: "INVALID", error: "oanda instruments payload malformed" };
    return { ok: true, data: specs, fetchedAt: this.now().toISOString() };
  }

  /** Availability of requested instruments (default: every registry-mapped one) on this account. */
  async availability(requested: readonly string[] = Object.values(OANDA_REGISTRY_MAP)): Promise<OandaResult<OandaAvailability[]>> {
    const specs = await this.listAccountInstruments();
    if (!specs.ok) return specs;
    return { ok: true, data: oandaAvailability(specs.data, requested), fetchedAt: specs.fetchedAt };
  }

  /** Current bid/ask/time/tradeable for 1-20 instruments. */
  async pricing(instruments: readonly string[]): Promise<OandaResult<OandaPriceSnapshot[]>> {
    const pre = this.preflight(true);
    if (!pre.ok) return pre;
    if (instruments.length === 0 || instruments.length > 20 || !instruments.every((i) => OANDA_INSTRUMENT_NAME.test(i))) {
      return { ok: false, code: "INVALID", error: "pricing needs 1-20 OANDA instrument names such as EUR_USD" };
    }
    const url = new URL(`${pre.base}/v3/accounts/${this.credentials.accountId}/pricing`);
    url.searchParams.set("instruments", instruments.join(","));
    const res = await this.get(url);
    if (!res.ok) return res;
    const now = this.now();
    const prices = parseOandaPricing(res.payload, now);
    if (!prices) return { ok: false, code: "INVALID", error: "oanda pricing payload malformed" };
    return { ok: true, data: prices, fetchedAt: now.toISOString() };
  }

  /**
   * Candles for one instrument. `price` BA records bid and ask; MBA adds mid. Candles are requested on a
   * UTC daily alignment so D and H4 candles sit on the warehouse's UTC grid. At most 5000 per call.
   */
  async candles(input: {
    instrument: string;
    granularity: OandaGranularity;
    price?: "M" | "BA" | "MBA";
    fromMs: number;
    count?: number;
  }): Promise<OandaResult<{ candles: OandaCandle[]; request: string; payload: unknown }>> {
    const pre = this.preflight(false);
    if (!pre.ok) return pre;
    if (!OANDA_INSTRUMENT_NAME.test(input.instrument)) return { ok: false, code: "INVALID", error: "instrument must look like EUR_USD" };
    if (!OANDA_GRANULARITIES.includes(input.granularity)) return { ok: false, code: "INVALID", error: `unsupported granularity ${String(input.granularity)}` };
    if (!Number.isFinite(input.fromMs)) return { ok: false, code: "INVALID", error: "fromMs must be finite" };
    const url = new URL(`${pre.base}/v3/instruments/${input.instrument}/candles`);
    url.searchParams.set("granularity", input.granularity);
    url.searchParams.set("price", input.price ?? "MBA");
    url.searchParams.set("from", new Date(input.fromMs).toISOString());
    url.searchParams.set("count", String(Math.min(Math.max(Math.trunc(input.count ?? 500), 1), 5000)));
    url.searchParams.set("dailyAlignment", "0");
    url.searchParams.set("alignmentTimezone", "UTC");
    const res = await this.get(url);
    if (!res.ok) return res;
    const candles = parseOandaCandles(res.payload, input.granularity);
    if (!candles) return { ok: false, code: "INVALID", error: "oanda candles payload malformed" };
    return { ok: true, data: { candles, request: `${url.pathname}?${url.searchParams.toString()}`, payload: res.payload }, fetchedAt: this.now().toISOString() };
  }
}
