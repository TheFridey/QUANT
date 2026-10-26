export type DataState = "LIVE" | "DELAYED" | "STALE" | "REPLAY" | "DEMO";

export type PairRow = {
  observationId: string;
  pairAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseAddress: string;
  dexId: string;
  url: string | null;
  source: string;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  priceChangeM5Pct: string | null;
  priceChangeH1Pct: string | null;
  priceChangeH24Pct: string | null;
  freshness: DataState;
  receivedAt: string;
};

export type Snapshot = {
  serverTime: string;
  venue: "PAPER";
  engine: {
    status: "STOPPED" | "RUNNING" | "PAUSED" | "EMERGENCY_STOP";
    flattenRequested: boolean;
    config: Record<string, string | number | boolean> | null;
    configValid: boolean;
    allowedActions: string[];
    updatedAt: string;
  };
  market: { dataState: DataState | null; mode: string; pairs: PairRow[] };
  portfolio: {
    cashUsd: string;
    startingBalanceUsd: string;
    equityUsd: string | null;
    unrealizedPnlUsd: string | null;
    realizedPnlUsd: string;
    valuation: string;
    marksComplete: boolean;
    feesUsd: string;
    winRate: string | null;
    wins: number;
    losses: number;
    closedTrades: number;
    returnPct: string | null;
    positions: Array<{
      pairAddress: string;
      baseSymbol: string;
      baseQty: string;
      avgCostUsd: string;
      realizedPnlUsd: string;
      markUsd: string | null;
      markState: string;
      marketValueUsd: string | null;
      unrealizedPnlUsd: string | null;
    }>;
  };
  cycle: {
    id: string;
    trigger: string;
    status: string;
    stage: string;
    dataState: string;
    error: string | null;
    observationCount: number;
    orderCount: number;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  decisions: Array<{
    id: string;
    agent: string;
    modelVersion: string;
    pairAddress: string | null;
    decision: string;
    confidence: string;
    reasonCodes: string[];
    reasonText: string[];
    createdAt: string;
  }>;
  orders: Array<{
    id: string;
    baseSymbol: string;
    side: string;
    intent: string;
    status: string;
    qty: string;
    rejectReason: string | null;
    createdAt: string;
    fills: Array<{ priceUsd: string; qty: string; feeUsd: string; notionalUsd: string }>;
  }>;
};
