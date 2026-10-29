import type { ProviderReadiness } from "@odin/shared";
import { resolveExecutionMode, type ExecutionMode } from "@odin/shared";
import { inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";
import { inventoryOandaCredentials } from "./providers/oanda-practice.js";

/**
 * Execution gateway (D09): separates local PAPER booking from external SANDBOX/demo.
 * SANDBOX must never silently stamp local PAPER fills. Prefer NOT_IMPLEMENTED /
 * MISSING_CREDENTIALS over a fake READY. This slice does not place real/demo broker orders.
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
      status: "ACKED" | "FILLED" | "REJECTED" | "PENDING";
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

  readiness(): ProviderReadiness {
    return "READY";
  }

  capabilities() {
    return {
      submit: true,
      cancel: true,
      lookup: true,
      positions: true,
      balances: true,
      protection: true,
      reconcile: true,
    };
  }

  async submitOrder(request: GatewayOrderRequest): Promise<GatewayOrderAck> {
    // Caller (worker) performs durable local commitProposedOrder — gateway only admits.
    return {
      ok: true,
      brokerOrderId: `paper:${request.clientOrderId}`,
      status: "ACKED",
      venue: "PAPER",
      filledQty: "0",
    };
  }

  async getOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    return {
      ok: true,
      brokerOrderId: `paper:${clientOrderId}`,
      status: "ACKED",
      venue: "PAPER",
      filledQty: "0",
    };
  }

  async cancelOrder(clientOrderId: string): Promise<GatewayOrderAck> {
    return {
      ok: true,
      brokerOrderId: `paper:${clientOrderId}`,
      status: "ACKED",
      venue: "PAPER",
      filledQty: "0",
    };
  }

  async getPositions() {
    return { ok: true as const, positions: [] as GatewayPositionSnapshot[] };
  }

  async getBalances() {
    return {
      ok: true as const,
      balances: [] as GatewayBalanceSnapshot[],
    };
  }
}

/**
 * SANDBOX / named demo gateway stub.
 * - Missing credentials → MISSING_CREDENTIALS (blocks credentialed verification only).
 * - Credentials present but lifecycle not wired → NOT_IMPLEMENTED (never fake READY).
 * - Never books local PAPER fills and never places broker orders from this stub.
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
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SandboxExecutionGateway {
    const alpaca = inventoryAlpacaCredentials(env);
    const oanda = inventoryOandaCredentials(env);
    return new SandboxExecutionGateway({
      alpacaKeyPresent: alpaca.apiKeyPresent && alpaca.apiSecretPresent,
      oandaTokenPresent: oanda.tokenPresent && oanda.accountIdPresent,
    });
  }

  readiness(): ProviderReadiness {
    if (!this.inventory.alpacaKeyPresent && !this.inventory.oandaTokenPresent) {
      return "MISSING_CREDENTIALS";
    }
    // Keys may exist for quote verification, but the full submit/protect/reconcile
    // lifecycle is not yet an integrated gateway — do not claim READY.
    return "NOT_IMPLEMENTED";
  }

  capabilities() {
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
          : `${op} not implemented: SANDBOX must not book local PAPER; full demo lifecycle pending`,
      readiness,
    };
  }

  async submitOrder(_request: GatewayOrderRequest): Promise<GatewayOrderAck> {
    return this.blocked("submitOrder");
  }

  async getOrder(_clientOrderId: string): Promise<GatewayOrderAck> {
    return this.blocked("getOrder");
  }

  async cancelOrder(_clientOrderId: string): Promise<GatewayOrderAck> {
    return this.blocked("cancelOrder");
  }

  async getPositions() {
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

  async getBalances() {
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
}

export function createExecutionGateway(
  mode: ExecutionMode = resolveExecutionMode(),
  env: NodeJS.ProcessEnv = process.env,
): ExecutionGateway {
  if (mode === "SANDBOX") return SandboxExecutionGateway.fromEnv(env);
  if (mode === "LIVE") {
    // Live is refused elsewhere; still expose an honest stub.
    return new SandboxExecutionGateway({ alpacaKeyPresent: false, oandaTokenPresent: false });
  }
  return new LocalPaperExecutionGateway();
}

/** True when the worker may perform local PAPER commitProposedOrder. */
export function allowsLocalPaperBooking(gateway: ExecutionGateway): boolean {
  return gateway.mode === "PAPER" && gateway.readiness() === "READY";
}
