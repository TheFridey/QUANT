import { SEED_INSTRUMENTS, canPaperExecute, evaluateSession, type Instrument } from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "./market-provider.js";
import type { ProviderResult } from "./provider.js";

/**
 * FX stub / paper feed.
 * Without an external FX sandbox credential this returns DEMO/FIXTURE-labelled levels
 * for internal paper only. Never claims LIVE broker acknowledgements.
 */
export class FxMarketProvider implements MarketDataProvider {
  readonly id = "fx_stub" as const;

  constructor(
    private readonly options: {
      /** Optional fixture levels keyed by instrument id. Absent → null DEMO level. */
      fixtureLevels?: Record<string, string>;
      now?: () => Date;
    } = {},
  ) {}

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter((item) => item.assetClass === "FX_SPOT");
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const now = this.options.now ?? (() => new Date());
    const at = now();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));
    const quotes: InstrumentQuote[] = instruments.map((instrument) => {
      const session = evaluateSession({ session: instrument.session, now: at });
      const fixture = this.options.fixtureLevels?.[instrument.id] ?? null;
      return {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        level: fixture,
        currency: instrument.quote,
        dataState: fixture ? "DEMO" : "DEMO",
        provenance: fixture
          ? "fx_stub:fixture — DEMO/paper only; not a live FX venue"
          : "fx_stub:no_level — DEMO; set fixture or external sandbox credentials",
        session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
        receivedAt: at.toISOString(),
        providerId: "fx_stub",
      };
    });
    return { ok: true, fetchedAt: at.toISOString(), data: quotes };
  }

  async getSession(instrumentId: string): Promise<MarketSessionStatus> {
    const instrument = (await this.listInstruments()).find((item) => item.id === instrumentId);
    if (!instrument) return "UNKNOWN";
    const status = evaluateSession({ session: instrument.session, now: (this.options.now ?? (() => new Date))() }).status;
    return status === "OPEN" ? "OPEN" : status === "CLOSED" ? "CLOSED" : "UNKNOWN";
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    const instrument = SEED_INSTRUMENTS.find((item) => item.id === instrumentId);
    if (!instrument || !canPaperExecute(instrument)) {
      return { instrumentId, side, allowed: false, reasonCodes: ["NO_EXECUTION"] };
    }
    return { instrumentId, side, allowed: true, reasonCodes: ["PAPER_FX"] };
  }
}
