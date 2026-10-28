import type { Instrument } from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "./market-provider.js";
import type { ProviderResult } from "./provider.js";

export type ExternalDemoCredentials = {
  /** Presence only — values must never be logged. */
  apiKeyPresent: boolean;
  baseUrl?: string;
};

/**
 * External demo/sandbox adapter boundary.
 * Without credentials this stays BLOCKED_EXTERNAL and never reports fake fills or live acks.
 */
export class ExternalDemoAdapter implements MarketDataProvider {
  readonly id = "external_demo" as const;

  constructor(private readonly credentials: ExternalDemoCredentials = { apiKeyPresent: false }) {}

  get blocked(): boolean {
    return !this.credentials.apiKeyPresent;
  }

  get blockReason(): string {
    return "BLOCKED_EXTERNAL: set EXTERNAL_DEMO_API_KEY (and optional EXTERNAL_DEMO_BASE_URL) to enable the sandbox adapter. Do not place real-money trades.";
  }

  async listInstruments(): Promise<Instrument[]> {
    return [];
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    if (this.blocked) {
      return { ok: false, code: "UNAVAILABLE", error: this.blockReason };
    }
    // Credential path is intentionally unimplemented until a real sandbox is configured.
    void instrumentIds;
    return {
      ok: false,
      code: "UNAVAILABLE",
      error: "External demo adapter credentials present but venue integration not configured — refusing fake LIVE quotes",
    };
  }

  async getSession(_instrumentId: string): Promise<MarketSessionStatus> {
    return "UNKNOWN";
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    return {
      instrumentId,
      side,
      allowed: false,
      reasonCodes: this.blocked
        ? ["BLOCKED_EXTERNAL", "NO_EXECUTION"]
        : ["NO_EXECUTION", "EXTERNAL_DEMO_NOT_CONFIGURED"],
    };
  }
}

export function inventoryExternalDemoCredentials(env: NodeJS.ProcessEnv = process.env): ExternalDemoCredentials {
  return {
    apiKeyPresent: Boolean(env.EXTERNAL_DEMO_API_KEY && env.EXTERNAL_DEMO_API_KEY.trim().length > 0),
    baseUrl: env.EXTERNAL_DEMO_BASE_URL?.trim() || undefined,
  };
}
