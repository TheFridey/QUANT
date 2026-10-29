import { z } from "zod";
import Decimal from "decimal.js";
import type { ProviderReadiness } from "@odin/shared";
import {
  TERMINAL_EXTERNAL_STATUSES,
  type ConnectionState,
  type ExternalAccount,
  type ExternalCapabilities,
  type ExternalExecution,
  type ExternalExecutionVenue,
  type ExternalInstrument,
  type ExternalOrderState,
  type ExternalOrderStatus,
  type ExternalPage,
  type ExternalPosition,
  type ExternalResult,
  type ExternalSubmitRequest,
} from "./execution-contract.js";
import { HttpTransport } from "./http-transport.js";
import {
  ALPACA_DATA_HOSTS_STRICT,
  ALPACA_PAPER_TRADE_HOSTS_STRICT,
  assertAllowlistedHttpsUrl,
  loopbackTestAllowlist,
  type AllowedHost,
} from "./practice-url.js";

/**
 * Alpaca Trading API (paper) as an ExternalExecutionVenue.
 * Docs: https://docs.alpaca.markets/reference (Trading API v2 + Market Data v2).
 * Credentials are only ever sent to https://paper-api.alpaca.markets and https://data.alpaca.markets.
 */

export const ALPACA_REQUIRED_ENV = ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"] as const;
export const ALPACA_DEFAULT_TRADE_URL = "https://paper-api.alpaca.markets";
export const ALPACA_DEFAULT_DATA_URL = "https://data.alpaca.markets";

const DECIMAL = /^-?\d+(\.\d+)?$/;
const decimalString = z.string().regex(DECIMAL);
const optionalDecimal = z
  .union([decimalString, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v == null || v === "" ? null : v));

const orderBaseSchema = z.object({
  id: z.string().min(1),
  client_order_id: z.string(),
  status: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  qty: decimalString,
  filled_qty: decimalString,
  filled_avg_price: optionalDecimal,
  submitted_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  order_class: z.string().nullable().optional(),
});
const orderSchema = orderBaseSchema.extend({ legs: z.array(orderBaseSchema).nullable().optional() });
type AlpacaOrder = z.output<typeof orderSchema>;
type AlpacaOrderBase = z.output<typeof orderBaseSchema>;

const accountSchema = z.object({
  id: z.string().min(1),
  account_number: z.string().min(1),
  status: z.string(),
  currency: z.string().min(1),
  cash: decimalString,
  buying_power: decimalString,
  equity: optionalDecimal,
});

const assetSchema = z.object({
  id: z.string().min(1),
  class: z.string(),
  symbol: z.string().min(1),
  status: z.string(),
  tradable: z.boolean(),
  fractionable: z.boolean(),
  shortable: z.boolean(),
  min_order_size: optionalDecimal,
  min_trade_increment: optionalDecimal,
});

const positionSchema = z.object({
  symbol: z.string().min(1),
  qty: decimalString,
  avg_entry_price: optionalDecimal,
  side: z.enum(["long", "short"]),
});

const fillActivitySchema = z.object({
  id: z.string().min(1),
  activity_type: z.literal("FILL"),
  order_id: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell", "sell_short"]),
  qty: decimalString,
  price: optionalDecimal,
  cum_qty: optionalDecimal,
  leaves_qty: optionalDecimal,
  transaction_time: z.string().min(1),
  type: z.enum(["fill", "partial_fill"]),
});

const latestQuotesSchema = z.object({
  quotes: z.record(
    z.string(),
    z.object({ bp: z.number().nonnegative(), ap: z.number().nonnegative(), t: z.string().min(1) }),
  ),
});

export function mapAlpacaOrderStatus(raw: string): ExternalOrderStatus {
  switch (raw) {
    case "new":
    case "accepted":
    case "pending_new":
    case "accepted_for_bidding":
    // bracket/OTO child legs wait in `held` until the entry fills
    case "held":
      return "ACCEPTED";
    case "partially_filled":
      return "PARTIALLY_FILLED";
    case "filled":
      return "FILLED";
    case "pending_cancel":
      return "CANCEL_PENDING";
    case "canceled":
      return "CANCELED";
    case "rejected":
      return "REJECTED";
    case "expired":
    case "done_for_day":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

function mapOrderBase(o: AlpacaOrderBase): ExternalOrderState {
  return {
    brokerOrderId: o.id,
    clientOrderId: o.client_order_id,
    status: mapAlpacaOrderStatus(o.status),
    rawStatus: o.status,
    side: o.side === "buy" ? "BUY" : "SELL",
    symbol: o.symbol,
    qty: o.qty,
    filledQty: o.filled_qty,
    avgFillPrice: o.filled_avg_price,
    submittedAt: o.submitted_at ?? null,
    updatedAt: o.updated_at ?? null,
  };
}

function mapOrder(o: AlpacaOrder): ExternalOrderState {
  const base = mapOrderBase(o);
  return o.legs && o.legs.length > 0 ? { ...base, legs: o.legs.map(mapOrderBase) } : base;
}

const UNSUPPORTED_PREFIX_REASON: Record<string, string> = {
  fx: "Alpaca does not execute spot FX; use an FX practice venue",
  commodity: "Alpaca does not execute commodities",
  index: "indices are not directly tradable on Alpaca; trade an ETF proxy (e.g. etf:SPY)",
  crypto: "crypto requires a separate Alpaca asset-class mapping that is not implemented",
};

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EQUITY_SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

/** Canonical instrument id → Alpaca us_equity symbol, without network. */
export function parseAlpacaInstrumentId(instrumentId: string): { ok: true; symbol: string } | { ok: false; reason: string } {
  const trimmed = instrumentId.trim();
  const sep = trimmed.indexOf(":");
  if (sep < 0) {
    if (SOLANA_ADDRESS.test(trimmed)) return { ok: false, reason: `${trimmed}: on-chain pair addresses are not executable on Alpaca` };
    return { ok: false, reason: `${trimmed}: expected canonical id like etf:SPY or equity:AAPL` };
  }
  const prefix = trimmed.slice(0, sep).toLowerCase();
  const symbol = trimmed.slice(sep + 1).toUpperCase();
  if (prefix === "etf" || prefix === "equity") {
    if (!EQUITY_SYMBOL.test(symbol)) return { ok: false, reason: `${trimmed}: invalid equity symbol` };
    return { ok: true, symbol };
  }
  const reason = UNSUPPORTED_PREFIX_REASON[prefix];
  return { ok: false, reason: `${trimmed}: ${reason ?? `asset class '${prefix}' is not supported by Alpaca practice`}` };
}

function isWholeQty(qty: string): boolean {
  return new Decimal(qty).isInteger();
}

/** Native brackets apply only to whole-share orders (Alpaca rejects fractional advanced orders). */
export function protectionForOrder(instrument: ExternalInstrument, qty: string): ExternalInstrument["protection"] {
  if (!instrument.tradable) return "NONE";
  if (instrument.protection === "NATIVE_BRACKET" && DECIMAL.test(qty) && isWholeQty(qty)) return "NATIVE_BRACKET";
  return "SYNTHETIC";
}

/** POST /v2/orders body. Brackets need both legs; a stop alone is sent as an OTO. */
export function buildAlpacaOrderBody(symbol: string, request: ExternalSubmitRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    symbol,
    qty: request.qty,
    side: request.side === "BUY" ? "buy" : "sell",
    type: request.type,
    time_in_force: request.timeInForce,
    client_order_id: request.clientOrderId,
  };
  if (request.type === "limit" && request.limitPrice) body.limit_price = request.limitPrice;
  if (request.bracket) {
    body.order_class = request.bracket.takeProfitPrice ? "bracket" : "oto";
    body.stop_loss = { stop_price: request.bracket.stopPrice };
    if (request.bracket.takeProfitPrice) body.take_profit = { limit_price: request.bracket.takeProfitPrice };
  }
  return body;
}

function validateSubmit(request: ExternalSubmitRequest): string | null {
  if (!request.clientOrderId.trim()) return "clientOrderId required for idempotency";
  if (request.clientOrderId.length > 128) return "clientOrderId exceeds 128 characters";
  if (!DECIMAL.test(request.qty) || !new Decimal(request.qty).gt(0)) return "qty must be a positive decimal string";
  if (request.type === "limit" && (!request.limitPrice || !DECIMAL.test(request.limitPrice))) {
    return "limit orders require a decimal limitPrice";
  }
  if (request.bracket) {
    if (!DECIMAL.test(request.bracket.stopPrice)) return "bracket.stopPrice must be a decimal string";
    if (request.bracket.takeProfitPrice !== undefined && !DECIMAL.test(request.bracket.takeProfitPrice)) {
      return "bracket.takeProfitPrice must be a decimal string";
    }
    if (request.timeInForce === "ioc") return "bracket/OTO orders require timeInForce day or gtc";
  }
  return null;
}

export type AlpacaPracticeVenueConfig = {
  apiKeyId: string;
  apiSecretKey: string;
  baseUrl?: string;
  dataBaseUrl?: string;
  /** Market-data feed; free paper accounts only have `iex`. */
  dataFeed?: string;
};

export type AlpacaPracticeVenueOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxReadAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  instrumentCacheMs?: number;
  /**
   * TEST ONLY: route both hosts to a plain-http loopback server (127.0.0.1/localhost).
   * Never read from env; practiceVenueFromEnv cannot set it.
   */
  unsafeTestOnlyLoopback?: { baseUrl: string; dataBaseUrl?: string };
  /**
   * TEST ONLY: in-memory practice book — no network. Marks the venue VERIFIED immediately.
   * Never read from env; practiceVenueFromEnv cannot set it.
   */
  offline?: {
    account: { id: string; cash: string; buyingPower: string; currency: string };
    orders: Map<string, ExternalOrderState>;
  };
};

type Failure = Extract<ExternalResult<never>, { ok: false }>;

type Configured = {
  trade: HttpTransport;
  data: HttpTransport;
};

export class AlpacaPracticeVenue implements ExternalExecutionVenue {
  readonly venue = "alpaca_paper" as const;
  private state: ConnectionState;
  private readonly configError: string | null;
  private readonly transports: Configured | null;
  private readonly instrumentCache = new Map<string, { at: number; value: ExternalInstrument }>();
  private lastAccount: ExternalAccount | null = null;
  private readonly offline: NonNullable<AlpacaPracticeVenueOptions["offline"]> | null;

  constructor(
    private readonly config: AlpacaPracticeVenueConfig,
    private readonly options: AlpacaPracticeVenueOptions = {},
  ) {
    this.offline = options.offline ?? null;
    if (this.offline) {
      // Offline test double: verified practice account, no transports.
      this.state = "VERIFIED";
      this.configError = null;
      this.transports = null;
      this.lastAccount = {
        accountId: this.offline.account.id,
        status: "ACTIVE",
        currency: this.offline.account.currency,
        cash: this.offline.account.cash,
        buyingPower: this.offline.account.buyingPower,
        equity: null,
        isPractice: true,
      };
      return;
    }
    const keyId = config.apiKeyId.trim();
    const secret = config.apiSecretKey.trim();
    if (!keyId || !secret) {
      this.state = "NOT_CONFIGURED";
      this.configError = null;
      this.transports = null;
      return;
    }
    const hosts = this.resolveHosts();
    if (!hosts.ok) {
      this.state = "NOT_CONFIGURED";
      this.configError = hosts.reason;
      this.transports = null;
      return;
    }
    const credentialHeaders = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
    const common = {
      credentialHeaders,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxReadAttempts: options.maxReadAttempts,
      sleep: options.sleep,
      now: options.now,
    };
    this.transports = {
      trade: new HttpTransport({ ...common, baseUrl: hosts.trade.url, allowlist: hosts.trade.allowlist }),
      data: new HttpTransport({ ...common, baseUrl: hosts.data.url, allowlist: hosts.data.allowlist }),
    };
    this.configError = null;
    this.state = "CONFIGURED_UNVERIFIED";
  }

  private resolveHosts():
    | { ok: true; trade: { url: string; allowlist: readonly AllowedHost[] }; data: { url: string; allowlist: readonly AllowedHost[] } }
    | { ok: false; reason: string } {
    const loop = this.options.unsafeTestOnlyLoopback;
    if (loop) {
      const dataUrl = loop.dataBaseUrl ?? loop.baseUrl;
      const trade = loopbackTestAllowlist(loop.baseUrl);
      const data = loopbackTestAllowlist(dataUrl);
      if (!trade.ok) return { ok: false, reason: `test loopback trade url: ${trade.reason}` };
      if (!data.ok) return { ok: false, reason: `test loopback data url: ${data.reason}` };
      return { ok: true, trade: { url: loop.baseUrl, allowlist: trade.allowlist }, data: { url: dataUrl, allowlist: data.allowlist } };
    }
    const tradeUrl = this.config.baseUrl?.trim() || ALPACA_DEFAULT_TRADE_URL;
    const dataUrl = this.config.dataBaseUrl?.trim() || ALPACA_DEFAULT_DATA_URL;
    const trade = assertAllowlistedHttpsUrl(tradeUrl, ALPACA_PAPER_TRADE_HOSTS_STRICT);
    if (!trade.ok) return { ok: false, reason: `trade host: ${trade.reason}` };
    const data = assertAllowlistedHttpsUrl(dataUrl, ALPACA_DATA_HOSTS_STRICT);
    if (!data.ok) return { ok: false, reason: `data host: ${data.reason}` };
    return {
      ok: true,
      trade: { url: tradeUrl, allowlist: ALPACA_PAPER_TRADE_HOSTS_STRICT },
      data: { url: dataUrl, allowlist: ALPACA_DATA_HOSTS_STRICT },
    };
  }

  /** Null when configuration is valid. */
  configurationError(): string | null {
    return this.configError;
  }

  /** Last account seen by verifyConnection (null until verified). */
  verifiedAccount(): ExternalAccount | null {
    return this.state === "VERIFIED" ? this.lastAccount : null;
  }

  readiness(): ProviderReadiness {
    if (this.offline) return "READY";
    if (!this.transports) return this.configError ? "INVALID_CONFIGURATION" : "MISSING_CREDENTIALS";
    switch (this.state) {
      case "VERIFIED":
        return "READY";
      case "AUTH_FAILED":
        return "AUTH_FAILED";
      case "NOT_PRACTICE":
        return "INVALID_CONFIGURATION";
      default:
        return "CONNECTING";
    }
  }

  connectionState(): ConnectionState {
    return this.state;
  }

  capabilities(): ExternalCapabilities {
    const usable =
      this.offline !== null ||
      (this.transports !== null && this.state !== "NOT_PRACTICE" && this.state !== "AUTH_FAILED");
    return {
      submit: usable,
      cancel: usable,
      lookup: usable,
      executions: usable,
      positions: usable,
      balances: usable,
      quotes: usable && !this.offline,
      nativeProtection: usable && !this.offline,
      reconcile: usable,
    };
  }

  private notReady(): Failure {
    if (this.offline) {
      return { ok: false, code: "INVALID_CONFIGURATION", error: "offline practice double is ready; unexpected notReady", retryClass: "none" };
    }
    if (!this.transports) {
      if (this.configError) {
        return { ok: false, code: "INVALID_CONFIGURATION", error: `Alpaca practice configuration rejected: ${this.configError}`, retryClass: "none" };
      }
      return {
        ok: false,
        code: "MISSING_CREDENTIALS",
        error: `BLOCKED_EXTERNAL: set ${ALPACA_REQUIRED_ENV.join(" and ")} (paper keys)`,
        retryClass: "none",
      };
    }
    return {
      ok: false,
      code: "INVALID_CONFIGURATION",
      error: "NOT_PRACTICE: account is not a verified Alpaca paper account; refusing",
      retryClass: "none",
    };
  }

  private observe<T>(res: ExternalResult<T>): ExternalResult<T> {
    if (!res.ok && res.code === "AUTH_FAILED") this.state = "AUTH_FAILED";
    return res;
  }

  private async read<S extends z.ZodType>(
    path: string,
    schema: S,
    query?: Record<string, string | number | boolean | null | undefined>,
    host: "trade" | "data" = "trade",
  ): Promise<ExternalResult<z.output<S>>> {
    if (!this.transports || this.state === "NOT_PRACTICE") return this.notReady();
    return this.observe(await this.transports[host].requestJson({ method: "GET", path, query, operation: "read" }, schema));
  }

  /** Economic calls require a verified practice account; verifies lazily once. */
  private async ensureVerified(): Promise<{ ok: true; trade: HttpTransport } | Failure> {
    if (!this.transports || this.state === "NOT_PRACTICE") return this.notReady();
    if (this.state !== "VERIFIED") {
      const verified = await this.verifyConnection();
      if (!verified.ok) return verified;
    }
    return { ok: true, trade: this.transports.trade };
  }

  async verifyConnection(): Promise<ExternalResult<ExternalAccount>> {
    if (this.offline && this.lastAccount) return { ok: true, value: this.lastAccount };
    if (!this.transports) return this.notReady();
    const res = await this.transports.trade.requestJson({ method: "GET", path: "/v2/account", operation: "read" }, accountSchema);
    if (!res.ok) {
      if (res.code === "AUTH_FAILED") this.state = "AUTH_FAILED";
      else if (res.code === "TIMEOUT" || res.code === "NETWORK" || res.code === "SERVER_ERROR" || res.code === "REDIRECT_REFUSED") {
        this.state = "UNREACHABLE";
      }
      return res;
    }
    // Paper account numbers are prefixed "PA"; anything else is treated as a live account.
    if (!res.value.account_number.toUpperCase().startsWith("PA")) {
      this.state = "NOT_PRACTICE";
      this.lastAccount = null;
      return {
        ok: false,
        code: "INVALID_CONFIGURATION",
        error: "NOT_PRACTICE: account number does not match Alpaca paper format; refusing economic calls",
        retryClass: "none",
      };
    }
    const account: ExternalAccount = {
      accountId: res.value.id,
      status: res.value.status,
      currency: res.value.currency,
      cash: res.value.cash,
      buyingPower: res.value.buying_power,
      equity: res.value.equity,
      isPractice: true,
    };
    this.state = "VERIFIED";
    this.lastAccount = account;
    return { ok: true, value: account };
  }

  async resolveInstrument(instrumentId: string): Promise<ExternalResult<ExternalInstrument>> {
    const parsed = parseAlpacaInstrumentId(instrumentId);
    if (!parsed.ok) return { ok: false, code: "UNSUPPORTED", error: parsed.reason, retryClass: "none" };
    const now = (this.options.now ?? Date.now)();
    const cached = this.instrumentCache.get(parsed.symbol);
    if (cached && now - cached.at < (this.options.instrumentCacheMs ?? 60_000)) {
      return { ok: true, value: { ...cached.value, instrumentId } };
    }
    const res = await this.read(`/v2/assets/${encodeURIComponent(parsed.symbol)}`, assetSchema);
    if (!res.ok) return res;
    if (res.value.class !== "us_equity") {
      return { ok: false, code: "UNSUPPORTED", error: `${instrumentId}: Alpaca asset class '${res.value.class}' is not supported`, retryClass: "none" };
    }
    const tradable = res.value.tradable && res.value.status === "active";
    const value: ExternalInstrument = {
      instrumentId,
      symbol: res.value.symbol,
      assetClass: res.value.class,
      tradable,
      fractionable: res.value.fractionable,
      shortable: res.value.shortable,
      minQty: res.value.min_order_size,
      qtyIncrement: res.value.min_trade_increment,
      protection: tradable ? "NATIVE_BRACKET" : "NONE",
    };
    this.instrumentCache.set(parsed.symbol, { at: now, value });
    return { ok: true, value };
  }

  async submitOrder(request: ExternalSubmitRequest): Promise<ExternalResult<ExternalOrderState>> {
    const invalid = validateSubmit(request);
    if (invalid) return { ok: false, code: "VALIDATION_REJECTED", error: invalid, retryClass: "none" };
    const parsed = parseAlpacaInstrumentId(request.instrumentId);
    if (!parsed.ok) return { ok: false, code: "UNSUPPORTED", error: parsed.reason, retryClass: "none" };
    if (this.offline) {
      const existing = this.offline.orders.get(request.clientOrderId);
      if (existing) return { ok: true, value: existing };
      const now = new Date((this.options.now ?? Date.now)()).toISOString();
      const state: ExternalOrderState = {
        brokerOrderId: `offline_${request.clientOrderId}`,
        clientOrderId: request.clientOrderId,
        status: "ACCEPTED",
        rawStatus: "accepted",
        side: request.side,
        symbol: parsed.symbol,
        qty: request.qty,
        filledQty: "0",
        avgFillPrice: null,
        submittedAt: now,
        updatedAt: now,
      };
      this.offline.orders.set(request.clientOrderId, state);
      return { ok: true, value: state };
    }
    const ready = await this.ensureVerified();
    if (!ready.ok) return ready;
    const instrument = await this.resolveInstrument(request.instrumentId);
    if (!instrument.ok) return instrument;
    if (!instrument.value.tradable) {
      return { ok: false, code: "UNSUPPORTED", error: `${request.instrumentId}: not tradable on Alpaca`, retryClass: "none" };
    }
    const whole = isWholeQty(request.qty);
    if (!whole && !instrument.value.fractionable) {
      return { ok: false, code: "UNSUPPORTED", error: `${request.instrumentId}: fractional qty not supported for this asset`, retryClass: "none" };
    }
    if (request.bracket && protectionForOrder(instrument.value, request.qty) !== "NATIVE_BRACKET") {
      return {
        ok: false,
        code: "UNSUPPORTED",
        error: `${request.instrumentId}: native bracket requires whole-share qty; use synthetic protection`,
        retryClass: "none",
      };
    }
    const res = await ready.trade.requestJson(
      { method: "POST", path: "/v2/orders", body: buildAlpacaOrderBody(instrument.value.symbol, request), operation: "economic_mutation" },
      orderSchema,
    );
    if (!res.ok) return this.observe(res);
    return { ok: true, value: mapOrder(res.value) };
  }

  async getOrderByClientId(clientOrderId: string): Promise<ExternalResult<ExternalOrderState>> {
    if (this.offline) {
      const row = this.offline.orders.get(clientOrderId);
      if (!row) return { ok: false, code: "NOT_FOUND", error: `No offline order for clientOrderId=${clientOrderId}`, retryClass: "none" };
      return { ok: true, value: row };
    }
    const res = await this.read("/v2/orders:by_client_order_id", orderSchema, { client_order_id: clientOrderId });
    if (!res.ok) return res;
    return { ok: true, value: mapOrder(res.value) };
  }

  async cancelOrder(brokerOrderId: string): Promise<ExternalResult<{ requested: true }>> {
    if (!brokerOrderId.trim()) return { ok: false, code: "VALIDATION_REJECTED", error: "brokerOrderId required", retryClass: "none" };
    if (this.offline) {
      for (const [key, row] of this.offline.orders) {
        if (row.brokerOrderId === brokerOrderId || row.clientOrderId === brokerOrderId) {
          this.offline.orders.set(key, { ...row, status: "CANCELED", rawStatus: "canceled", updatedAt: new Date().toISOString() });
          return { ok: true, value: { requested: true } };
        }
      }
      return { ok: false, code: "NOT_FOUND", error: `No offline order for brokerOrderId=${brokerOrderId}`, retryClass: "none" };
    }
    const ready = await this.ensureVerified();
    if (!ready.ok) return ready;
    const res = await ready.trade.requestNoContent({
      method: "DELETE",
      path: `/v2/orders/${encodeURIComponent(brokerOrderId)}`,
      operation: "cancel",
    });
    if (!res.ok) return this.observe(res);
    return { ok: true, value: { requested: true } };
  }

  /**
   * Orders are paged by `after` (submitted_at, exclusive). The cursor steps back 1ms and dedupes by id so
   * orders sharing a timestamp are not skipped; the window is complete once a page yields no new ids.
   */
  async listOrders(input: {
    status: "open" | "all";
    after?: string;
    until?: string;
    limit?: number;
    maxPages?: number;
  }): Promise<ExternalResult<ExternalPage<ExternalOrderState>>> {
    if (this.offline) {
      const items = [...this.offline.orders.values()].filter((row) =>
        input.status === "all" ? true : !TERMINAL_EXTERNAL_STATUSES.has(row.status),
      );
      return { ok: true, value: { items, complete: true, nextPageToken: null, pagesFetched: 1 } };
    }
    const pageSize = Math.min(Math.max(input.limit ?? 500, 1), 500);
    const maxPages = Math.max(input.maxPages ?? 20, 1);
    const seen = new Map<string, ExternalOrderState>();
    let after = input.after;
    let pagesFetched = 0;
    while (pagesFetched < maxPages) {
      const res = await this.read("/v2/orders", z.array(orderSchema), {
        status: input.status,
        direction: "asc",
        nested: true,
        limit: pageSize,
        after,
        until: input.until,
      });
      if (!res.ok) return res;
      pagesFetched += 1;
      let added = 0;
      for (const row of res.value) {
        if (seen.has(row.id)) continue;
        seen.set(row.id, mapOrder(row));
        added += 1;
      }
      if (res.value.length < pageSize) {
        return { ok: true, value: { items: [...seen.values()], complete: true, nextPageToken: null, pagesFetched } };
      }
      const lastMs = Date.parse(res.value[res.value.length - 1]?.submitted_at ?? "");
      if (added === 0 || !Number.isFinite(lastMs)) {
        // cursor cannot advance (a full page of one timestamp, or no submitted_at): report truncation
        return { ok: true, value: { items: [...seen.values()], complete: false, nextPageToken: after ?? null, pagesFetched } };
      }
      after = new Date(lastMs - 1).toISOString();
    }
    return { ok: true, value: { items: [...seen.values()], complete: false, nextPageToken: after ?? null, pagesFetched } };
  }

  /** GET /v2/account/activities/FILL — individual executions; page_token is the last activity id. */
  async listExecutions(input: {
    after?: string;
    until?: string;
    pageToken?: string | null;
    maxPages?: number;
    pageSize?: number;
    orderId?: string;
  }): Promise<ExternalResult<ExternalPage<ExternalExecution>>> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 100, 1), 100);
    const maxPages = Math.max(input.maxPages ?? 50, 1);
    const seen = new Map<string, ExternalExecution>();
    let token = input.pageToken ?? null;
    let pagesFetched = 0;
    while (pagesFetched < maxPages) {
      const res = await this.read("/v2/account/activities/FILL", z.array(fillActivitySchema), {
        direction: "asc",
        page_size: pageSize,
        after: input.after,
        until: input.until,
        order_id: input.orderId,
        page_token: token,
      });
      if (!res.ok) return res;
      pagesFetched += 1;
      for (const a of res.value) {
        if (seen.has(a.id)) continue;
        seen.set(a.id, {
          executionId: a.id,
          brokerOrderId: a.order_id,
          clientOrderId: null,
          symbol: a.symbol,
          side: a.side === "buy" ? "BUY" : "SELL",
          qty: a.qty,
          price: a.price !== null && new Decimal(a.price).gt(0) ? a.price : null,
          executedAt: a.transaction_time,
          fee: null,
          currency: "USD",
          cumulativeQty: a.cum_qty,
          kind: a.type === "fill" ? "FILL" : "PARTIAL_FILL",
        });
      }
      const last = res.value[res.value.length - 1];
      if (res.value.length < pageSize || !last) {
        return { ok: true, value: { items: [...seen.values()], complete: true, nextPageToken: null, pagesFetched } };
      }
      if (last.id === token) {
        return { ok: false, code: "MALFORMED_RESPONSE", error: "activities pagination did not advance", retryClass: "none" };
      }
      token = last.id;
    }
    return { ok: true, value: { items: [...seen.values()], complete: false, nextPageToken: token, pagesFetched } };
  }

  async getPositions(): Promise<ExternalResult<ExternalPosition[]>> {
    if (this.offline) return { ok: true, value: [] };
    const res = await this.read("/v2/positions", z.array(positionSchema));
    if (!res.ok) return res;
    return {
      ok: true,
      value: res.value.map((p) => ({ symbol: p.symbol, qty: p.qty, avgEntryPrice: p.avg_entry_price, side: p.side })),
    };
  }

  async getAccount(): Promise<ExternalResult<ExternalAccount>> {
    return this.verifyConnection();
  }

  async getQuotes(
    instrumentIds: string[],
  ): Promise<ExternalResult<Array<{ instrumentId: string; bid: string | null; ask: string | null; at: string }>>> {
    const symbols = new Map<string, string[]>();
    for (const id of instrumentIds) {
      const parsed = parseAlpacaInstrumentId(id);
      if (!parsed.ok) return { ok: false, code: "UNSUPPORTED", error: parsed.reason, retryClass: "none" };
      symbols.set(parsed.symbol, [...(symbols.get(parsed.symbol) ?? []), id]);
    }
    if (symbols.size === 0) return { ok: true, value: [] };
    const res = await this.read(
      "/v2/stocks/quotes/latest",
      latestQuotesSchema,
      { symbols: [...symbols.keys()].join(","), feed: this.config.dataFeed ?? "iex" },
      "data",
    );
    if (!res.ok) return res;
    const out: Array<{ instrumentId: string; bid: string | null; ask: string | null; at: string }> = [];
    for (const [symbol, ids] of symbols) {
      const q = res.value.quotes[symbol];
      if (!q) continue;
      // Alpaca reports 0 when there is no active bid/ask.
      const bid = q.bp > 0 ? String(q.bp) : null;
      const ask = q.ap > 0 ? String(q.ap) : null;
      for (const instrumentId of ids) out.push({ instrumentId, bid, ask, at: q.t });
    }
    return { ok: true, value: out };
  }
}

export type PracticeVenueFromEnvResult =
  | { ok: true; venue: AlpacaPracticeVenue }
  | { ok: false; readiness: ProviderReadiness; reason: string; requiredEnv: string[] };

export function practiceVenueFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<AlpacaPracticeVenueOptions, "unsafeTestOnlyLoopback"> = {},
): PracticeVenueFromEnvResult {
  const apiKeyId = env.ALPACA_API_KEY_ID?.trim() ?? "";
  const apiSecretKey = env.ALPACA_API_SECRET_KEY?.trim() ?? "";
  if (!apiKeyId || !apiSecretKey) {
    return {
      ok: false,
      readiness: "MISSING_CREDENTIALS",
      reason: `BLOCKED_EXTERNAL: set ${ALPACA_REQUIRED_ENV.join(" and ")} (Alpaca paper keys)`,
      requiredEnv: [...ALPACA_REQUIRED_ENV],
    };
  }
  const { fetchImpl, timeoutMs, maxReadAttempts, sleep, now, instrumentCacheMs } = options;
  const venue = new AlpacaPracticeVenue(
    {
      apiKeyId,
      apiSecretKey,
      baseUrl: env.ALPACA_PAPER_BASE_URL?.trim() || ALPACA_DEFAULT_TRADE_URL,
      dataBaseUrl: env.ALPACA_DATA_BASE_URL?.trim() || ALPACA_DEFAULT_DATA_URL,
      dataFeed: env.ALPACA_DATA_FEED?.trim() || undefined,
    },
    { fetchImpl, timeoutMs, maxReadAttempts, sleep, now, instrumentCacheMs },
  );
  const configError = venue.configurationError();
  if (configError) {
    return {
      ok: false,
      readiness: "INVALID_CONFIGURATION",
      reason: `Alpaca practice host rejected (${configError}); only ${ALPACA_DEFAULT_TRADE_URL} and ${ALPACA_DEFAULT_DATA_URL} are allowed`,
      requiredEnv: ["ALPACA_PAPER_BASE_URL", "ALPACA_DATA_BASE_URL"],
    };
  }
  return { ok: true, venue };
}
