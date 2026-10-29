import type { ProviderReadiness } from "@odin/shared";

/**
 * Shared external-execution contract (Stages 14–22).
 *
 * Implemented by the practice adapters (market-data) and consumed by the worker
 * SANDBOX lifecycle (apps/worker/src/sandbox-execution.ts). Economic state is
 * never inferred from HTTP success alone: callers must look up terminal state.
 */

export type ExternalErrorCode =
  | "MISSING_CREDENTIALS"
  | "INVALID_CONFIGURATION"
  | "AUTH_FAILED"
  | "VALIDATION_REJECTED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "UNKNOWN_OUTCOME"
  | "MALFORMED_RESPONSE"
  | "UNSUPPORTED"
  | "REDIRECT_REFUSED"
  | "NETWORK";

/**
 * - none: do not retry (definitive).
 * - idempotent_retry: safe to retry the same read / same clientOrderId submit.
 * - reconcile_before_resubmit: economic outcome unknown — lookup before any resubmit.
 * - backoff: wait (respect retryAfterMs) then retry.
 */
export type ExternalRetryClass = "none" | "idempotent_retry" | "reconcile_before_resubmit" | "backoff";

export type ExternalResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: ExternalErrorCode;
      /** Sanitized — never contains credentials. */
      error: string;
      retryClass: ExternalRetryClass;
      httpStatus?: number;
      retryAfterMs?: number;
    };

export type ExternalOrderStatus =
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "UNKNOWN";

export const TERMINAL_EXTERNAL_STATUSES: ReadonlySet<ExternalOrderStatus> = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

export type ExternalOrderState = {
  brokerOrderId: string;
  clientOrderId: string;
  status: ExternalOrderStatus;
  /** Raw venue status string for diagnostics. */
  rawStatus: string;
  side: "BUY" | "SELL";
  symbol: string;
  qty: string;
  /** Cumulative filled quantity — NOT an individual execution. */
  filledQty: string;
  /** Venue-reported average fill price; null when absent. Never "0" as a placeholder. */
  avgFillPrice: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
  /** Bracket/OCO child legs when the venue reports them. */
  legs?: ExternalOrderState[];
};

export type ExternalExecution = {
  /** Venue execution/activity id — dedupe key. */
  executionId: string;
  brokerOrderId: string;
  /** Not every venue returns it on activities; map via brokerOrderId. */
  clientOrderId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  qty: string;
  /** Null means the venue did not report a price: incomplete, never booked at 0. */
  price: string | null;
  executedAt: string;
  /** Null when the venue does not report fees (do not invent). */
  fee: string | null;
  currency: string;
  /** Cumulative qty after this execution when reported. */
  cumulativeQty: string | null;
  kind: "FILL" | "PARTIAL_FILL" | "CORRECTION" | "BUST";
};

export type ExternalPage<T> = {
  items: T[];
  /** True only when the full requested window was paginated. */
  complete: boolean;
  nextPageToken: string | null;
  pagesFetched: number;
};

export type ExternalPosition = { symbol: string; qty: string; avgEntryPrice: string | null; side: "long" | "short" };

export type ExternalAccount = {
  accountId: string;
  status: string;
  currency: string;
  cash: string;
  buyingPower: string;
  equity: string | null;
  /** True only when the host and account are verified practice/paper. */
  isPractice: boolean;
};

export type ExternalInstrument = {
  instrumentId: string;
  symbol: string;
  assetClass: string;
  tradable: boolean;
  fractionable: boolean;
  shortable: boolean;
  minQty: string | null;
  qtyIncrement: string | null;
  /** NATIVE_BRACKET when the venue supports server-side bracket/OCO for this product. */
  protection: "NATIVE_BRACKET" | "SYNTHETIC" | "NONE";
};

export type ExternalSubmitRequest = {
  clientOrderId: string;
  instrumentId: string;
  side: "BUY" | "SELL";
  qty: string;
  type: "market" | "limit";
  timeInForce: "day" | "gtc" | "ioc";
  limitPrice?: string;
  /** Native bracket protection when supported (prices are triggers, not guaranteed fills). */
  bracket?: { stopPrice: string; takeProfitPrice?: string };
};

export type ConnectionState =
  | "NOT_CONFIGURED"
  | "CONFIGURED_UNVERIFIED"
  | "VERIFIED"
  | "AUTH_FAILED"
  | "UNREACHABLE"
  | "NOT_PRACTICE";

export type ExternalCapabilities = {
  submit: boolean;
  cancel: boolean;
  lookup: boolean;
  executions: boolean;
  positions: boolean;
  balances: boolean;
  quotes: boolean;
  nativeProtection: boolean;
  reconcile: boolean;
};

export interface ExternalExecutionVenue {
  readonly venue: string;
  readiness(): ProviderReadiness;
  connectionState(): ConnectionState;
  capabilities(): ExternalCapabilities;
  verifyConnection(): Promise<ExternalResult<ExternalAccount>>;
  resolveInstrument(instrumentId: string): Promise<ExternalResult<ExternalInstrument>>;
  submitOrder(request: ExternalSubmitRequest): Promise<ExternalResult<ExternalOrderState>>;
  getOrderByClientId(clientOrderId: string): Promise<ExternalResult<ExternalOrderState>>;
  /** Cancel *request*; confirmation must come from a later lookup. 204 is a valid success. */
  cancelOrder(brokerOrderId: string): Promise<ExternalResult<{ requested: true }>>;
  listOrders(input: { status: "open" | "all"; after?: string; limit?: number }): Promise<ExternalResult<ExternalPage<ExternalOrderState>>>;
  listExecutions(input: { after?: string; until?: string; pageToken?: string | null; maxPages?: number }): Promise<ExternalResult<ExternalPage<ExternalExecution>>>;
  getPositions(): Promise<ExternalResult<ExternalPosition[]>>;
  getQuotes(instrumentIds: string[]): Promise<ExternalResult<Array<{ instrumentId: string; bid: string | null; ask: string | null; at: string }>>>;
}
