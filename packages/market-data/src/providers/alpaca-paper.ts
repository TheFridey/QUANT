import {
  SEED_INSTRUMENTS,
  canPaperExecute,
  evaluateSession,
  type Instrument,
  type ProviderReadiness,
} from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "../market-provider.js";
import type { ProviderResult } from "../provider.js";

export type AlpacaPaperCredentials = {
  apiKeyPresent: boolean;
  apiSecretPresent: boolean;
  baseUrl: string;
  dataUrl: string;
};

/**
 * Alpaca Markets Paper Trading adapter (US equities/ETFs).
 * Docs: https://docs.alpaca.markets/docs/trading-api
 * Paper base: https://paper-api.alpaca.markets
 * Requires ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY (paper keys).
 * Never places live-money orders; refuses when credentials missing.
 */
export class AlpacaPaperProvider implements MarketDataProvider {
  readonly id = "alpaca_paper" as const;

  constructor(
    private readonly credentials: AlpacaPaperCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      /** Injected for offline contract tests — sanitised payloads only. */
      quoteFixture?: Record<string, { bid: string; ask: string; mid: string }>;
    } = {},
  ) {}

  readiness(): ProviderReadiness {
    if (!this.credentials.apiKeyPresent || !this.credentials.apiSecretPresent) {
      return "MISSING_CREDENTIALS";
    }
    if (!this.credentials.baseUrl.includes("paper-api") && !this.credentials.baseUrl.includes("localhost")) {
      // Guard: refuse non-paper host unless explicitly local mock.
      return "INVALID_CONFIGURATION";
    }
    return "READY";
  }

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter(
      (item) => item.assetClass === "EQUITY_ETF_PROXY" || item.providerId === "alpaca_paper",
    );
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS") {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error:
          "BLOCKED_EXTERNAL_TEST: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper). See docs/mvp/PROVIDER_CAPABILITIES.md",
      };
    }
    if (ready !== "READY") {
      return { ok: false, code: "UNAVAILABLE", error: `Alpaca paper readiness=${ready}` };
    }

    const now = (this.options.now ?? (() => new Date))();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));

    if (this.options.quoteFixture) {
      return {
        ok: true,
        fetchedAt: now.toISOString(),
        data: instruments.map((instrument) => {
          const fix = this.options.quoteFixture![instrument.symbol] ?? this.options.quoteFixture![instrument.id];
          const session = evaluateSession({ session: instrument.session, now });
          return {
            instrumentId: instrument.id,
            symbol: instrument.symbol,
            level: fix?.mid ?? null,
            currency: "USD",
            dataState: "DEMO" as const,
            provenance: "alpaca_paper:offline_fixture — sanitised contract test; not live",
            session: session.status === "OPEN" ? ("OPEN" as const) : session.status === "CLOSED" ? ("CLOSED" as const) : ("UNKNOWN" as const),
            receivedAt: now.toISOString(),
            providerId: "alpaca_paper" as const,
            bid: fix?.bid ?? null,
            ask: fix?.ask ?? null,
            eventTime: now.toISOString(),
          };
        }),
      };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const quotes: InstrumentQuote[] = [];
    for (const instrument of instruments) {
      const session = evaluateSession({ session: instrument.session, now });
      try {
        const symbol = encodeURIComponent(instrument.providerSymbol || instrument.symbol);
        const url = `${this.credentials.dataUrl}/v2/stocks/${symbol}/quotes/latest`;
        const response = await fetchImpl(url, {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "",
            "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "",
          },
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: Alpaca rejected credentials" };
        }
        if (!response.ok) {
          quotes.push(empty(instrument, now, session.status, `alpaca:http_${response.status}`));
          continue;
        }
        const body = (await response.json()) as {
          quote?: { bp?: number; ap?: number; t?: string };
        };
        const bid = body.quote?.bp;
        const ask = body.quote?.ap;
        if (typeof bid !== "number" || typeof ask !== "number") {
          quotes.push(empty(instrument, now, session.status, "alpaca:missing_quote"));
          continue;
        }
        const mid = (bid + ask) / 2;
        quotes.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: mid.toFixed(8),
          currency: "USD",
          dataState: "DEMO",
          provenance: "alpaca_paper:latest_quote — paper/sandbox market data",
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: now.toISOString(),
          providerId: "alpaca_paper",
          bid: bid.toFixed(8),
          ask: ask.toFixed(8),
          eventTime: body.quote?.t ?? null,
        });
      } catch (error) {
        quotes.push(
          empty(instrument, now, session.status, `alpaca:error:${error instanceof Error ? error.message : "unknown"}`),
        );
      }
    }
    return { ok: true, fetchedAt: now.toISOString(), data: quotes };
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
    if (this.readiness() !== "READY") {
      return {
        instrumentId,
        side,
        allowed: false,
        reasonCodes: ["MISSING_CREDENTIALS", "BLOCKED_EXTERNAL"],
      };
    }
    const instrument = SEED_INSTRUMENTS.find((item) => item.id === instrumentId);
    if (!instrument || !canPaperExecute(instrument)) {
      return { instrumentId, side, allowed: false, reasonCodes: ["NO_EXECUTION"] };
    }
    return { instrumentId, side, allowed: true, reasonCodes: ["EXTERNAL_DEMO"] };
  }

  /** Submit paper order — only when READY. Offline tests should mock fetch. */
  async submitPaperOrder(input: {
    symbol: string;
    side: "buy" | "sell";
    qty: string;
    type?: "market" | "limit";
    clientOrderId: string;
  }): Promise<{ ok: true; brokerOrderId: string; status: string } | { ok: false; error: string; readiness: ProviderReadiness }> {
    const ready = this.readiness();
    if (ready !== "READY") return { ok: false, error: `Cannot submit: readiness=${ready}`, readiness: ready };
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.credentials.baseUrl}/v2/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "",
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "",
      },
      body: JSON.stringify({
        symbol: input.symbol,
        qty: input.qty,
        side: input.side,
        type: input.type ?? "market",
        time_in_force: "day",
        client_order_id: input.clientOrderId,
      }),
    });
    if (!response.ok) {
      return { ok: false, error: `alpaca_submit:http_${response.status}`, readiness: ready };
    }
    const body = (await response.json()) as { id?: string; status?: string };
    if (!body.id) return { ok: false, error: "alpaca_submit:missing_id", readiness: ready };
    return { ok: true, brokerOrderId: body.id, status: body.status ?? "accepted" };
  }
}

export function inventoryAlpacaCredentials(env: NodeJS.ProcessEnv = process.env): AlpacaPaperCredentials {
  return {
    apiKeyPresent: Boolean(env.ALPACA_API_KEY_ID?.trim()),
    apiSecretPresent: Boolean(env.ALPACA_API_SECRET_KEY?.trim()),
    baseUrl: env.ALPACA_PAPER_BASE_URL?.trim() || "https://paper-api.alpaca.markets",
    dataUrl: env.ALPACA_DATA_BASE_URL?.trim() || "https://data.alpaca.markets",
  };
}

function empty(
  instrument: Instrument,
  now: Date,
  sessionStatus: string,
  provenance: string,
): InstrumentQuote {
  return {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    level: null,
    currency: "USD",
    dataState: "DEMO",
    provenance: `${provenance} — null; never invent`,
    session: sessionStatus === "OPEN" ? "OPEN" : sessionStatus === "CLOSED" ? "CLOSED" : "UNKNOWN",
    receivedAt: now.toISOString(),
    providerId: "alpaca_paper",
    bid: null,
    ask: null,
    eventTime: null,
  };
}
