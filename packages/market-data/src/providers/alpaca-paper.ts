import {
  SEED_INSTRUMENTS,
  canPaperExecute,
  evaluateSession,
  type Instrument,
  type ProviderReadiness,
} from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "../market-provider.js";
import type { ProviderResult } from "../provider.js";
import {
  ALPACA_DATA_HOSTS_STRICT,
  ALPACA_PAPER_TRADE_HOSTS_STRICT,
  assertAllowlistedHttpsUrl,
  assertCompleteQuote,
} from "../practice-url.js";

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
  private authFailed = false;
  private authenticatedOk = false;

  constructor(
    private readonly credentials: AlpacaPaperCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      /** Injected for offline contract tests — sanitised payloads only. */
      quoteFixture?: Record<string, { bid: string; ask: string; mid: string; eventTime?: string }>;
      /** Max quote event age before rejection (ms). */
      maxEventAgeMs?: number;
    } = {},
  ) {}

  /** Mark AUTH_FAILED after an upstream 401/403 (D10). */
  noteAuthFailure(): void {
    this.authFailed = true;
    this.authenticatedOk = false;
  }

  noteAuthSuccess(): void {
    this.authFailed = false;
    this.authenticatedOk = true;
  }

  private urlsValid(): boolean {
    // Audit L5: strict allowlist — HTTPS to Alpaca's own paper/data hosts only; no localhost or plain HTTP,
    // so practice credentials can never be sent to another host.
    const trade = assertAllowlistedHttpsUrl(this.credentials.baseUrl, ALPACA_PAPER_TRADE_HOSTS_STRICT);
    const data = assertAllowlistedHttpsUrl(this.credentials.dataUrl, ALPACA_DATA_HOSTS_STRICT);
    return trade.ok && data.ok;
  }

  readiness(): ProviderReadiness {
    if (!this.credentials.apiKeyPresent || !this.credentials.apiSecretPresent) {
      return "MISSING_CREDENTIALS";
    }
    if (!this.urlsValid()) {
      return "INVALID_CONFIGURATION";
    }
    if (this.authFailed) {
      return "AUTH_FAILED";
    }
    // Offline fixtures are an explicit test transport — READY without network.
    if (this.options.quoteFixture) {
      return "READY";
    }
    // Key presence alone is not READY — require a successful authenticated response.
    if (!this.authenticatedOk) {
      return "CONNECTING";
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
    if (ready === "INVALID_CONFIGURATION") {
      return { ok: false, code: "UNAVAILABLE", error: `Alpaca paper readiness=${ready}` };
    }
    if (ready === "AUTH_FAILED") {
      return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: Alpaca rejected credentials" };
    }

    const now = (this.options.now ?? (() => new Date))();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));

    if (this.options.quoteFixture) {
      const data: InstrumentQuote[] = [];
      for (const instrument of instruments) {
        const fix = this.options.quoteFixture![instrument.symbol] ?? this.options.quoteFixture![instrument.id];
        const session = evaluateSession({ session: instrument.session, now });
        if (!fix) {
          data.push(empty(instrument, now, session.status, "alpaca:missing_fixture"));
          continue;
        }
        const complete = assertCompleteQuote({
          bid: fix.bid,
          ask: fix.ask,
          eventTime: fix.eventTime ?? now.toISOString(),
          now,
          maxEventAgeMs: this.options.maxEventAgeMs,
        });
        if (!complete.ok) {
          data.push(empty(instrument, now, session.status, `alpaca:rejected_quote:${complete.reason}`));
          continue;
        }
        data.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: "USD",
          dataState: "DEMO" as const,
          provenance: "alpaca_paper:offline_fixture — sanitised contract test; not live",
          session: session.status === "OPEN" ? ("OPEN" as const) : session.status === "CLOSED" ? ("CLOSED" as const) : ("UNKNOWN" as const),
          receivedAt: now.toISOString(),
          providerId: "alpaca_paper" as const,
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: fix.eventTime ?? now.toISOString(),
        });
      }
      return { ok: true, fetchedAt: now.toISOString(), data };
    }

    // Network path: CONNECTING is allowed to attempt — success promotes to READY.
    if (ready !== "CONNECTING" && ready !== "READY") {
      return { ok: false, code: "UNAVAILABLE", error: `Alpaca paper readiness=${ready}` };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const quotes: InstrumentQuote[] = [];
    for (const instrument of instruments) {
      const session = evaluateSession({ session: instrument.session, now });
      try {
        const symbol = encodeURIComponent(instrument.providerSymbol || instrument.symbol);
        const url = `${this.credentials.dataUrl.replace(/\/$/, "")}/v2/stocks/${symbol}/quotes/latest`;
        const response = await fetchImpl(url, {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "",
            "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "",
          },
        });
        if (response.status === 401 || response.status === 403) {
          this.noteAuthFailure();
          return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: Alpaca rejected credentials" };
        }
        if (!response.ok) {
          quotes.push(empty(instrument, now, session.status, `alpaca:http_${response.status}`));
          continue;
        }
        this.noteAuthSuccess();
        const body = (await response.json()) as {
          quote?: { bp?: number; ap?: number; t?: string };
        };
        const complete = assertCompleteQuote({
          bid: body.quote?.bp,
          ask: body.quote?.ap,
          eventTime: body.quote?.t ?? null,
          now,
          maxEventAgeMs: this.options.maxEventAgeMs,
        });
        if (!complete.ok) {
          quotes.push(empty(instrument, now, session.status, `alpaca:rejected_quote:${complete.reason}`));
          continue;
        }
        quotes.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: "USD",
          dataState: "DEMO",
          provenance: "alpaca_paper:latest_quote — paper/sandbox market data",
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: now.toISOString(),
          providerId: "alpaca_paper",
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
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
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS" || ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return {
        instrumentId,
        side,
        allowed: false,
        reasonCodes: [ready, "BLOCKED_EXTERNAL"],
      };
    }
    if (ready !== "READY" && ready !== "CONNECTING") {
      return { instrumentId, side, allowed: false, reasonCodes: [ready, "BLOCKED_EXTERNAL"] };
    }
    const instrument = SEED_INSTRUMENTS.find((item) => item.id === instrumentId);
    if (!instrument || !canPaperExecute(instrument)) {
      return { instrumentId, side, allowed: false, reasonCodes: ["NO_EXECUTION"] };
    }
    return { instrumentId, side, allowed: true, reasonCodes: ["EXTERNAL_DEMO"] };
  }

  /** Submit paper order — only when READY. Offline tests should mock fetch. Does not auto-fire from key presence. */
  async submitPaperOrder(input: {
    symbol: string;
    side: "buy" | "sell";
    qty: string;
    type?: "market" | "limit";
    clientOrderId: string;
    /** Optional bracket protection — desired until venue ACK; never invent success. */
    bracket?: { takeProfitLimit: string; stopLossStop: string };
  }): Promise<{ ok: true; brokerOrderId: string; status: string } | { ok: false; error: string; readiness: ProviderReadiness }> {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS" || ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return { ok: false, error: `Cannot submit: readiness=${ready}`, readiness: ready };
    }
    if (ready !== "READY" && ready !== "CONNECTING") {
      return { ok: false, error: `Cannot submit: readiness=${ready}`, readiness: ready };
    }
    if (!this.urlsValid()) {
      return { ok: false, error: "Cannot submit: INVALID_CONFIGURATION", readiness: "INVALID_CONFIGURATION" };
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      qty: input.qty,
      side: input.side,
      type: input.type ?? "market",
      time_in_force: "day",
      client_order_id: input.clientOrderId,
    };
    if (input.bracket) {
      body.order_class = "bracket";
      body.take_profit = { limit_price: input.bracket.takeProfitLimit };
      body.stop_loss = { stop_price: input.bracket.stopLossStop };
    }
    const response = await fetchImpl(`${this.credentials.baseUrl.replace(/\/$/, "")}/v2/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "",
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      this.noteAuthFailure();
      return { ok: false, error: "AUTH_FAILED: Alpaca rejected credentials", readiness: "AUTH_FAILED" };
    }
    if (!response.ok) {
      return { ok: false, error: `alpaca_submit:http_${response.status}`, readiness: this.readiness() };
    }
    this.noteAuthSuccess();
    const payload = (await response.json()) as { id?: string; status?: string };
    if (!payload.id) return { ok: false, error: "alpaca_submit:missing_id", readiness: this.readiness() };
    return { ok: true, brokerOrderId: payload.id, status: payload.status ?? "accepted" };
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
