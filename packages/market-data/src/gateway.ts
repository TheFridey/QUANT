import type { Instrument } from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "./market-provider.js";
import type { ProviderResult } from "./provider.js";
import { AlpacaPaperProvider, inventoryAlpacaCredentials } from "./providers/alpaca-paper.js";
import { FrankfurterFxProvider } from "./providers/frankfurter-fx.js";
import { OandaPracticeProvider, inventoryOandaCredentials } from "./providers/oanda-practice.js";
import type { ProviderReadiness } from "@odin/shared";

/**
 * Market-data gateway: routes instrument quotes to named providers.
 * Never invents levels; readiness stays honest when credentials missing.
 */
export class MarketDataGateway {
  readonly id = "market_data_gateway" as const;

  constructor(
    private readonly providers: {
      frankfurter?: FrankfurterFxProvider;
      alpaca?: AlpacaPaperProvider;
      oanda?: OandaPracticeProvider;
    } = {},
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): MarketDataGateway {
    return new MarketDataGateway({
      frankfurter: new FrankfurterFxProvider({ now }),
      alpaca: new AlpacaPaperProvider(inventoryAlpacaCredentials(env), { now }),
      oanda: new OandaPracticeProvider(inventoryOandaCredentials(env), { now }),
    });
  }

  readiness(): Record<string, ProviderReadiness> {
    return {
      frankfurter_fx: "READY",
      alpaca_paper: this.providers.alpaca?.readiness() ?? "MISSING_CREDENTIALS",
      oanda_practice: this.providers.oanda?.readiness() ?? "MISSING_CREDENTIALS",
    };
  }

  providerFor(instrumentId: string): MarketDataProvider | null {
    if (instrumentId.startsWith("fx:")) {
      const oandaState = this.providers.oanda?.readiness();
      // READY or CONNECTING (keys present, auth not yet proven) may attempt quotes.
      if (oandaState === "READY" || oandaState === "CONNECTING") {
        return this.providers.oanda ?? null;
      }
      return this.providers.frankfurter ?? null;
    }
    if (instrumentId.startsWith("etf:") || instrumentId.startsWith("equity:")) {
      return this.providers.alpaca ?? null;
    }
    if (instrumentId.startsWith("commodity:") || instrumentId.startsWith("index:")) {
      // No dedicated live provider in this gateway yet — caller treats as missing.
      return null;
    }
    return null;
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const byProvider = new Map<MarketDataProvider, string[]>();
    const skipped: string[] = [];
    for (const id of instrumentIds) {
      const provider = this.providerFor(id);
      if (!provider) {
        skipped.push(id);
        continue;
      }
      const list = byProvider.get(provider) ?? [];
      list.push(id);
      byProvider.set(provider, list);
    }
    const quotes: InstrumentQuote[] = [];
    const fetchedAt = new Date().toISOString();
    for (const [provider, ids] of byProvider) {
      const result = await provider.getQuotes(ids);
      if (!result.ok) {
        // Soft-fail per provider — keep other providers' quotes; never invent.
        continue;
      }
      quotes.push(...result.data);
    }
    if (quotes.length === 0 && instrumentIds.length > 0) {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error:
          skipped.length === instrumentIds.length
            ? "No named provider for requested instruments"
            : "All routed providers returned no quotes (check readiness / credentials)",
      };
    }
    return { ok: true, fetchedAt, data: quotes };
  }

  async listInstruments(): Promise<Instrument[]> {
    const out: Instrument[] = [];
    for (const provider of [this.providers.frankfurter, this.providers.alpaca, this.providers.oanda]) {
      if (!provider) continue;
      out.push(...(await provider.listInstruments()));
    }
    return out;
  }

  async getSession(instrumentId: string): Promise<MarketSessionStatus> {
    const provider = this.providerFor(instrumentId);
    if (!provider) return "UNKNOWN";
    return provider.getSession(instrumentId);
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    const provider = this.providerFor(instrumentId);
    if (!provider) {
      return { instrumentId, side, allowed: false, reasonCodes: ["NO_EXECUTION", "PROVIDER_NOT_READY"] };
    }
    return provider.buildOrderSpec(instrumentId, side);
  }
}
