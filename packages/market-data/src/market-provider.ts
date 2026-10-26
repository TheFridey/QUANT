import type { DataState } from "@odin/shared";
import type { Instrument, MarketProviderId } from "@odin/shared";
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
  receivedAt: string;
  providerId: MarketProviderId;
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
