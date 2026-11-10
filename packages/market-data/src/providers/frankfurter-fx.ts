import { SEED_INSTRUMENTS, canPaperExecute, describeQuoteQuality, evaluateSession, type Instrument, type ProviderReadiness } from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "../market-provider.js";
import type { ProviderResult } from "../provider.js";

/**
 * Frankfurter (ECB reference rates) — free, no API key.
 * A once-daily reference rate (about 16:00 CET on TARGET business days), never a live quote: it has no
 * bid/ask and its quality descriptor says REFERENCE_RATE. dataState stays DELAYED as before.
 * Suitable for MARKET_DATA_PAPER FX marks (DELAYED). Not a broker; no execution.
 * Docs: https://www.frankfurter.app/docs/
 */
export class FrankfurterFxProvider implements MarketDataProvider {
  readonly id = "frankfurter_fx" as const;

  constructor(
    private readonly options: {
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    } = {},
  ) {}

  readiness(): ProviderReadiness {
    return "READY";
  }

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter((item) => item.assetClass === "FX_SPOT");
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const now = this.options.now ?? (() => new Date());
    const at = now();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const baseUrl = this.options.baseUrl ?? "https://api.frankfurter.app";

    // Group by quote currency (Frankfurter latest?from=BASE&to=QUOTE)
    const quotes: InstrumentQuote[] = [];
    for (const instrument of instruments) {
      const session = evaluateSession({ session: instrument.session, now: at });
      try {
        const url = `${baseUrl}/latest?from=${encodeURIComponent(instrument.base)}&to=${encodeURIComponent(instrument.quote)}`;
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
        if (!response.ok) {
          quotes.push(nullQuote(instrument, at, session.status, `frankfurter:http_${response.status}`));
          continue;
        }
        const body = (await response.json()) as { rates?: Record<string, number>; date?: string };
        const rate = body.rates?.[instrument.quote];
        if (typeof rate !== "number" || !Number.isFinite(rate)) {
          quotes.push(nullQuote(instrument, at, session.status, "frankfurter:missing_rate"));
          continue;
        }
        quotes.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: rate.toFixed(8),
          currency: instrument.quote,
          dataState: "DELAYED",
          provenance: `frankfurter_fx:ecb_reference date=${body.date ?? "unknown"} — DELAYED; not a live FX venue`,
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: at.toISOString(),
          providerId: "frankfurter_fx",
          bid: null,
          ask: null,
          eventTime: body.date ? `${body.date}T16:00:00.000Z` : null,
          // Descriptive only: a once-daily ECB reference rate, never a live quote. dataState is unchanged.
          quality: describeQuoteQuality({
            source: "frankfurter_fx",
            feed: "ECB_REFERENCE",
            now: at,
            eventTime: body.date ? `${body.date}T16:00:00.000Z` : null,
            notes: [`reference date ${body.date ?? "unknown"}; no bid/ask`],
          }),
        });
      } catch (error) {
        quotes.push(
          nullQuote(
            instrument,
            at,
            session.status,
            `frankfurter:error:${error instanceof Error ? error.message : "unknown"}`,
          ),
        );
      }
    }
    return { ok: true, fetchedAt: at.toISOString(), data: quotes };
  }

  async getSession(instrumentId: string): Promise<MarketSessionStatus> {
    const instrument = (await this.listInstruments()).find((item) => item.id === instrumentId);
    if (!instrument) return "UNKNOWN";
    const status = evaluateSession({
      session: instrument.session,
      now: (this.options.now ?? (() => new Date))(),
    }).status;
    return status === "OPEN" ? "OPEN" : status === "CLOSED" ? "CLOSED" : "UNKNOWN";
  }

  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec {
    const instrument = SEED_INSTRUMENTS.find((item) => item.id === instrumentId);
    if (!instrument || !canPaperExecute(instrument)) {
      return { instrumentId, side, allowed: false, reasonCodes: ["NO_EXECUTION"] };
    }
    // Frankfurter is market-data only — paper execution stays on internal engine.
    return { instrumentId, side, allowed: true, reasonCodes: ["PAPER_FX"] };
  }
}

function nullQuote(
  instrument: Instrument,
  at: Date,
  sessionStatus: string,
  provenance: string,
): InstrumentQuote {
  return {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    level: null,
    currency: instrument.quote,
    dataState: "DEMO",
    provenance: `${provenance} — null level; never invent`,
    session: sessionStatus === "OPEN" ? "OPEN" : sessionStatus === "CLOSED" ? "CLOSED" : "UNKNOWN",
    receivedAt: at.toISOString(),
    providerId: "frankfurter_fx",
    bid: null,
    ask: null,
    eventTime: null,
  };
}
