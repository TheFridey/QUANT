import type { StrategyConfig } from "@odin/shared";

/** Historical observation used by the event-driven replay engine. Never synthesized. */
export type BacktestObservation = {
  id: string;
  pairAddress: string;
  baseSymbol: string;
  quoteAddress: string;
  quoteSymbol: string;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  volume5mUsd: string | null;
  priceChangeM5Pct: string | null;
  priceChangeH1Pct: string | null;
  txnsM5Buys: number | null;
  txnsM5Sells: number | null;
  receivedAt: string;
  freshness: "REPLAY" | "DEMO" | "LIVE" | "DELAYED" | "STALE";
  /** Provenance label — e.g. MarketObservation id, fixture path, import batch. */
  provenance: string;
};

export type BacktestEngineParams = {
  startAt: string;
  endAt: string;
  initialBalanceUsd: string;
  config: StrategyConfig;
  /** Simulated latency before a submitted order may fill (ms). */
  latencyMs: number;
  /** When true, force-close open positions at endAt using the last available mark. */
  forceLiquidateAtEnd: boolean;
  label?: string;
};

export type DataQualityReport = {
  observationCount: number;
  pairCount: number;
  spanMs: number | null;
  startAt: string | null;
  endAt: string | null;
  missingPriceCount: number;
  missingLiquidityCount: number;
  /** Tokens/pairs that appear then disappear — reported, not silently dropped. */
  disappearedPairs: Array<{ pairAddress: string; baseSymbol: string; lastSeenAt: string; observationCount: number }>;
  /** Pairs with zero usable priced observations. */
  inactivePairs: Array<{ pairAddress: string; baseSymbol: string; observationCount: number; reason: string }>;
  gaps: Array<{ pairAddress: string; from: string; to: string; gapMs: number }>;
  assumptions: string[];
};

export type SimulatedTrade = {
  id: string;
  pairAddress: string;
  baseSymbol: string;
  side: "BUY" | "SELL";
  intent: string;
  qty: string;
  priceUsd: string;
  feeUsd: string;
  slippageBps: string;
  notionalUsd: string;
  pnlUsd: string | null;
  eventAt: string;
  observationId: string | null;
  reasonCodes: string[];
};

export type EquityPoint = {
  at: string;
  cashUsd: string;
  equityUsd: string | null;
  exposureUsd: string | null;
  valuation: string;
};

export type BacktestResult = {
  params: BacktestEngineParams;
  dataQuality: DataQualityReport;
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  closedTradePnls: string[];
  feesUsd: string;
  finalCashUsd: string;
  finalEquityUsd: string | null;
  assumptions: string[];
  rejectedOrders: Array<{ at: string; pairAddress: string; reason: string }>;
};
