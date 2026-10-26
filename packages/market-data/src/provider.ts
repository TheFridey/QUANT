export type ProviderFailureCode = "UNAVAILABLE" | "UPSTREAM" | "INVALID";

export type ProviderResult<T> =
  | { ok: true; data: T; fetchedAt: string }
  | { ok: false; code: ProviderFailureCode; error: string };

export type Candle = {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
};

export type TokenSecurity = {
  tokenAddress: string;
  fields: Record<string, string | number | boolean | null>;
};

export type HolderStats = {
  tokenAddress: string;
  holderCount: string | null;
  fields: Record<string, string | number | boolean | null>;
};

export interface HistoricalProvider {
  readonly id: string;
  getOhlcv(
    tokenAddress: string,
    interval: "15m" | "1H" | "4H" | "1D",
    timeFrom: number,
    timeTo: number,
  ): Promise<ProviderResult<Candle[]>>;
  getTokenSecurity(tokenAddress: string): Promise<ProviderResult<TokenSecurity>>;
  getHolders(tokenAddress: string): Promise<ProviderResult<HolderStats>>;
}
