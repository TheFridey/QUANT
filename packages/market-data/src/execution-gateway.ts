import type { ProviderReadiness } from "@odin/shared";
import { resolveExecutionMode, type ExecutionMode } from "@odin/shared";
import { AlpacaPracticeBroker, type PracticeBrokerAdapter } from "./practice-broker.js";
import { inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";
import { inventoryOandaCredentials } from "./providers/oanda-practice.js";

/**
 * Execution gateway (D09/§22–§23): separates local PAPER booking from external SANDBOX/demo.
 * SANDBOX must never silently stamp local PAPER fills. Practice adapter is wired when
 * Alpaca paper credentials + host are valid; otherwise MISSING_CREDENTIALS / NOT_IMPLEMENTED.
 */

export type GatewayOrderRequest = {
  clientOrderId: string;
  instrumentId: string;
  side: "BUY" | "SELL";
  qty: string;
  intent?: string;
};

export type GatewayOrderAck =
  | {
      ok: true;
      brokerOrderId: string;
      status: "ACKED" | "FILLED" | "REJECTED" | "PENDING" | "UNKNOWN";
      venue: string;
      filledQty: string;
    }
  | {
      ok: false;
      code: string;
      error: string;
      readiness: ProviderReadiness;
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

export type LocalPaperBook = {
  getOrder(
    clientOrderId: string,
  ): Promise<{ brokerOrderId: string; status: GatewayOrderAck extends { ok: true } ? GatewayOrderAck["status"] : never; filledQty: string } | null>;
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

/** Local internal paper engine — the only path that may book PAPER fills. */
export class LocalPaperExecutionGateway implements ExecutionGateway {
  readonly id = "local_paper" as const;
  readonly mode = "PAPER" as const;
  private readonly submitted = new Map<
    string,
    { brokerOrderId: string; status: "ACKED" | "FILLED" | "REJECTED" | "PENDING" | "UNKNOWN"; filledQty: string }
  >();

  constructor(private readonly book: LocalPaperBook | null = null) {}

  readiness(): ProviderReadiness {
    return "READY";
  }

  capabilities() {
    const hasBook = this.book != null;
    return {
      submit: true,
      cancel: true,
      lookup: true,
      positions: hasBook,
      balances: hasBook,
      protection: true,
      reconcile: hasBook,
    };
  }

  async submitOrder(request: GatewayOrderRequest): Promise<GatewayOrderAck> {
    const existing = this.submitted.get(request.clientOrderId);
    if (existing) {
      return { ok: true, ...existing, venue: "PAPER" };
    }
    // Caller (worker) performs durable local commitProposedOrder — gateway admits + tracks id.
    const row = {
      brokerOrderId: `paper:${request.clientOrderId}`,
      status: "ACKED" as const,
      filledQty: "0",
    };
    this.submitted.set(request.clientOrderId, row);
    return { ok: true, ...row, venue: "PAPER" };
  }

  async getOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (this.book) {
      const row = await this.book.getOrder(clientOrderId);
      if (row) return { ok: true, ...row, venue: "PAPER" };
    }
    const mem = this.submitted.get(clientOrderId);
    if (mem) return { ok: true, ...mem, venue: "PAPER" };
    return {
      ok: false,
      code: "NOT_FOUND",
      error: `No local paper order for clientOrderId=${clientOrderId}`,
      readiness: "READY",
    };
  }

  async cancelOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    const current = await this.getOrder(clientOrderId);
    if (!current.ok) return current;
    const row = {
      brokerOrderId: current.brokerOrderId,
      status: "ACKED" as const,
      filledQty: current.filledQty,
    };
    this.submitted.set(clientOrderId, row);
    return { ok: true, ...row, venue: "PAPER" };
  }

  async getPositions() {
    if (!this.book) {
      return {
        ok: false as const,
        readiness: "READY" as const,
        error: "positions require LocalPaperBook wiring — empty in-memory stub is not a ledger",
      };
    }
    return { ok: true as const, positions: await this.book.getPositions() };
  }

  async getBalances() {
    if (!this.book) {
      return {
        ok: false as const,
        readiness: "READY" as const,
        error: "balances require LocalPaperBook wiring — empty in-memory stub is not a ledger",
      };
    }
    return { ok: true as const, balances: await this.book.getBalances() };
  }
}

/**
 * SANDBOX / named demo gateway.
 * Wires AlpacaPracticeBroker HTTP transport when credentials exist.
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
    private readonly practice: PracticeBrokerAdapter | null = null,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SandboxExecutionGateway {
    const alpaca = inventoryAlpacaCredentials(env);
    const oanda = inventoryOandaCredentials(env);
    const alpacaKeyPresent = alpaca.apiKeyPresent && alpaca.apiSecretPresent;
    const practice = alpacaKeyPresent ? AlpacaPracticeBroker.fromEnv(env) : null;
    return new SandboxExecutionGateway(
      {
        alpacaKeyPresent,
        oandaTokenPresent: oanda.tokenPresent && oanda.accountIdPresent,
      },
      practice,
    );
  }

  readiness(): ProviderReadiness {
    if (this.practice) return this.practice.readiness();
    if (!this.inventory.alpacaKeyPresent && !this.inventory.oandaTokenPresent) {
      return "MISSING_CREDENTIALS";
    }
    return "NOT_IMPLEMENTED";
  }

  capabilities() {
    if (this.practice) {
      const caps = this.practice.capabilities();
      return {
        submit: caps.orders,
        cancel: caps.cancel,
        lookup: caps.lookup,
        positions: caps.positions,
        balances: caps.balances,
        protection: false, // synthetic disclosed — native protection not claimed
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

  async submitOrder(request: GatewayOrderRequest): Promise<GatewayOrderAck> {
    if (!this.practice) return this.blocked("submitOrder");
    const result = await this.practice.submitOrder({
      clientOrderId: request.clientOrderId,
      symbol: request.instrumentId.replace(/^etf:/, "").replace(/^fx:/, ""),
      side: request.side === "BUY" ? "buy" : "sell",
      qty: request.qty,
      type: "market",
      timeInForce: "day",
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: result.error,
        readiness: this.readiness(),
      };
    }
    return {
      ok: true,
      brokerOrderId: result.value.brokerOrderId,
      status:
        result.value.status === "filled"
          ? "FILLED"
          : result.value.status === "rejected"
            ? "REJECTED"
            : result.value.status === "unknown"
              ? "UNKNOWN"
              : "PENDING",
      venue: this.practice.venue,
      filledQty: "0",
    };
  }

  async getOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (!this.practice) return this.blocked("getOrder");
    const result = await this.practice.lookupOrder(clientOrderId);
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.error, readiness: this.readiness() };
    }
    return {
      ok: true,
      brokerOrderId: result.value.brokerOrderId,
      status:
        result.value.status === "filled"
          ? "FILLED"
          : result.value.status === "rejected" || result.value.status === "canceled"
            ? "REJECTED"
            : result.value.status === "unknown"
              ? "UNKNOWN"
              : "PENDING",
      venue: this.practice.venue,
      filledQty: result.value.filledQty,
    };
  }

  async cancelOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    if (!this.practice) return this.blocked("cancelOrder");
    const result = await this.practice.cancelOrder(clientOrderId);
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.error, readiness: this.readiness() };
    }
    return {
      ok: true,
      brokerOrderId: `cancel:${clientOrderId}`,
      status: "ACKED",
      venue: this.practice.venue,
      filledQty: "0",
    };
  }

  async getPositions() {
    if (!this.practice) {
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
    const result = await this.practice.getPositions();
    if (!result.ok) {
      return { ok: false as const, readiness: this.readiness(), error: result.error };
    }
    return {
      ok: true as const,
      positions: result.value.map((p) => ({
        instrumentId: p.symbol,
        qty: p.qty,
        avgPrice: p.avgEntry,
      })),
    };
  }

  async getBalances() {
    if (!this.practice) {
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
    const result = await this.practice.getBalances();
    if (!result.ok) {
      return { ok: false as const, readiness: this.readiness(), error: result.error };
    }
    return {
      ok: true as const,
      balances: result.value.map((b) => ({
        cash: b.cash,
        currency: b.currency,
        asOf: new Date().toISOString(),
      })),
    };
  }
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
