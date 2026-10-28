import type { Instrument, ProviderReadiness } from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "./market-provider.js";
import type { ProviderResult } from "./provider.js";
import { AlpacaPaperProvider, inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";
import { OandaPracticeProvider, inventoryOandaCredentials } from "./providers/oanda-practice.js";

export type ExternalDemoCredentials = {
  /** @deprecated Prefer named provider credentials (Alpaca / OANDA). */
  apiKeyPresent: boolean;
  baseUrl?: string;
  alpacaReady: boolean;
  oandaReady: boolean;
};

export type NamedExternalProviderId = "alpaca_paper" | "oanda_practice";

/**
 * External demo/sandbox facade over named providers (Alpaca paper + OANDA practice).
 * EXTERNAL_DEMO_API_KEY alone does not unlock anything — named credentials required.
 * Only external *verification* may be BLOCKED_EXTERNAL_TEST when credentials absent.
 */
export class ExternalDemoAdapter implements MarketDataProvider {
  readonly id = "external_demo" as const;
  private readonly alpaca: AlpacaPaperProvider;
  private readonly oanda: OandaPracticeProvider;

  constructor(
    private readonly credentials: ExternalDemoCredentials = {
      apiKeyPresent: false,
      alpacaReady: false,
      oandaReady: false,
    },
    options: {
      alpaca?: AlpacaPaperProvider;
      oanda?: OandaPracticeProvider;
    } = {},
  ) {
    this.alpaca =
      options.alpaca ??
      new AlpacaPaperProvider(inventoryAlpacaCredentials());
    this.oanda =
      options.oanda ??
      new OandaPracticeProvider(inventoryOandaCredentials());
  }

  readiness(): ProviderReadiness {
    const a = this.alpaca.readiness();
    const o = this.oanda.readiness();
    if (a === "READY" || o === "READY") return "READY";
    if (a === "AUTH_FAILED" || o === "AUTH_FAILED") return "AUTH_FAILED";
    if (a === "INVALID_CONFIGURATION" || o === "INVALID_CONFIGURATION") return "INVALID_CONFIGURATION";
    if (a === "MISSING_CREDENTIALS" && o === "MISSING_CREDENTIALS") return "MISSING_CREDENTIALS";
    return "CONNECTING";
  }

  /** True when no named provider is READY. */
  get blocked(): boolean {
    return this.readiness() !== "READY";
  }

  get blockReason(): string {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS") {
      return "BLOCKED_EXTERNAL_TEST: configure ALPACA_API_KEY_ID+ALPACA_API_SECRET_KEY and/or OANDA_API_TOKEN+OANDA_ACCOUNT_ID (practice). EXTERNAL_DEMO_API_KEY alone is not sufficient. See docs/mvp/PROVIDER_CAPABILITIES.md";
    }
    return `BLOCKED_EXTERNAL_TEST: external demo readiness=${ready}`;
  }

  providerStatuses(): Record<NamedExternalProviderId, ProviderReadiness> {
    return {
      alpaca_paper: this.alpaca.readiness(),
      oanda_practice: this.oanda.readiness(),
    };
  }

  async listInstruments(): Promise<Instrument[]> {
    const [eq, fx] = await Promise.all([this.alpaca.listInstruments(), this.oanda.listInstruments()]);
    return [...eq, ...fx];
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    if (this.blocked) {
      return { ok: false, code: "UNAVAILABLE", error: this.blockReason };
    }
    const fxIds = instrumentIds.filter((id) => id.startsWith("fx:"));
    const eqIds = instrumentIds.filter((id) => id.startsWith("etf:") || id.startsWith("equity:"));
    const other = instrumentIds.filter((id) => !fxIds.includes(id) && !eqIds.includes(id));

    const parts: InstrumentQuote[] = [];
    if (fxIds.length && this.oanda.readiness() === "READY") {
      const result = await this.oanda.getQuotes(fxIds);
      if (!result.ok) return result;
      parts.push(...result.data);
    } else if (fxIds.length) {
      return { ok: false, code: "UNAVAILABLE", error: this.blockReason };
    }
    if (eqIds.length && this.alpaca.readiness() === "READY") {
      const result = await this.alpaca.getQuotes(eqIds);
      if (!result.ok) return result;
      parts.push(...result.data);
    } else if (eqIds.length) {
      return { ok: false, code: "UNAVAILABLE", error: this.blockReason };
    }
    if (other.length) {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error: `No named external provider mapped for: ${other.join(",")}`,
      };
    }
    return { ok: true, fetchedAt: new Date().toISOString(), data: parts };
  }

  async getSession(instrumentId: string): Promise<MarketSessionStatus> {
    if (instrumentId.startsWith("fx:")) return this.oanda.getSession(instrumentId);
    return this.alpaca.getSession(instrumentId);
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    if (this.blocked) {
      return {
        instrumentId,
        side,
        allowed: false,
        reasonCodes: ["BLOCKED_EXTERNAL", "MISSING_CREDENTIALS"],
      };
    }
    if (instrumentId.startsWith("fx:")) return this.oanda.buildOrderSpec(instrumentId, side);
    return this.alpaca.buildOrderSpec(instrumentId, side);
  }
}

export function inventoryExternalDemoCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ExternalDemoCredentials {
  const alpaca = inventoryAlpacaCredentials(env);
  const oanda = inventoryOandaCredentials(env);
  return {
    apiKeyPresent: Boolean(env.EXTERNAL_DEMO_API_KEY && env.EXTERNAL_DEMO_API_KEY.trim().length > 0),
    baseUrl: env.EXTERNAL_DEMO_BASE_URL?.trim() || undefined,
    alpacaReady: alpaca.apiKeyPresent && alpaca.apiSecretPresent,
    oandaReady: oanda.tokenPresent && oanda.accountIdPresent,
  };
}

export { inventoryAlpacaCredentials, inventoryOandaCredentials };
