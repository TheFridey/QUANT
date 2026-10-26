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

export type AgentStatus = {
  agent: string;
  decision: string | null;
  confidence: string | null;
  reasonCodes: string[];
  inputSource: string | null;
  durationMs: number | null;
  outcome: string;
  pairAddress: string | null;
  modelVersion: string | null;
  createdAt: string | null;
};

export type Decision = {
  id: string;
  agent: string;
  modelVersion: string;
  pairAddress: string | null;
  decision: string;
  confidence: string;
  reasonCodes: string[];
  reasonText: string[];
  inputSource?: string | null;
  durationMs?: number | null;
  createdAt: string;
  input?: unknown;
  output?: unknown;
};

export type PositionRow = {
  pairAddress: string;
  baseSymbol: string;
  baseQty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
  markUsd: string | null;
  markState: string;
  marketValueUsd: string | null;
  unrealizedPnlUsd: string | null;
  openedAt?: string | null;
  stopUsd?: string | null;
  targetUsd?: string | null;
  stopLossPct?: string | null;
  takeProfitPct?: string | null;
  exposurePct?: string | null;
};

export type WatchlistRow = {
  pairAddress: string;
  baseAddress?: string;
  baseSymbol: string;
  quoteSymbol: string;
  dexId: string;
  score: string;
  rank: number;
  source: string;
  reasonCodes: string[];
  observedAt: string;
  priceUsd?: string | null;
  liquidityUsd?: string | null;
  volume24hUsd?: string | null;
  momentumPct?: string | null;
  freshness?: DataState | null;
  ageMs?: number | null;
  security?: {
    category: string;
    confidence: string;
    reasonCodes: string[];
    stale: boolean;
    mintAuthority: string;
    freezeAuthority: string;
  } | null;
  recommendation?: {
    agent: string;
    decision: string;
    reasonCodes: string[];
  } | null;
  lastUpdated?: string;
};

export type ActivityEvent = {
  id: string;
  kind: string;
  source: string;
  timestamp: string;
  summary: string;
  pairAddress: string | null;
  details: Record<string, unknown>;
};

export type EquityHistory = {
  range: string;
  startingBalanceUsd: string | null;
  pointCount: number;
  pricedPointCount: number;
  points: Array<{
    time: number;
    createdAt: string;
    cycleId: string | null;
    cashUsd: string;
    equityUsd: string | null;
    unrealizedPnlUsd: string | null;
    realizedPnlUsd: string;
    highWaterMarkUsd: string | null;
    exposureUsd: string | null;
    valuation: string;
    feesUsd: string;
    drawdownPct: string | null;
    gap: boolean;
  }>;
  markers: Array<{
    time: number;
    createdAt: string;
    side: string;
    baseSymbol: string;
    intent: string;
    priceUsd: string;
    qty: string;
    notionalUsd: string;
  }>;
  annotations: Array<{
    time: number;
    createdAt: string;
    kind: string;
    label: string;
    cycleId: string;
  }>;
  insufficientHistory: boolean;
};

export type Snapshot = {
  serverTime: string;
  venue: "PAPER";
  engine: {
    status: "STOPPED" | "RUNNING" | "PAUSED" | "EMERGENCY_STOP";
    flattenRequested: boolean;
    config: Record<string, string | number | boolean | null> | null;
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
    avgWinUsd?: string | null;
    avgLossUsd?: string | null;
    profitFactor?: string | null;
    expectancyUsd?: string | null;
    maxDrawdownPct?: string | null;
    sampleSize?: number;
    observed?: boolean;
    highWaterMarkUsd?: string | null;
    availableFundsUsd?: string;
    exposureUsd?: string | null;
    currentDrawdownPct?: string | null;
    largestGainUsd?: string | null;
    largestLossUsd?: string | null;
    tradeDistribution?: { wins: number; losses: number; breakeven: number };
    avgSlippageBps?: string | null;
    totalSlippageUsd?: string | null;
    fillCount?: number;
    positions: PositionRow[];
  };
  agents?: AgentStatus[];
  watchlist?: WatchlistRow[];
  health?: {
    postgres?: string;
    redis?: string;
    engine?: string | null;
    dataState?: DataState | null;
    venue?: string;
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
  decisions: Decision[];
  orders: Array<{
    id: string;
    clientOrderId?: string;
    pairAddress?: string;
    baseSymbol: string;
    side: string;
    intent: string;
    status: string;
    qty: string;
    rejectReason: string | null;
    createdAt: string;
    fills: Array<{
      id?: string;
      priceUsd: string;
      qty: string;
      feeUsd: string;
      notionalUsd: string;
      slippageBps?: string;
      observationId?: string;
    }>;
  }>;
};

export type TerminalSection =
  | "overview"
  | "radar"
  | "agents"
  | "markets"
  | "trading"
  | "portfolio"
  | "positions"
  | "history"
  | "strategy"
  | "backtesting"
  | "research"
  | "genome"
  | "memory"
  | "risk"
  | "models"
  | "autonomy"
  | "logs"
  | "settings";
