import type { ProviderReadiness } from "@odin/shared";
import {
  AlpacaPracticeVenue,
  ALPACA_DEFAULT_DATA_URL,
  ALPACA_DEFAULT_TRADE_URL,
  ALPACA_REQUIRED_ENV,
  buildAlpacaOrderBody,
  parseAlpacaInstrumentId,
  type AlpacaPracticeVenueOptions,
} from "./alpaca-practice-venue.js";
import { compareBrokerState, type LocalBrokerSnapshot, type ReconcileReport } from "./broker-reconcile.js";
import type {
  ExternalErrorCode,
  ExternalExecutionVenue,
  ExternalOrderStatus,
  ExternalResult,
  ExternalRetryClass,
} from "./execution-contract.js";
import { ALPACA_PAPER_TRADE_HOSTS_STRICT, assertAllowlistedHttpsUrl } from "./practice-url.js";
import { inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";

/**
 * Legacy practice-broker surface (§14), now a thin facade over AlpacaPracticeVenue.
 * Official Alpaca Paper Trading API: https://docs.alpaca.markets/docs/trading-api
 * Practice host only (paper-api.alpaca.markets). Never routes LIVE→PAPER silently.
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
  | "cancel_pending"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

export type PracticeBrokerResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: ExternalErrorCode | "BLOCKED_EXTERNAL";
      error: string;
      retryClass: ExternalRetryClass;
    };

export type PracticeReconcileResult =
  | { comparable: false; reason: string; ordersChecked: number; positionsChecked: number }
  | { comparable: true; report: ReconcileReport };

export interface PracticeBrokerAdapter {
  readonly id: string;
  readonly venue: "alpaca_paper";
  readiness(): ProviderReadiness;
  capabilities(): Record<PracticeBrokerCapability, boolean>;
  validatePracticeHost(): { ok: true } | { ok: false; error: string };
  getAccount(): Promise<PracticeBrokerResult<{ id: string; cash: string; buyingPower: string; currency: string }>>;
  listInstruments(): Promise<PracticeBrokerResult<Array<{ symbol: string; tradable: boolean }>>>;
  getQuotes(symbols: string[]): Promise<PracticeBrokerResult<Array<{ symbol: string; bid: string | null; ask: string | null }>>>;
  /** Pure request shaping (no network). */
  shapeOrder(request: PracticeOrderRequest): PracticeBrokerResult<{
    path: string;
    method: "POST";
    body: Record<string, unknown>;
    clientOrderId: string;
  }>;
  submitOrder(request: PracticeOrderRequest): Promise<PracticeBrokerResult<{ brokerOrderId: string; status: PracticeOrderState }>>;
  lookupOrder(clientOrderId: string): Promise<PracticeBrokerResult<{ brokerOrderId: string; status: PracticeOrderState; filledQty: string }>>;
  /** Cancel *request*: status reflects the broker's state, never an assumed `canceled`. */
  cancelOrder(clientOrderId: string): Promise<PracticeBrokerResult<{ status: PracticeOrderState }>>;
  amendOrder(clientOrderId: string, patch: { qty?: string; limitPrice?: string }): Promise<PracticeBrokerResult<{ status: PracticeOrderState }>>;
  listFills(clientOrderId: string): Promise<PracticeBrokerResult<Array<{ executionId: string; qty: string; price: string | null }>>>;
  getPositions(): Promise<PracticeBrokerResult<Array<{ symbol: string; qty: string; avgEntry: string | null }>>>;
  getBalances(): Promise<PracticeBrokerResult<Array<{ currency: string; cash: string }>>>;
  reconcile(local?: LocalBrokerSnapshot, window?: { after: string; until?: string }): Promise<PracticeBrokerResult<PracticeReconcileResult>>;
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
  if (
    lookup.value.status === "filled" ||
    lookup.value.status === "canceled" ||
    lookup.value.status === "rejected" ||
    lookup.value.status === "expired"
  ) {
    return { action: "complete", reason: lookup.value.status };
  }
  return { action: "reconcile_before_resubmit", reason: lookup.value.status };
}

export function toPracticeOrderState(status: ExternalOrderStatus): PracticeOrderState {
  switch (status) {
    case "ACCEPTED":
      return "accepted";
    case "PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCEL_PENDING":
      return "cancel_pending";
    case "CANCELED":
      return "canceled";
    case "REJECTED":
      return "rejected";
    case "EXPIRED":
      return "expired";
    default:
      return "unknown";
  }
}

const TERMINAL_PRACTICE_STATES: ReadonlySet<PracticeOrderState> = new Set(["filled", "canceled", "rejected", "expired"]);

function unsupported<T>(error: string): PracticeBrokerResult<T> {
  return { ok: false, code: "UNSUPPORTED", error, retryClass: "none" };
}

export class AlpacaPracticeBroker implements PracticeBrokerAdapter {
  readonly id = "alpaca_practice_broker" as const;
  readonly venue = "alpaca_paper" as const;
  private readonly practice: AlpacaPracticeVenue;

  constructor(
    private readonly env: {
      apiKeyId: string;
      apiSecretKey: string;
      baseUrl: string;
      dataBaseUrl?: string;
    },
    options: AlpacaPracticeVenueOptions = {},
  ) {
    this.practice = new AlpacaPracticeVenue(
      { apiKeyId: env.apiKeyId, apiSecretKey: env.apiSecretKey, baseUrl: env.baseUrl, dataBaseUrl: env.dataBaseUrl },
      options,
    );
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AlpacaPracticeBroker {
    const inv = inventoryAlpacaCredentials(env);
    return new AlpacaPracticeBroker({
      apiKeyId: env.ALPACA_API_KEY_ID?.trim() ?? "",
      apiSecretKey: env.ALPACA_API_SECRET_KEY?.trim() ?? "",
      baseUrl: inv.baseUrl || ALPACA_DEFAULT_TRADE_URL,
      dataBaseUrl: inv.dataUrl || ALPACA_DEFAULT_DATA_URL,
    });
  }

  /** The underlying contract venue (preferred for new callers). */
  externalVenue(): AlpacaPracticeVenue {
    return this.practice;
  }

  readiness(): ProviderReadiness {
    return this.practice.readiness();
  }

  capabilities(): Record<PracticeBrokerCapability, boolean> {
    const caps = this.practice.capabilities();
    return {
      credentials: true,
      accounts: caps.balances,
      capabilities: true,
      instruments: false,
      quotes: caps.quotes,
      orders: caps.submit,
      clientOrderId: true,
      lookup: caps.lookup,
      cancel: caps.cancel,
      amend: false,
      fills: caps.executions,
      positions: caps.positions,
      balances: caps.balances,
      reconcile: caps.reconcile,
      rateLimit: true,
      retryClass: true,
      timeout: true,
      practiceHostEnforcement: true,
    };
  }

  validatePracticeHost(): { ok: true } | { ok: false; error: string } {
    const configError = this.practice.configurationError();
    if (configError) return { ok: false, error: configError };
    const checked = assertAllowlistedHttpsUrl(this.env.baseUrl || ALPACA_DEFAULT_TRADE_URL, ALPACA_PAPER_TRADE_HOSTS_STRICT);
    if (!checked.ok) return { ok: false, error: checked.reason };
    return { ok: true };
  }

  private preflight<T>(): PracticeBrokerResult<T> | null {
    const r = this.readiness();
    if (r === "MISSING_CREDENTIALS") {
      return {
        ok: false,
        code: "MISSING_CREDENTIALS",
        error: `BLOCKED_EXTERNAL: set ${ALPACA_REQUIRED_ENV.join(" and ")} (paper). See docs/mvp/PROVIDER_CAPABILITIES.md`,
        retryClass: "none",
      };
    }
    if (r === "INVALID_CONFIGURATION") {
      return { ok: false, code: "INVALID_CONFIGURATION", error: "Practice host validation failed", retryClass: "none" };
    }
    return null;
  }

  shapeOrder(request: PracticeOrderRequest): PracticeBrokerResult<{
    path: string;
    method: "POST";
    body: Record<string, unknown>;
    clientOrderId: string;
  }> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    if (!request.clientOrderId.trim()) {
      return { ok: false, code: "VALIDATION_REJECTED", error: "clientOrderId required for idempotency", retryClass: "none" };
    }
    const parsed = parseAlpacaInstrumentId(`equity:${request.symbol}`);
    if (!parsed.ok) return unsupported(parsed.reason);
    return {
      ok: true,
      value: {
        path: "/v2/orders",
        method: "POST",
        clientOrderId: request.clientOrderId,
        body: buildAlpacaOrderBody(parsed.symbol, {
          clientOrderId: request.clientOrderId,
          instrumentId: `equity:${parsed.symbol}`,
          side: request.side === "buy" ? "BUY" : "SELL",
          qty: request.qty,
          type: request.type,
          timeInForce: request.timeInForce,
          limitPrice: request.limitPrice,
        }),
      },
    };
  }

  async getAccount(): Promise<PracticeBrokerResult<{ id: string; cash: string; buyingPower: string; currency: string }>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    const res = await this.practice.verifyConnection();
    if (!res.ok) return res;
    return {
      ok: true,
      value: { id: res.value.accountId, cash: res.value.cash, buyingPower: res.value.buyingPower, currency: res.value.currency },
    };
  }

  async listInstruments(): Promise<PracticeBrokerResult<Array<{ symbol: string; tradable: boolean }>>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    return unsupported("instrument listing is not implemented; use resolveInstrument on the practice venue");
  }

  async getQuotes(symbols: string[]): Promise<PracticeBrokerResult<Array<{ symbol: string; bid: string | null; ask: string | null }>>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    const res = await this.practice.getQuotes(symbols.map((s) => `equity:${s}`));
    if (!res.ok) return res;
    return {
      ok: true,
      value: res.value.map((q) => ({ symbol: q.instrumentId.slice("equity:".length), bid: q.bid, ask: q.ask })),
    };
  }

  async submitOrder(request: PracticeOrderRequest): Promise<PracticeBrokerResult<{ brokerOrderId: string; status: PracticeOrderState }>> {
    const shaped = this.shapeOrder(request);
    if (!shaped.ok) return shaped;
    const res = await this.practice.submitOrder({
      clientOrderId: request.clientOrderId,
      instrumentId: `equity:${request.symbol}`,
      side: request.side === "buy" ? "BUY" : "SELL",
      qty: request.qty,
      type: request.type,
      timeInForce: request.timeInForce,
      limitPrice: request.limitPrice,
    });
    if (!res.ok) return res;
    return { ok: true, value: { brokerOrderId: res.value.brokerOrderId, status: toPracticeOrderState(res.value.status) } };
  }

  async lookupOrder(
    clientOrderId: string,
  ): Promise<PracticeBrokerResult<{ brokerOrderId: string; status: PracticeOrderState; filledQty: string }>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    const res = await this.practice.getOrderByClientId(clientOrderId);
    if (!res.ok) return res;
    return {
      ok: true,
      value: { brokerOrderId: res.value.brokerOrderId, status: toPracticeOrderState(res.value.status), filledQty: res.value.filledQty },
    };
  }

  async cancelOrder(clientOrderId: string): Promise<PracticeBrokerResult<{ status: PracticeOrderState }>> {
    const looked = await this.lookupOrder(clientOrderId);
    if (!looked.ok) return looked;
    if (TERMINAL_PRACTICE_STATES.has(looked.value.status)) return { ok: true, value: { status: looked.value.status } };
    const res = await this.practice.cancelOrder(looked.value.brokerOrderId);
    if (!res.ok) return res;
    return { ok: true, value: { status: "cancel_pending" } };
  }

  async amendOrder(): Promise<PracticeBrokerResult<{ status: PracticeOrderState }>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    return unsupported("order amendment is not implemented for the practice venue");
  }

  async listFills(clientOrderId: string): Promise<PracticeBrokerResult<Array<{ executionId: string; qty: string; price: string | null }>>> {
    const looked = await this.lookupOrder(clientOrderId);
    if (!looked.ok) return looked;
    const res = await this.practice.listExecutions({ orderId: looked.value.brokerOrderId });
    if (!res.ok) return res;
    if (!res.value.complete) {
      return { ok: false, code: "UNKNOWN_OUTCOME", error: "fill pagination incomplete", retryClass: "idempotent_retry" };
    }
    return { ok: true, value: res.value.items.map((e) => ({ executionId: e.executionId, qty: e.qty, price: e.price })) };
  }

  async getPositions(): Promise<PracticeBrokerResult<Array<{ symbol: string; qty: string; avgEntry: string | null }>>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    const res = await this.practice.getPositions();
    if (!res.ok) return res;
    return { ok: true, value: res.value.map((p) => ({ symbol: p.symbol, qty: p.qty, avgEntry: p.avgEntryPrice })) };
  }

  async getBalances(): Promise<PracticeBrokerResult<Array<{ currency: string; cash: string }>>> {
    const account = await this.getAccount();
    if (!account.ok) return account;
    return { ok: true, value: [{ currency: account.value.currency, cash: account.value.cash }] };
  }

  /** Without a local snapshot nothing is compared, so no drift verdict is returned. */
  async reconcile(
    local?: LocalBrokerSnapshot,
    window?: { after: string; until?: string },
  ): Promise<PracticeBrokerResult<PracticeReconcileResult>> {
    const blocked = this.preflight<never>();
    if (blocked) return blocked;
    if (!local || !window) {
      const [orders, positions] = await Promise.all([
        this.practice.listOrders({ status: "open" }),
        this.practice.getPositions(),
      ]);
      if (!orders.ok) return orders;
      if (!positions.ok) return positions;
      return {
        ok: true,
        value: {
          comparable: false,
          reason: "no local snapshot supplied; call reconcile(local, window) or compareBrokerState",
          ordersChecked: orders.value.items.length,
          positionsChecked: positions.value.length,
        },
      };
    }
    const report = await reconcileVenue(this.practice, local, window);
    if (!report.ok) return report;
    return { ok: true, value: { comparable: true, report: report.value } };
  }
}

/** Fetches broker state for the window and runs compareBrokerState. */
export async function reconcileVenue(
  venue: ExternalExecutionVenue,
  local: LocalBrokerSnapshot,
  window: { after: string; until?: string },
  limits: { maxExecutionPages?: number } = {},
): Promise<ExternalResult<ReconcileReport>> {
  const account = await venue.verifyConnection();
  if (!account.ok) return account;
  const orders = await venue.listOrders({ status: "all", after: window.after });
  if (!orders.ok) return orders;
  const executions = await venue.listExecutions({ after: window.after, until: window.until, maxPages: limits.maxExecutionPages });
  if (!executions.ok) return executions;
  const positions = await venue.getPositions();
  if (!positions.ok) return positions;
  return {
    ok: true,
    value: compareBrokerState({
      local,
      broker: { orders: orders.value, executions: executions.value, positions: positions.value, account: account.value },
      window: { after: window.after, until: window.until ?? null },
    }),
  };
}
