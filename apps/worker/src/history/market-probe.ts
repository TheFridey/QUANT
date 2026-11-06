import { SEED_INSTRUMENTS, evaluateSession, isResearchOnly, type Instrument, type ProviderReadiness, type QuoteQuality } from "@odin/shared";
import { OANDA_REGISTRY_MAP } from "@odin/market-data";

/**
 * HORIZON market-readiness probe (logic). Read-only: for each registry instrument it reports which provider
 * could serve it, whether that provider is configured, the last quote it returned (bid/ask/time/age), the
 * quote's quality, the session state, and every reason the instrument cannot be paper-traded today.
 * The gateway is injected so the formatting is testable without a network; the CLI wires the real one.
 * Nothing here writes to the database, places orders or changes engine configuration.
 */

export type ProbeProviderId = "oanda_practice" | "alpaca_paper" | "frankfurter_fx";

export type ProbeQuote = {
  bid: string | null;
  ask: string | null;
  /** Single level for reference rates (no bid/ask). */
  level?: string | null;
  time: string | null;
  quality: QuoteQuality | null;
  /** Provider's own freshness label (`dataState`) when it has one: reported, never changed. */
  dataState?: string | null;
};

export type ProbeCall<T> = { ok: true; data: T } | { ok: false; error: string };

export interface MarketProbeGateway {
  /** Configuration readiness per provider, before any call (credentials present, host allowlisted). */
  readiness(): Record<ProbeProviderId, ProviderReadiness>;
  /** OANDA instrument names available on the practice account. */
  oandaAvailability(names: string[]): Promise<ProbeCall<Array<{ instrument: string; available: boolean; reason: string | null }>>>;
  /** Keyed by OANDA instrument name. */
  oandaPricing(names: string[]): Promise<ProbeCall<Record<string, ProbeQuote>>>;
  /** Keyed by ticker. */
  alpacaQuotes(symbols: string[]): Promise<ProbeCall<Record<string, ProbeQuote>>>;
  /** Keyed by registry instrument id. */
  frankfurterQuotes(instrumentIds: string[]): Promise<ProbeCall<Record<string, ProbeQuote>>>;
}

export type ProbeEntry = {
  instrumentId: string;
  symbol: string;
  assetClass: Instrument["assetClass"];
  registryProviderId: Instrument["providerId"];
  probeProvider: ProbeProviderId | null;
  providerSymbol: string | null;
  provider: { readiness: ProviderReadiness | "NOT_PROBED"; configured: boolean; respondedOk: boolean };
  availableOnAccount: boolean | null;
  availabilityReason: string | null;
  lastQuote: { bid: string | null; ask: string | null; level: string | null; time: string | null; ageMs: number | null; dataState: string | null } | null;
  quoteError: string | null;
  quality: QuoteQuality | null;
  session: { status: string; reason: string };
  /** False for every non-Solana instrument until PCR-2 lands; null where the probe does not look. */
  canPaperTradeNow: boolean | null;
  cannotTradeReasons: string[];
};

export type ProbeReport = {
  generatedAt: string;
  mode: "READ_ONLY_PROBE";
  providers: Record<ProbeProviderId, { readiness: ProviderReadiness; called: boolean; error: string | null }>;
  instruments: ProbeEntry[];
  notes: string[];
};

/** fetch with a hard request cap, GET-only enforcement and a per-request timeout. */
export function boundedFetch(timeoutMs: number, maxRequests = 8, inner: typeof fetch = fetch): typeof fetch {
  let used = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new Error("market-probe: only GET is allowed");
    used += 1;
    if (used > maxRequests) throw new Error(`market-probe: request budget ${maxRequests} exhausted`);
    return inner(input, { ...init, method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  }) as typeof fetch;
}

const CONFIGURED: ReadonlySet<ProviderReadiness> = new Set(["CONNECTING", "READY"]);

function route(instrument: Instrument, readiness: Record<ProbeProviderId, ProviderReadiness>): { provider: ProbeProviderId | null; symbol: string | null } {
  switch (instrument.assetClass) {
    case "FX_SPOT":
      // OANDA practice when configured; otherwise the ECB reference rate is all there is.
      return CONFIGURED.has(readiness.oanda_practice)
        ? { provider: "oanda_practice", symbol: OANDA_REGISTRY_MAP[instrument.id] ?? null }
        : { provider: "frankfurter_fx", symbol: instrument.id };
    case "EQUITY_ETF_PROXY":
      return { provider: "alpaca_paper", symbol: instrument.providerSymbol };
    case "COMMODITY_PROXY":
      return { provider: "oanda_practice", symbol: OANDA_REGISTRY_MAP[instrument.id] ?? null };
    default:
      return { provider: null, symbol: null };
  }
}

function ageMs(time: string | null, now: Date): number | null {
  if (!time) return null;
  const t = Date.parse(time);
  if (!Number.isFinite(t)) return null;
  const age = now.getTime() - t;
  return age >= 0 ? age : null;
}

export async function runMarketProbe(input: { gateway: MarketProbeGateway; now: Date; instruments?: Instrument[] }): Promise<ProbeReport> {
  const instruments = input.instruments ?? SEED_INSTRUMENTS;
  const readiness = input.gateway.readiness();
  const routes = new Map(instruments.map((i) => [i.id, route(i, readiness)]));
  const providers: ProbeReport["providers"] = {
    oanda_practice: { readiness: readiness.oanda_practice, called: false, error: null },
    alpaca_paper: { readiness: readiness.alpaca_paper, called: false, error: null },
    frankfurter_fx: { readiness: readiness.frankfurter_fx, called: false, error: null },
  };

  // At most one call per provider endpoint (bounded: four GETs plus OANDA pricing).
  const oandaNames = [...new Set([...routes.values()].filter((r) => r.provider === "oanda_practice" && r.symbol).map((r) => r.symbol!))];
  const alpacaSymbols = [...new Set([...routes.values()].filter((r) => r.provider === "alpaca_paper" && r.symbol).map((r) => r.symbol!))];
  const frankfurterIds = instruments.filter((i) => routes.get(i.id)?.provider === "frankfurter_fx").map((i) => i.id);

  let oandaAvailable: Map<string, { available: boolean; reason: string | null }> | null = null;
  let oandaQuotes: Record<string, ProbeQuote> = {};
  if (oandaNames.length && CONFIGURED.has(readiness.oanda_practice)) {
    providers.oanda_practice.called = true;
    const availability = await input.gateway.oandaAvailability(oandaNames);
    if (availability.ok) {
      oandaAvailable = new Map(availability.data.map((a) => [a.instrument, { available: a.available, reason: a.reason }]));
      const priceable = oandaNames.filter((n) => oandaAvailable!.get(n)?.available);
      if (priceable.length) {
        const pricing = await input.gateway.oandaPricing(priceable);
        if (pricing.ok) oandaQuotes = pricing.data;
        else providers.oanda_practice.error = pricing.error;
      }
    } else {
      providers.oanda_practice.error = availability.error;
    }
  }
  let alpacaQuotes: Record<string, ProbeQuote> = {};
  if (alpacaSymbols.length && CONFIGURED.has(readiness.alpaca_paper)) {
    providers.alpaca_paper.called = true;
    const res = await input.gateway.alpacaQuotes(alpacaSymbols);
    if (res.ok) alpacaQuotes = res.data;
    else providers.alpaca_paper.error = res.error;
  }
  let frankfurterQuotes: Record<string, ProbeQuote> = {};
  if (frankfurterIds.length) {
    providers.frankfurter_fx.called = true;
    const res = await input.gateway.frankfurterQuotes(frankfurterIds);
    if (res.ok) frankfurterQuotes = res.data;
    else providers.frankfurter_fx.error = res.error;
  }

  const entries = instruments.map((instrument): ProbeEntry => {
    const r = routes.get(instrument.id)!;
    const session = evaluateSession({ session: instrument.session, now: input.now });
    const reasons: string[] = [];
    const base = {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      assetClass: instrument.assetClass,
      registryProviderId: instrument.providerId,
      probeProvider: r.provider,
      providerSymbol: r.symbol,
      session: { status: session.status, reason: session.reason },
    };

    if (instrument.assetClass === "SPOT_CRYPTO_PAIR") {
      return {
        ...base,
        provider: { readiness: "NOT_PROBED", configured: true, respondedOk: false },
        availableOnAccount: null,
        availabilityReason: null,
        lastQuote: null,
        quoteError: null,
        quality: null,
        canPaperTradeNow: null,
        cannotTradeReasons: ["NOT_PROBED: Solana pools are discovered per cycle by the worker (DexScreener); see DIAGNOSIS.md"],
      };
    }
    if (isResearchOnly(instrument)) reasons.push("RESEARCH_ONLY: index level, no paper fills by design");
    if (!r.provider) {
      reasons.push("NO_PROVIDER: no quote source for this instrument");
    }

    const providerReadiness = r.provider ? readiness[r.provider] : "NOT_IMPLEMENTED";
    const configured = r.provider === "frankfurter_fx" || CONFIGURED.has(providerReadiness);
    if (r.provider && !configured) reasons.push(`PROVIDER_NOT_CONFIGURED: ${r.provider} readiness=${providerReadiness}`);
    if (r.provider === "oanda_practice" && !r.symbol) reasons.push("NO_OANDA_MAPPING");

    let availableOnAccount: boolean | null = null;
    let availabilityReason: string | null = null;
    if (r.provider === "oanda_practice" && r.symbol && oandaAvailable) {
      const a = oandaAvailable.get(r.symbol);
      availableOnAccount = a?.available ?? false;
      availabilityReason = a?.reason ?? (a ? null : `${r.symbol} not available on this account`);
      if (!availableOnAccount) reasons.push(`NOT_AVAILABLE_ON_ACCOUNT: ${availabilityReason}`);
    }

    const quote =
      r.provider === "oanda_practice" && r.symbol
        ? oandaQuotes[r.symbol]
        : r.provider === "alpaca_paper" && r.symbol
          ? alpacaQuotes[r.symbol]
          : r.provider === "frankfurter_fx"
            ? frankfurterQuotes[instrument.id]
            : undefined;
    const providerError = r.provider ? providers[r.provider].error : null;
    const quoteError = configured && r.provider && !quote ? (providerError ?? "NO_QUOTE_RETURNED") : null;
    if (configured && r.provider && !quote) reasons.push(`NO_QUOTE: ${quoteError}`);
    if (quote) {
      if (quote.quality?.coverage === "REFERENCE_RATE") reasons.push("REFERENCE_RATE_ONLY: daily ECB reference rate, not a tradeable quote");
      if (quote.quality?.providerTradeable === false) reasons.push("PROVIDER_NOT_TRADEABLE: provider flags the instrument non-tradeable now");
      if (quote.quality && !quote.quality.twoSided && quote.quality.coverage !== "REFERENCE_RATE") reasons.push("ONE_SIDED_QUOTE");
    }
    if (session.status !== "OPEN") reasons.push(`SESSION_${session.status}: ${session.reason}`);
    if (instrument.quote !== "USD" && !isResearchOnly(instrument)) reasons.push(`QUOTE_CURRENCY_${instrument.quote}: fills need quote→USD conversion (PCR-2)`);
    if (!isResearchOnly(instrument)) {
      reasons.push("NOT_WIRED_INTO_PAPER_PIPELINE: worker ingests Solana pools only; activation needs operator approval");
      reasons.push("RISK_ADMISSION_NEEDS_PCR2: non-crypto quotes are labelled DEMO/DELAYED and BUYs need LIVE (PCR-2)");
    }

    return {
      ...base,
      provider: { readiness: providerReadiness, configured, respondedOk: Boolean(quote) },
      availableOnAccount,
      availabilityReason,
      lastQuote: quote
        ? { bid: quote.bid, ask: quote.ask, level: quote.level ?? null, time: quote.time, ageMs: ageMs(quote.time, input.now), dataState: quote.dataState ?? null }
        : null,
      quoteError,
      quality: quote?.quality ?? null,
      canPaperTradeNow: false,
      cannotTradeReasons: reasons,
    };
  });

  return {
    generatedAt: input.now.toISOString(),
    mode: "READ_ONLY_PROBE",
    providers,
    instruments: entries,
    notes: [
      "Read-only GETs; no orders, no database writes, no engine changes.",
      "quality is descriptive only; risk admission reads each provider's dataState, which this probe does not change.",
    ],
  };
}
