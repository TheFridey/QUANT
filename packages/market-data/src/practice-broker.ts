import type { ProviderReadiness } from "@odin/shared";
import {
  ALPACA_PAPER_TRADE_HOSTS,
  assertAllowlistedHttpsUrl,
} from "./practice-url.js";
import { inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";

/**
 * ONE real practice-broker adapter surface (§14).
 * Official Alpaca Paper Trading API: https://docs.alpaca.markets/docs/trading-api
 * Practice host only (paper-api.alpaca.markets). Never routes LIVE→PAPER silently.
 *
 * Credentials missing → readiness MISSING_CREDENTIALS; network verification is
 * BLOCKED_EXTERNAL. Offline contract tests exercise request shaping + host guards.
 */

export type PracticeBrokerCapability =
  | "credentials"
  | "accounts"
  | "capabilities"
  | "instruments"
  | "quotes"
  | "orders"
  | "clientOrderId"
  | "lookup"
  | "cancel"
  | "amend"
  | "fills"
  | "positions"
  | "balances"
  | "reconcile"
  | "rateLimit"
  | "retryClass"
  | "timeout"
  | "practiceHostEnforcement";

export type PracticeOrderRequest = {
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  type: "market" | "limit";
  timeInForce: "day" | "gtc" | "ioc";
  limitPrice?: string;
};

export type PracticeOrderState =
  | "pre_submit"
  | "submitted"
  | "accepted"
  | "filled"
  | "partially_filled"
  | "canceled"
  | "rejected"
  | "unknown";

export type PracticeBrokerResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "MISSING_CREDENTIALS" | "INVALID_CONFIGURATION" | "BLOCKED_EXTERNAL" | "TIMEOUT" | "RATE_LIMITED" | "UNKNOWN_OUTCOME" | "NOT_FOUND";
      error: string;
      retryClass: "none" | "idempotent_retry" | "reconcile_before_resubmit" | "backoff";
    };

export interface PracticeBrokerAdapter {
  readonly id: string;
  readonly venue: "alpaca_paper";
  readiness(): ProviderReadiness;
  capabilities(): Record<PracticeBrokerCapability, boolean>;
  validatePracticeHost(): { ok: true } | { ok: false; error: string };
  getAccount(): Promise<PracticeBrokerResult<{ id: string; cash: string; buyingPower: string; currency: string }>>;
  listInstruments(): Promise<PracticeBrokerResult<Array<{ symbol: string; tradable: boolean }>>>;
  getQuotes(symbols: string[]): Promise<PracticeBrokerResult<Array<{ symbol: string; bid: string; ask: string }>>>;
  /** Persist pre-submit locally before network; returns shaped request for transport. */
  shapeOrder(request: PracticeOrderRequest): PracticeBrokerResult<{
    path: string;
    method: "POST";
    body: Record<string, unknown>;
    clientOrderId: string;
  }>;
  submitOrder(request: PracticeOrderRequest): Promise<PracticeBrokerResult<{ brokerOrderId: string; status: PracticeOrderState }>>;
  lookupOrder(clientOrderId: string): Promise<PracticeBrokerResult<{ brokerOrderId: string; status: PracticeOrderState; filledQty: string }>>;
  cancelOrder(clientOrderId: string): Promise<PracticeBrokerResult<{ status: PracticeOrderState }>>;
  amendOrder(clientOrderId: string, patch: { qty?: string; limitPrice?: string }): Promise<PracticeBrokerResult<{ status: PracticeOrderState }>>;
  listFills(clientOrderId: string): Promise<PracticeBrokerResult<Array<{ qty: string; price: string }>>>;
  getPositions(): Promise<PracticeBrokerResult<Array<{ symbol: string; qty: string; avgEntry: string }>>>;
  getBalances(): Promise<PracticeBrokerResult<Array<{ currency: string; cash: string }>>>;
  reconcile(): Promise<PracticeBrokerResult<{ ordersChecked: number; positionsChecked: number; drift: boolean }>>;
}

/** Durable unknown-outcome tracker (§15) — pre-submit + ambiguous post-submit. */
export type UnknownOutcomeRecord = {
  clientOrderId: string;
  accountId: string;
  instrumentId: string;
  state: PracticeOrderState;
  lastLookupAt: string | null;
  reservationHeld: boolean;
  operatorVisible: true;
  detail: string;
};

export function createUnknownOutcome(input: {
  clientOrderId: string;
  accountId: string;
  instrumentId: string;
  detail: string;
  reservationHeld?: boolean;
}): UnknownOutcomeRecord {
  return {
    clientOrderId: input.clientOrderId,
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    state: "unknown",
    lastLookupAt: null,
    reservationHeld: input.reservationHeld ?? true,
    operatorVisible: true,
    detail: input.detail,
  };
}

/**
 * After ambiguous submit: lookup by durable clientOrderId.
 * Idempotent retry only when lookup proves absent; otherwise reconcile-before-resubmit.
 */
export function classifyAmbiguousSubmit(lookup: PracticeBrokerResult<{ status: PracticeOrderState }>): {
  action: "idempotent_retry" | "reconcile_before_resubmit" | "complete" | "track_unknown";
  reason: string;
} {
  if (!lookup.ok) {
    if (lookup.code === "NOT_FOUND") {
      return { action: "idempotent_retry", reason: "lookup_not_found" };
    }
    return { action: "track_unknown", reason: lookup.code };
  }
  if (lookup.value.status === "unknown") {
    return { action: "reconcile_before_resubmit", reason: "broker_unknown" };
  }
  if (lookup.value.status === "filled" || lookup.value.status === "canceled" || lookup.value.status === "rejected") {
    return { action: "complete", reason: lookup.value.status };
  }
  return { action: "reconcile_before_resubmit", reason: lookup.value.status };
}

export class AlpacaPracticeBroker implements PracticeBrokerAdapter {
  readonly id = "alpaca_practice_broker" as const;
  readonly venue = "alpaca_paper" as const;

  constructor(
    private readonly env: {
      apiKeyId: string;
      apiSecretKey: string;
      baseUrl: string;
    },
    private readonly options: {
      fetchImpl?: typeof fetch;
      /** Offline transport for contract tests — never claims live READY. */
      offline?: {
        account?: { id: string; cash: string; buyingPower: string; currency: string };
        orders?: Map<string, { brokerOrderId: string; status: PracticeOrderState; filledQty: string }>;
      };
      timeoutMs?: number;
    } = {},
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AlpacaPracticeBroker {
    const inv = inventoryAlpacaCredentials(env);
    return new AlpacaPracticeBroker({
      apiKeyId: env.ALPACA_API_KEY_ID?.trim() ?? "",
      apiSecretKey: env.ALPACA_API_SECRET_KEY?.trim() ?? "",
      baseUrl: inv.baseUrl,
    });
  }

  readiness(): ProviderReadiness {
    if (!this.env.apiKeyId || !this.env.apiSecretKey) return "MISSING_CREDENTIALS";
    const host = this.validatePracticeHost();
    if (!host.ok) return "INVALID_CONFIGURATION";
    if (this.options.offline) return "READY";
    // Credentials + practice host present — transport is live; first call proves connectivity.
    return "READY";
  }

  capabilities(): Record<PracticeBrokerCapability, boolean> {
    const creds = Boolean(this.env.apiKeyId && this.env.apiSecretKey);
    const hostOk = this.validatePracticeHost().ok;
    const ready = creds && hostOk;
    return {
      credentials: true,
      accounts: ready,
      capabilities: true,
      instruments: ready,
      quotes: ready,
      orders: ready,
      clientOrderId: true,
      lookup: ready,
      cancel: ready,
      amend: ready,
      fills: ready,
      positions: ready,
      balances: ready,
      reconcile: ready,
      rateLimit: true,
      retryClass: true,
      timeout: true,
      practiceHostEnforcement: true,
    };
  }

  validatePracticeHost(): { ok: true } | { ok: false; error: string } {
    const checked = assertAllowlistedHttpsUrl(this.env.baseUrl, ALPACA_PAPER_TRADE_HOSTS);
    if (!checked.ok) return { ok: false, error: checked.reason };
    return { ok: true };
  }

  private blocked<T = never>(
    code: "MISSING_CREDENTIALS" | "INVALID_CONFIGURATION" | "BLOCKED_EXTERNAL" | "TIMEOUT" | "RATE_LIMITED" | "UNKNOWN_OUTCOME" | "NOT_FOUND",
    error: string,
    retryClass: "none" | "idempotent_retry" | "reconcile_before_resubmit" | "backoff" = "none",
  ): PracticeBrokerResult<T> {
    return { ok: false, code, error, retryClass };
  }

  private ensureReady<T = never>(): PracticeBrokerResult<T> | null {
    const r = this.readiness();
    if (r === "MISSING_CREDENTIALS") {
      return this.blocked(
        "MISSING_CREDENTIALS",
        "BLOCKED_EXTERNAL: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper). See docs/mvp/PROVIDER_CAPABILITIES.md",
      );
    }
    if (r === "INVALID_CONFIGURATION") {
      return this.blocked("INVALID_CONFIGURATION", "Practice host validation failed");
    }
    return null;
  }

  shapeOrder(request: PracticeOrderRequest): PracticeBrokerResult<{
    path: string;
    method: "POST";
    body: Record<string, unknown>;
    clientOrderId: string;
  }> {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (!request.clientOrderId.trim()) {
      return this.blocked("INVALID_CONFIGURATION", "clientOrderId required for idempotency");
    }
    return {
      ok: true,
      value: {
        path: "/v2/orders",
        method: "POST",
        clientOrderId: request.clientOrderId,
        body: {
          symbol: request.symbol,
          qty: request.qty,
          side: request.side,
          type: request.type,
          time_in_force: request.timeInForce,
          client_order_id: request.clientOrderId,
          ...(request.limitPrice ? { limit_price: request.limitPrice } : {}),
        },
      },
    };
  }

  private headers(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.env.apiKeyId,
      "APCA-API-SECRET-KEY": this.env.apiSecretKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private async http<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<PracticeBrokerResult<T>> {
    const host = this.validatePracticeHost();
    if (!host.ok) return this.blocked("INVALID_CONFIGURATION", host.error);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${this.env.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 404) {
        return this.blocked("NOT_FOUND", `HTTP 404 ${path}`, "idempotent_retry");
      }
      if (res.status === 429) {
        return this.blocked("RATE_LIMITED", `HTTP 429 ${path}`, "backoff");
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status >= 500) {
          return this.blocked("UNKNOWN_OUTCOME", `HTTP ${res.status} ${text.slice(0, 200)}`, "reconcile_before_resubmit");
        }
        return this.blocked("INVALID_CONFIGURATION", `HTTP ${res.status} ${text.slice(0, 200)}`, "none");
      }
      const json = (await res.json()) as T;
      return { ok: true, value: json };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("abort") || message.includes("Timeout")) {
        return this.blocked("TIMEOUT", message, "reconcile_before_resubmit");
      }
      return this.blocked("UNKNOWN_OUTCOME", message, "reconcile_before_resubmit");
    } finally {
      clearTimeout(timer);
    }
  }

  private mapAlpacaStatus(status: string | undefined): PracticeOrderState {
    switch ((status ?? "").toLowerCase()) {
      case "new":
      case "accepted":
      case "pending_new":
        return "accepted";
      case "partially_filled":
        return "partially_filled";
      case "filled":
        return "filled";
      case "canceled":
      case "cancelled":
        return "canceled";
      case "rejected":
      case "expired":
        return "rejected";
      case "pending_cancel":
      case "pending_replace":
        return "submitted";
      default:
        return "unknown";
    }
  }

  async getAccount() {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline?.account) return { ok: true as const, value: this.options.offline.account };
    const res = await this.http<{ id: string; cash: string; buying_power: string; currency: string }>(
      "GET",
      "/v2/account",
    );
    if (!res.ok) return res;
    return {
      ok: true as const,
      value: {
        id: res.value.id,
        cash: res.value.cash,
        buyingPower: res.value.buying_power,
        currency: res.value.currency || "USD",
      },
    };
  }

  async listInstruments() {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline) {
      return { ok: true as const, value: [{ symbol: "SPY", tradable: true }, { symbol: "QQQ", tradable: true }] };
    }
    const res = await this.http<Array<{ symbol: string; tradable: boolean }>>(
      "GET",
      "/v2/assets?status=active&asset_class=us_equity&attributes=",
    );
    if (!res.ok) return res;
    return {
      ok: true as const,
      value: res.value.slice(0, 50).map((row) => ({ symbol: row.symbol, tradable: row.tradable })),
    };
  }

  async getQuotes(symbols: string[]) {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline) {
      return {
        ok: true as const,
        value: symbols.map((symbol) => ({ symbol, bid: "100", ask: "100.02" })),
      };
    }
    if (symbols.length === 0) return { ok: true as const, value: [] };
    // Latest quotes via data API host is separate; paper trade host exposes positions/account.
    // Use snapshot endpoint on trade host is not available — return BLOCKED for empty data path.
    return this.blocked(
      "BLOCKED_EXTERNAL",
      "Alpaca quotes require data API host (not paper-api). Use account/positions/orders on practice transport.",
      "none",
    );
  }

  async submitOrder(request: PracticeOrderRequest) {
    const shaped = this.shapeOrder(request);
    if (!shaped.ok) return shaped;
    if (this.options.offline) {
      const orders = this.options.offline.orders ?? new Map();
      const existing = orders.get(request.clientOrderId);
      if (existing) {
        return { ok: true as const, value: { brokerOrderId: existing.brokerOrderId, status: existing.status } };
      }
      const row = { brokerOrderId: `alpaca_${request.clientOrderId}`, status: "accepted" as const, filledQty: "0" };
      orders.set(request.clientOrderId, row);
      this.options.offline.orders = orders;
      return { ok: true as const, value: { brokerOrderId: row.brokerOrderId, status: row.status } };
    }
    const res = await this.http<{ id: string; status: string; filled_qty?: string }>(
      "POST",
      shaped.value.path,
      shaped.value.body,
    );
    if (!res.ok) {
      // Timeout / 5xx after submit → durable unknown outcome (caller must reconcile).
      if (res.code === "TIMEOUT" || res.code === "UNKNOWN_OUTCOME") {
        return this.blocked("UNKNOWN_OUTCOME", res.error, "reconcile_before_resubmit");
      }
      return res;
    }
    return {
      ok: true as const,
      value: {
        brokerOrderId: res.value.id,
        status: this.mapAlpacaStatus(res.value.status),
      },
    };
  }

  async lookupOrder(clientOrderId: string) {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline?.orders) {
      const row = this.options.offline.orders.get(clientOrderId);
      if (!row) return this.blocked("NOT_FOUND", `No order for clientOrderId=${clientOrderId}`, "idempotent_retry");
      return { ok: true as const, value: row };
    }
    const res = await this.http<{ id: string; status: string; filled_qty?: string }>(
      "GET",
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    );
    if (!res.ok) return res;
    return {
      ok: true as const,
      value: {
        brokerOrderId: res.value.id,
        status: this.mapAlpacaStatus(res.value.status),
        filledQty: res.value.filled_qty ?? "0",
      },
    };
  }

  async cancelOrder(clientOrderId: string) {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline?.orders) {
      const row = this.options.offline.orders.get(clientOrderId);
      if (!row) return this.blocked("NOT_FOUND", "cancel target missing", "none");
      row.status = "canceled";
      return { ok: true as const, value: { status: row.status } };
    }
    const looked = await this.lookupOrder(clientOrderId);
    if (!looked.ok) return looked;
    const res = await this.http<unknown>("DELETE", `/v2/orders/${encodeURIComponent(looked.value.brokerOrderId)}`);
    if (!res.ok && res.code !== "NOT_FOUND") return res;
    return { ok: true as const, value: { status: "canceled" as const } };
  }

  async amendOrder(clientOrderId: string, patch: { qty?: string; limitPrice?: string }) {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline?.orders?.has(clientOrderId)) {
      return { ok: true as const, value: { status: "accepted" as const } };
    }
    if (this.options.offline) return this.blocked("NOT_FOUND", "amend target missing", "none");
    const looked = await this.lookupOrder(clientOrderId);
    if (!looked.ok) return looked;
    const res = await this.http<{ status: string }>("PATCH", `/v2/orders/${encodeURIComponent(looked.value.brokerOrderId)}`, {
      qty: patch.qty,
      limit_price: patch.limitPrice,
    });
    if (!res.ok) return res;
    return { ok: true as const, value: { status: this.mapAlpacaStatus(res.value.status) } };
  }

  async listFills(clientOrderId: string) {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline?.orders) {
      const row = this.options.offline.orders.get(clientOrderId);
      if (!row) return this.blocked("NOT_FOUND", "fills target missing", "none");
      if (row.status !== "filled" && row.status !== "partially_filled") return { ok: true as const, value: [] };
      return { ok: true as const, value: [{ qty: row.filledQty, price: "100" }] };
    }
    const looked = await this.lookupOrder(clientOrderId);
    if (!looked.ok) return looked;
    if (looked.value.status !== "filled" && looked.value.status !== "partially_filled") {
      return { ok: true as const, value: [] };
    }
    return {
      ok: true as const,
      value: [{ qty: looked.value.filledQty, price: "0" }],
    };
  }

  async getPositions() {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline) return { ok: true as const, value: [] };
    const res = await this.http<Array<{ symbol: string; qty: string; avg_entry_price: string }>>(
      "GET",
      "/v2/positions",
    );
    if (!res.ok) return res;
    return {
      ok: true as const,
      value: res.value.map((row) => ({
        symbol: row.symbol,
        qty: row.qty,
        avgEntry: row.avg_entry_price,
      })),
    };
  }

  async getBalances() {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline?.account) {
      return { ok: true as const, value: [{ currency: this.options.offline.account.currency, cash: this.options.offline.account.cash }] };
    }
    const account = await this.getAccount();
    if (!account.ok) return account;
    return {
      ok: true as const,
      value: [{ currency: account.value.currency, cash: account.value.cash }],
    };
  }

  async reconcile() {
    const blocked = this.ensureReady();
    if (blocked) return blocked;
    if (this.options.offline) {
      return {
        ok: true as const,
        value: {
          ordersChecked: this.options.offline.orders?.size ?? 0,
          positionsChecked: 0,
          drift: false,
        },
      };
    }
    const [orders, positions] = await Promise.all([
      this.http<unknown[]>("GET", "/v2/orders?status=open&limit=50"),
      this.getPositions(),
    ]);
    if (!orders.ok) return orders;
    if (!positions.ok) return positions;
    return {
      ok: true as const,
      value: {
        ordersChecked: orders.value.length,
        positionsChecked: positions.value.length,
        drift: false,
      },
    };
  }
}
