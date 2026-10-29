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
  OANDA_PRACTICE_HOSTS,
  assertAllowlistedHttpsUrl,
  assertCompleteQuote,
} from "../practice-url.js";

export type OandaPracticeCredentials = {
  tokenPresent: boolean;
  accountIdPresent: boolean;
  apiUrl: string;
  accountId: string;
};

/**
 * OANDA v20 practice (fxTrade Practice) adapter.
 * Docs: https://developer.oanda.com/rest-live-v20/introduction/
 * Practice host: https://api-fxpractice.oanda.com
 * Requires OANDA_API_TOKEN + OANDA_ACCOUNT_ID on the practice environment.
 */
export class OandaPracticeProvider implements MarketDataProvider {
  readonly id = "oanda_practice" as const;
  private authFailed = false;
  private authenticatedOk = false;

  constructor(
    private readonly credentials: OandaPracticeCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      pricingFixture?: Record<string, { bid: string; ask: string; eventTime?: string }>;
      maxEventAgeMs?: number;
    } = {},
  ) {}

  noteAuthFailure(): void {
    this.authFailed = true;
    this.authenticatedOk = false;
  }

  noteAuthSuccess(): void {
    this.authFailed = false;
    this.authenticatedOk = true;
  }

  private urlValid(): boolean {
    return assertAllowlistedHttpsUrl(this.credentials.apiUrl, OANDA_PRACTICE_HOSTS).ok;
  }

  readiness(): ProviderReadiness {
    if (!this.credentials.tokenPresent || !this.credentials.accountIdPresent) {
      return "MISSING_CREDENTIALS";
    }
    if (!this.urlValid()) {
      return "INVALID_CONFIGURATION";
    }
    if (this.authFailed) {
      return "AUTH_FAILED";
    }
    if (this.options.pricingFixture) {
      return "READY";
    }
    if (!this.authenticatedOk) {
      return "CONNECTING";
    }
    return "READY";
  }

  async listInstruments(): Promise<Instrument[]> {
    return SEED_INSTRUMENTS.filter((item) => item.assetClass === "FX_SPOT");
  }

  async getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>> {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS") {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error:
          "BLOCKED_EXTERNAL_TEST: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID (fxpractice). See docs/mvp/PROVIDER_CAPABILITIES.md",
      };
    }
    if (ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return { ok: false, code: "UNAVAILABLE", error: `OANDA practice readiness=${ready}` };
    }

    const now = (this.options.now ?? (() => new Date))();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));

    if (this.options.pricingFixture) {
      const data: InstrumentQuote[] = [];
      for (const instrument of instruments) {
        const underscored = `${instrument.base}_${instrument.quote}`;
        const fix =
          this.options.pricingFixture![instrument.providerSymbol] ??
          this.options.pricingFixture![underscored] ??
          this.options.pricingFixture![instrument.symbol] ??
          this.options.pricingFixture![instrument.id];
        const session = evaluateSession({ session: instrument.session, now });
        if (!fix) {
          data.push(empty(instrument, now, session.status, "oanda:missing_fixture"));
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
          data.push(empty(instrument, now, session.status, `oanda:rejected_quote:${complete.reason}`));
          continue;
        }
        data.push({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: instrument.quote,
          dataState: "DEMO" as const,
          provenance: "oanda_practice:offline_fixture — sanitised contract test",
          session: session.status === "OPEN" ? ("OPEN" as const) : session.status === "CLOSED" ? ("CLOSED" as const) : ("UNKNOWN" as const),
          receivedAt: now.toISOString(),
          providerId: "oanda_practice" as const,
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: fix.eventTime ?? now.toISOString(),
        });
      }
      return { ok: true, fetchedAt: now.toISOString(), data };
    }

    if (ready !== "CONNECTING" && ready !== "READY") {
      return { ok: false, code: "UNAVAILABLE", error: `OANDA practice readiness=${ready}` };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const instrumentsParam = instruments
      .map((i) => (i.providerSymbol.includes("_") ? i.providerSymbol : `${i.base}_${i.quote}`))
      .join(",");
    try {
      const url = `${this.credentials.apiUrl.replace(/\/$/, "")}/v3/accounts/${this.credentials.accountId}/pricing?instruments=${encodeURIComponent(instrumentsParam)}`;
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${process.env.OANDA_API_TOKEN ?? ""}`,
          "content-type": "application/json",
        },
      });
      if (response.status === 401 || response.status === 403) {
        this.noteAuthFailure();
        return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: OANDA rejected token" };
      }
      if (!response.ok) {
        return { ok: false, code: "UNAVAILABLE", error: `oanda:http_${response.status}` };
      }
      this.noteAuthSuccess();
      const body = (await response.json()) as {
        prices?: Array<{
          instrument?: string;
          time?: string;
          bids?: Array<{ price?: string }>;
          asks?: Array<{ price?: string }>;
        }>;
      };
      const byInst = new Map(
        (body.prices ?? []).map((p) => [p.instrument?.replace("_", "") ?? "", p]),
      );
      const quotes: InstrumentQuote[] = instruments.map((instrument) => {
        const session = evaluateSession({ session: instrument.session, now });
        const row =
          byInst.get(instrument.symbol) ??
          byInst.get(`${instrument.base}${instrument.quote}`);
        const complete = assertCompleteQuote({
          bid: row?.bids?.[0]?.price,
          ask: row?.asks?.[0]?.price,
          eventTime: row?.time ?? null,
          now,
          maxEventAgeMs: this.options.maxEventAgeMs,
        });
        if (!complete.ok) {
          return empty(instrument, now, session.status, `oanda:rejected_quote:${complete.reason}`);
        }
        return {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: complete.mid.toFixed(8),
          currency: instrument.quote,
          dataState: "DEMO",
          provenance: "oanda_practice:pricing — fxTrade Practice demo",
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: now.toISOString(),
          providerId: "oanda_practice",
          bid: complete.bid.toFixed(8),
          ask: complete.ask.toFixed(8),
          eventTime: row?.time ?? null,
        };
      });
      return { ok: true, fetchedAt: now.toISOString(), data: quotes };
    } catch (error) {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error: `oanda:error:${error instanceof Error ? error.message : "unknown"}`,
      };
    }
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

  /**
   * Submit STOP_LOSS / TAKE_PROFIT against an open trade on practice.
   * Returns desired≠acked failure when credentials missing — never invents ACK.
   */
  async submitProtectiveOrders(input: {
    tradeId: string;
    stopLossPrice?: string | null;
    takeProfitPrice?: string | null;
  }): Promise<
    | { ok: true; orderIds: string[]; status: string }
    | { ok: false; error: string; readiness: ProviderReadiness }
  > {
    const ready = this.readiness();
    if (ready === "MISSING_CREDENTIALS" || ready === "INVALID_CONFIGURATION" || ready === "AUTH_FAILED") {
      return { ok: false, error: `Cannot submit protective orders: readiness=${ready}`, readiness: ready };
    }
    if (ready !== "READY" && ready !== "CONNECTING") {
      return { ok: false, error: `Cannot submit protective orders: readiness=${ready}`, readiness: ready };
    }
    if (!input.stopLossPrice && !input.takeProfitPrice) {
      return { ok: false, error: "NO_PROTECTIVE_PRICES", readiness: ready };
    }
    if (!this.urlValid()) {
      return { ok: false, error: "Cannot submit: INVALID_CONFIGURATION", readiness: "INVALID_CONFIGURATION" };
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const orderIds: string[] = [];
    const specs: Array<{ type: string; price: string }> = [];
    if (input.stopLossPrice) specs.push({ type: "STOP_LOSS", price: input.stopLossPrice });
    if (input.takeProfitPrice) specs.push({ type: "TAKE_PROFIT", price: input.takeProfitPrice });
    for (const spec of specs) {
      const response = await fetchImpl(
        `${this.credentials.apiUrl.replace(/\/$/, "")}/v3/accounts/${this.credentials.accountId}/orders`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OANDA_API_TOKEN ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            order: {
              type: spec.type,
              tradeID: input.tradeId,
              price: spec.price,
              timeInForce: "GTC",
            },
          }),
        },
      );
      if (response.status === 401 || response.status === 403) {
        this.noteAuthFailure();
        return { ok: false, error: "AUTH_FAILED: OANDA rejected token", readiness: "AUTH_FAILED" };
      }
      if (!response.ok) {
        return { ok: false, error: `oanda_protect:http_${response.status}`, readiness: this.readiness() };
      }
      this.noteAuthSuccess();
      const body = (await response.json()) as {
        orderCreateTransaction?: { id?: string };
        orderFillTransaction?: { id?: string };
      };
      const id = body.orderCreateTransaction?.id ?? body.orderFillTransaction?.id;
      if (!id) return { ok: false, error: "oanda_protect:missing_id", readiness: this.readiness() };
      orderIds.push(id);
    }
    return { ok: true, orderIds, status: "accepted" };
  }
}

export function inventoryOandaCredentials(env: NodeJS.ProcessEnv = process.env): OandaPracticeCredentials {
  return {
    tokenPresent: Boolean(env.OANDA_API_TOKEN?.trim()),
    accountIdPresent: Boolean(env.OANDA_ACCOUNT_ID?.trim()),
    apiUrl: env.OANDA_API_URL?.trim() || "https://api-fxpractice.oanda.com",
    accountId: env.OANDA_ACCOUNT_ID?.trim() || "",
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
    currency: instrument.quote,
    dataState: "DEMO",
    provenance: `${provenance} — null; never invent`,
    session: sessionStatus === "OPEN" ? "OPEN" : sessionStatus === "CLOSED" ? "CLOSED" : "UNKNOWN",
    receivedAt: now.toISOString(),
    providerId: "oanda_practice",
    bid: null,
    ask: null,
    eventTime: null,
  };
}
