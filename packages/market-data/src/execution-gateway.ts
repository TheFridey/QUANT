import type { ProviderReadiness } from "@odin/shared";
import { resolveExecutionMode, type ExecutionMode } from "@odin/shared";
import { practiceVenueFromEnv, type PracticeVenueFromEnvResult } from "./alpaca-practice-venue.js";
import {
  TERMINAL_EXTERNAL_STATUSES,
  type ExternalExecutionVenue,
  type ExternalOrderState,
  type ExternalSubmitRequest,
} from "./execution-contract.js";
import { inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";
import { inventoryOandaCredentials } from "./providers/oanda-practice.js";

/**
 * Execution gateway (D09/§22–§23): separates local PAPER booking from external SANDBOX/demo.
 * SANDBOX must never silently stamp local PAPER fills. The practice venue is wired when
 * Alpaca paper credentials + host are valid; otherwise MISSING_CREDENTIALS / NOT_IMPLEMENTED.
 */

export type GatewayOrderRequest = {
  clientOrderId: string;
  instrumentId: string;
  side: "BUY" | "SELL";
  qty: string;
  intent?: string;
  type?: "market" | "limit";
  timeInForce?: "day" | "gtc" | "ioc";
  limitPrice?: string;
  bracket?: ExternalSubmitRequest["bracket"];
};

/**
 * - ACKED: admitted for local PAPER booking (not a fill).
 * - CANCEL_REQUESTED: venue accepted a cancel request; confirmation needs a later lookup.
 * Other values mirror ExternalOrderStatus.
 */
export type GatewayOrderStatus =
  | "ACKED"
  | "PENDING"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "UNKNOWN";

export type GatewayOrderView = {
  brokerOrderId: string;
  status: GatewayOrderStatus;
  filledQty: string;
};

export type GatewayOrderAck =
  | ({
      ok: true;
      venue: string;
      rawStatus?: string;
    } & GatewayOrderView)
  | {
      ok: false;
      code: string;
      error: string;
      readiness: ProviderReadiness;
      retryClass?: string;
      /** Present when the order exists but the action is not possible (e.g. cancel after fill). */
      order?: GatewayOrderView;
    };

export type GatewayBalanceSnapshot = {
  cash: string | null;
  currency: string;
  asOf: string | null;
};

export type GatewayPositionSnapshot = {
  instrumentId: string;
  qty: string;
  avgPrice: string | null;
};

export type LocalPaperCancelResult =
  | { outcome: "CANCELED"; order: GatewayOrderView }
  | { outcome: "NOT_CANCELABLE"; order: GatewayOrderView }
  | { outcome: "NOT_FOUND" };

/** Durable local PAPER ledger — the only authority for local order state. */
export type LocalPaperBook = {
  getOrder(clientOrderId: string): Promise<GatewayOrderView | null>;
  /** Must return the persisted resulting state; FILLED/terminal orders are NOT_CANCELABLE. */
  cancelOrder(clientOrderId: string): Promise<LocalPaperCancelResult>;
  getPositions(): Promise<GatewayPositionSnapshot[]>;
  getBalances(): Promise<GatewayBalanceSnapshot[]>;
};

export interface ExecutionGateway {
  readonly id: string;
  readonly mode: ExecutionMode;
  readiness(): ProviderReadiness;
  /** Capability probe — never invents a complete lifecycle when unimplemented. */
  capabilities(): {
    submit: boolean;
    cancel: boolean;
    lookup: boolean;
    positions: boolean;
    balances: boolean;
    protection: boolean;
    reconcile: boolean;
  };
  submitOrder(request: GatewayOrderRequest): Promise<GatewayOrderAck>;
  getOrder(clientOrderId: string): Promise<GatewayOrderAck>;
  cancelOrder(clientOrderId: string): Promise<GatewayOrderAck>;
  getPositions(): Promise<
    { ok: true; positions: GatewayPositionSnapshot[] } | { ok: false; readiness: ProviderReadiness; error: string }
  >;
  getBalances(): Promise<
    { ok: true; balances: GatewayBalanceSnapshot[] } | { ok: false; readiness: ProviderReadiness; error: string }
  >;
}

const BOOK_REQUIRED = "LOCAL_PAPER_BOOK_REQUIRED";

/** Local internal paper engine — the only path that may book PAPER fills. */
export class LocalPaperExecutionGateway implements ExecutionGateway {
  readonly id = "local_paper" as const;
  readonly mode = "PAPER" as const;

  constructor(private readonly book: LocalPaperBook | null = null) {}

  readiness(): ProviderReadiness {
    return "READY";
  }

  capabilities() {
    const hasBook = this.book != null;
    return {
      submit: true,
      cancel: hasBook,
      lookup: hasBook,
      positions: hasBook,
      balances: hasBook,
      protection: false,
      reconcile: false,
    };
  }

  private noBook(op: string) {
    return {
      ok: false as const,
      code: BOOK_REQUIRED,
      error: `${op} requires LocalPaperBook wiring — process memory is not a ledger`,
      readiness: "READY" as const,
    };
  }

  /** Admission only: the worker's durable commit is the booking. Existing book orders are returned as-is. */
  async submitOrder(request: GatewayOrderRequest): Promise<GatewayOrderAck> {
    if (this.book) {
      const existing = await this.book.getOrder(request.clientOrderId);
      if (existing) return { ok: true, ...existing, venue: "PAPER" };
    }
    return { ok: true, brokerOrderId: `paper:${request.clientOrderId}`, status: "ACKED", filledQty: "0", venue: "PAPER" };
  }

  async getOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (!this.book) return this.noBook("getOrder");
    const row = await this.book.getOrder(clientOrderId);
    if (row) return { ok: true, ...row, venue: "PAPER" };
    return {
      ok: false,
      code: "NOT_FOUND",
      error: `No local paper order for clientOrderId=${clientOrderId}`,
      readiness: "READY",
    };
  }

  async cancelOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (!this.book) return this.noBook("cancelOrder");
    const result = await this.book.cancelOrder(clientOrderId);
    if (result.outcome === "NOT_FOUND") {
      return { ok: false, code: "NOT_FOUND", error: `No local paper order for clientOrderId=${clientOrderId}`, readiness: "READY" };
    }
    if (result.outcome === "NOT_CANCELABLE") {
      return {
        ok: false,
        code: "NOT_CANCELABLE",
        error: `order is ${result.order.status}; cancel not applied`,
        readiness: "READY",
        order: result.order,
      };
    }
    return { ok: true, ...result.order, venue: "PAPER" };
  }

  async getPositions() {
    if (!this.book) {
      return { ok: false as const, readiness: "READY" as const, error: `${BOOK_REQUIRED}: positions need the local ledger` };
    }
    return { ok: true as const, positions: await this.book.getPositions() };
  }

  async getBalances() {
    if (!this.book) {
      return { ok: false as const, readiness: "READY" as const, error: `${BOOK_REQUIRED}: balances need the local ledger` };
    }
    return { ok: true as const, balances: await this.book.getBalances() };
  }
}

function viewOf(state: ExternalOrderState): GatewayOrderView & { rawStatus: string } {
  return { brokerOrderId: state.brokerOrderId, status: state.status, filledQty: state.filledQty, rawStatus: state.rawStatus };
}

/**
 * SANDBOX / named demo gateway over an ExternalExecutionVenue.
 * Never books local PAPER fills. LIVE refused at createExecutionGateway.
 */
export class SandboxExecutionGateway implements ExecutionGateway {
  readonly id = "sandbox_demo" as const;
  readonly mode = "SANDBOX" as const;

  constructor(
    private readonly inventory: {
      alpacaKeyPresent: boolean;
      oandaTokenPresent: boolean;
    } = {
      alpacaKeyPresent: false,
      oandaTokenPresent: false,
    },
    private readonly venue: ExternalExecutionVenue | null = null,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SandboxExecutionGateway {
    const alpaca = inventoryAlpacaCredentials(env);
    const oanda = inventoryOandaCredentials(env);
    const external = createExternalVenue(env);
    return new SandboxExecutionGateway(
      {
        alpacaKeyPresent: alpaca.apiKeyPresent && alpaca.apiSecretPresent,
        oandaTokenPresent: oanda.tokenPresent && oanda.accountIdPresent,
      },
      external.ok ? external.venue : null,
    );
  }

  externalVenue(): ExternalExecutionVenue | null {
    return this.venue;
  }

  readiness(): ProviderReadiness {
    if (this.venue) return this.venue.readiness();
    if (!this.inventory.alpacaKeyPresent && !this.inventory.oandaTokenPresent) {
      return "MISSING_CREDENTIALS";
    }
    return "NOT_IMPLEMENTED";
  }

  capabilities() {
    if (this.venue) {
      const caps = this.venue.capabilities();
      return {
        submit: caps.submit,
        cancel: caps.cancel,
        lookup: caps.lookup,
        positions: caps.positions,
        balances: caps.balances,
        protection: caps.nativeProtection,
        reconcile: caps.reconcile,
      };
    }
    return {
      submit: false,
      cancel: false,
      lookup: false,
      positions: false,
      balances: false,
      protection: false,
      reconcile: false,
    };
  }

  private blocked(op: string): GatewayOrderAck {
    const readiness = this.readiness();
    return {
      ok: false,
      code: readiness === "MISSING_CREDENTIALS" ? "BLOCKED_EXTERNAL_TEST" : "NOT_IMPLEMENTED",
      error:
        readiness === "MISSING_CREDENTIALS"
          ? `${op} blocked: missing named demo credentials (verification only)`
          : `${op} not implemented: SANDBOX must not book local PAPER; practice adapter unavailable`,
      readiness,
    };
  }

  private failure(res: { code: string; error: string; retryClass: string }): GatewayOrderAck {
    return { ok: false, code: res.code, error: res.error, retryClass: res.retryClass, readiness: this.readiness() };
  }

  async submitOrder(request: GatewayOrderRequest): Promise<GatewayOrderAck> {
    if (!this.venue) return this.blocked("submitOrder");
    const result = await this.venue.submitOrder({
      clientOrderId: request.clientOrderId,
      instrumentId: request.instrumentId,
      side: request.side,
      qty: request.qty,
      type: request.type ?? "market",
      timeInForce: request.timeInForce ?? "day",
      ...(request.limitPrice !== undefined ? { limitPrice: request.limitPrice } : {}),
      ...(request.bracket ? { bracket: request.bracket } : {}),
    });
    if (!result.ok) return this.failure(result);
    return { ok: true, ...viewOf(result.value), venue: this.venue.venue };
  }

  async getOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (!this.venue) return this.blocked("getOrder");
    const result = await this.venue.getOrderByClientId(clientOrderId);
    if (!result.ok) return this.failure(result);
    return { ok: true, ...viewOf(result.value), venue: this.venue.venue };
  }

  /** Returns CANCEL_REQUESTED on acceptance; the resulting state must be confirmed with getOrder. */
  async cancelOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (!this.venue) return this.blocked("cancelOrder");
    const current = await this.venue.getOrderByClientId(clientOrderId);
    if (!current.ok) return this.failure(current);
    if (TERMINAL_EXTERNAL_STATUSES.has(current.value.status)) {
      return {
        ok: false,
        code: "NOT_CANCELABLE",
        error: `order is ${current.value.status}; cancel not sent`,
        readiness: this.readiness(),
        order: { brokerOrderId: current.value.brokerOrderId, status: current.value.status, filledQty: current.value.filledQty },
      };
    }
    const result = await this.venue.cancelOrder(current.value.brokerOrderId);
    if (!result.ok) return this.failure(result);
    return {
      ok: true,
      brokerOrderId: current.value.brokerOrderId,
      status: "CANCEL_REQUESTED",
      filledQty: current.value.filledQty,
      rawStatus: current.value.rawStatus,
      venue: this.venue.venue,
    };
  }

  async getPositions() {
    if (!this.venue) {
      const readiness = this.readiness();
      return {
        ok: false as const,
        readiness,
        error:
          readiness === "MISSING_CREDENTIALS"
            ? "positions blocked: missing credentials"
            : "positions not implemented on SANDBOX stub",
      };
    }
    const result = await this.venue.getPositions();
    if (!result.ok) {
      return { ok: false as const, readiness: this.readiness(), error: result.error };
    }
    return {
      ok: true as const,
      positions: result.value.map((p) => ({
        instrumentId: p.symbol,
        qty: p.side === "short" && !p.qty.startsWith("-") ? `-${p.qty}` : p.qty,
        avgPrice: p.avgEntryPrice,
      })),
    };
  }

  async getBalances() {
    if (!this.venue) {
      const readiness = this.readiness();
      return {
        ok: false as const,
        readiness,
        error:
          readiness === "MISSING_CREDENTIALS"
            ? "balances blocked: missing credentials"
            : "balances not implemented on SANDBOX stub",
      };
    }
    const result = await this.venue.verifyConnection();
    if (!result.ok) {
      return { ok: false as const, readiness: this.readiness(), error: result.error };
    }
    return {
      ok: true as const,
      balances: [{ cash: result.value.cash, currency: result.value.currency, asOf: new Date().toISOString() }],
    };
  }
}

/** External practice venue from env (Alpaca paper). Never constructs a live-host venue. */
export function createExternalVenue(env: NodeJS.ProcessEnv = process.env): PracticeVenueFromEnvResult {
  return practiceVenueFromEnv(env);
}

export function createExecutionGateway(
  mode: ExecutionMode = resolveExecutionMode(),
  env: NodeJS.ProcessEnv = process.env,
  book: LocalPaperBook | null = null,
): ExecutionGateway {
  if (mode === "SANDBOX") return SandboxExecutionGateway.fromEnv(env);
  if (mode === "LIVE") {
    // Live is refused elsewhere; still expose an honest stub without practice keys.
    return new SandboxExecutionGateway({ alpacaKeyPresent: false, oandaTokenPresent: false }, null);
  }
  return new LocalPaperExecutionGateway(book);
}

/** True when the worker may perform local PAPER commitProposedOrder. */
export function allowsLocalPaperBooking(gateway: ExecutionGateway): boolean {
  return gateway.mode === "PAPER" && gateway.readiness() === "READY";
}
