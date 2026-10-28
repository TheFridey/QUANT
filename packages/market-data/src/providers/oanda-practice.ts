import {
  SEED_INSTRUMENTS,
  canPaperExecute,
  evaluateSession,
  type Instrument,
  type ProviderReadiness,
} from "@odin/shared";
import type { MarketDataProvider, InstrumentQuote, OrderSpec, MarketSessionStatus } from "../market-provider.js";
import type { ProviderResult } from "../provider.js";

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

  constructor(
    private readonly credentials: OandaPracticeCredentials,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      pricingFixture?: Record<string, { bid: string; ask: string }>;
    } = {},
  ) {}

  readiness(): ProviderReadiness {
    if (!this.credentials.tokenPresent || !this.credentials.accountIdPresent) {
      return "MISSING_CREDENTIALS";
    }
    if (!this.credentials.apiUrl.includes("fxpractice") && !this.credentials.apiUrl.includes("localhost")) {
      return "INVALID_CONFIGURATION";
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
    if (ready !== "READY") {
      return { ok: false, code: "UNAVAILABLE", error: `OANDA practice readiness=${ready}` };
    }

    const now = (this.options.now ?? (() => new Date))();
    const instruments = (await this.listInstruments()).filter((item) => instrumentIds.includes(item.id));

    if (this.options.pricingFixture) {
      return {
        ok: true,
        fetchedAt: now.toISOString(),
        data: instruments.map((instrument) => {
          const underscored = `${instrument.base}_${instrument.quote}`;
          const fix =
            this.options.pricingFixture![instrument.providerSymbol] ??
            this.options.pricingFixture![underscored] ??
            this.options.pricingFixture![instrument.symbol] ??
            this.options.pricingFixture![instrument.id];
          const session = evaluateSession({ session: instrument.session, now });
          const bid = fix ? Number(fix.bid) : NaN;
          const ask = fix ? Number(fix.ask) : NaN;
          const mid = Number.isFinite(bid) && Number.isFinite(ask) ? ((bid + ask) / 2).toFixed(8) : null;
          return {
            instrumentId: instrument.id,
            symbol: instrument.symbol,
            level: mid,
            currency: instrument.quote,
            dataState: "DEMO" as const,
            provenance: "oanda_practice:offline_fixture — sanitised contract test",
            session: session.status === "OPEN" ? ("OPEN" as const) : session.status === "CLOSED" ? ("CLOSED" as const) : ("UNKNOWN" as const),
            receivedAt: now.toISOString(),
            providerId: "oanda_practice" as const,
            bid: fix?.bid ?? null,
            ask: fix?.ask ?? null,
            eventTime: now.toISOString(),
          };
        }),
      };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const instrumentsParam = instruments
      .map((i) => i.providerSymbol.includes("_") ? i.providerSymbol : `${i.base}_${i.quote}`)
      .join(",");
    try {
      const url = `${this.credentials.apiUrl}/v3/accounts/${this.credentials.accountId}/pricing?instruments=${encodeURIComponent(instrumentsParam)}`;
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${process.env.OANDA_API_TOKEN ?? ""}`,
          "content-type": "application/json",
        },
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: "UNAVAILABLE", error: "AUTH_FAILED: OANDA rejected token" };
      }
      if (!response.ok) {
        return { ok: false, code: "UNAVAILABLE", error: `oanda:http_${response.status}` };
      }
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
        const bid = row?.bids?.[0]?.price;
        const ask = row?.asks?.[0]?.price;
        if (!bid || !ask) {
          return empty(instrument, now, session.status, "oanda:missing_price");
        }
        const mid = ((Number(bid) + Number(ask)) / 2).toFixed(8);
        return {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          level: mid,
          currency: instrument.quote,
          dataState: "DEMO",
          provenance: "oanda_practice:pricing — fxTrade Practice demo",
          session: session.status === "OPEN" ? "OPEN" : session.status === "CLOSED" ? "CLOSED" : "UNKNOWN",
          receivedAt: now.toISOString(),
          providerId: "oanda_practice",
          bid,
          ask,
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
