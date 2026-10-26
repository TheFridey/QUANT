import type { Instrument } from "@odin/shared";
import { SEED_INSTRUMENTS } from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "./market-provider.js";
import type { ProviderResult } from "./provider.js";

/**
 * Equity index feed.
 * Prefer a free delayed API when configured; otherwise return DEMO / provenance-labelled
 * stubs with null levels — never invent index levels for LIVE paper fills.
 */
export class IndexMarketProvider implements MarketDataProvider {
  readonly id;

  constructor(
    private readonly options: {
      /** When set, attempt Yahoo-style chart endpoint (delayed). Failures → DEMO null. */
      useDelayedApi?: boolean;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    } = {},
  ) {
    this.id = options.useDelayedApi ? ("index_yahoo_delayed" as const) : ("index_stub" as const);
  }

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter((item) => item.assetClass === "EQUITY_INDEX");
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const now = (this.options.now ?? (() => new Date))().toISOString();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));
    const quotes: InstrumentQuote[] = [];

    for (const instrument of instruments) {
      if (this.options.useDelayedApi) {
        const delayed = await this.fetchDelayed(instrument, now);
        quotes.push(delayed);
        continue;
      }
      quotes.push({
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        level: null,
        currency: instrument.quote,
        dataState: "DEMO",
        provenance: "index_stub:no_live_level — DEMO; not eligible for paper fills",
        session: sessionGuess(now),
        receivedAt: now,
        providerId: "index_stub",
      });
    }

    return { ok: true, fetchedAt: now, data: quotes };
  }

  async getSession(_instrumentId: string): Promise<MarketSessionStatus> {
    return sessionGuess((this.options.now ?? (() => new Date))().toISOString());
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    return {
      instrumentId,
      side,
      allowed: false,
      reasonCodes: ["INDEX_NO_EXECUTION", "RESEARCH_ONLY"],
    };
  }

  private async fetchDelayed(instrument: Instrument, now: string): Promise<InstrumentQuote> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const symbol = encodeURIComponent(instrument.providerSymbol);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
      const response = await fetchImpl(url, {
        headers: { "user-agent": "odin-quant-research/0.1" },
      });
      if (!response.ok) {
        return demoNull(instrument, now, `index_yahoo_delayed:http_${response.status}`);
      }
      const body = (await response.json()) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> };
      };
      const price = body.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price !== "number" || !Number.isFinite(price)) {
        return demoNull(instrument, now, "index_yahoo_delayed:missing_price");
      }
      return {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        level: String(price),
        currency: instrument.quote,
        dataState: "DELAYED",
        provenance: "index_yahoo_delayed:free_chart_meta — DELAYED; not LIVE paper",
        session: sessionGuess(now),
        receivedAt: now,
        providerId: "index_yahoo_delayed",
      };
    } catch (error) {
      return demoNull(
        instrument,
        now,
        `index_yahoo_delayed:error:${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
}

function demoNull(instrument: Instrument, now: string, provenance: string): InstrumentQuote {
  return {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    level: null,
    currency: instrument.quote,
    dataState: "DEMO",
    provenance: `${provenance} — null level; never invent`,
    session: sessionGuess(now),
    receivedAt: now,
    providerId: "index_stub",
  };
}

function sessionGuess(iso: string): MarketSessionStatus {
  const date = new Date(iso);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return "CLOSED";
  return "UNKNOWN";
}
