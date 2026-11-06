import type { DataState } from "@odin/shared";
import type { Instrument, MarketProviderId, QuoteQuality } from "@odin/shared";
import type { ProviderResult } from "./provider.js";

export type MarketSessionStatus = "OPEN" | "CLOSED" | "UNKNOWN";

export type InstrumentQuote = {
  instrumentId: string;
  symbol: string;
  /** Null when the provider has no observed level — never invented. */
  level: string | null;
  currency: string;
  dataState: DataState;
  /** Provenance label for display (e.g. DEMO stub, DELAYED free API). */
  provenance: string;
  session: MarketSessionStatus;
  /** Receive / ingest wall time (ISO). */
  receivedAt: string;
  providerId: MarketProviderId;
  /** Best bid when provider supplies a two-sided quote. */
  bid?: string | null;
  /** Best ask when provider supplies a two-sided quote. */
  ask?: string | null;
  /** Exchange/event time when distinct from receive time. */
  eventTime?: string | null;
  /**
   * HORIZON: descriptive quote quality (feed, coverage, timeliness, age). Additive only: risk admission
   * reads `dataState`, never this field, and nothing derives `dataState` from it.
   */
  quality?: QuoteQuality;
};

export type OrderSpec = {
  instrumentId: string;
  side: "BUY" | "SELL";
  /** Research-only instruments reject paper order specs. */
  allowed: boolean;
  reasonCodes: string[];
};

export interface MarketDataProvider {
  readonly id: MarketProviderId;
  listInstruments(): Promise<Instrument[]>;
  getQuotes(instrumentIds: string[]): Promise<ProviderResult<InstrumentQuote[]>>;
  getSession(instrumentId: string): Promise<MarketSessionStatus>;
  buildOrderSpec(instrumentId: string, side: "BUY" | "SELL"): OrderSpec;
}
