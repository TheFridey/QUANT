import { d } from "@odin/shared";
import type { TradeMemoryRecord } from "@odin/shared";
import { memoryForEntryDecision, type TradeMemoryStore } from "./memory.js";

const ENTRY_FORBIDDEN = [
  "netPnlUsd",
  "realizedPnlUsd",
  "exitPrice",
  "exitRationale",
  "costsUsd",
  "postExitBehaviour",
  "missedOpportunities",
  "unexpectedOutcomes",
  "afterActionReview",
] as const;

export type BeforeTradeContext = {
  marketStructure: string | null;
  momentum: string | null;
  liquidityUsd: string | null;
  volumeUsd: string | null;
  volatility: string | null;
  agentSignals: string[];
  historicalContext: string | null;
  strategyVersion: string | null;
  entryHypothesis: string | null;
  riskCalculations: Record<string, string>;
};

export type DuringTradeContext = {
  priceEvolution: string[];
  mfePct: string | null;
  maePct: string | null;
  slippageBps: string | null;
  liquidityChanges: string[];
  regime: string | null;
  riskEvents: string[];
  executionEvents: string[];
};

export type AfterTradeContext = {
  exitRationale: string | null;
  netPnlUsd: string | null;
  costsUsd: string | null;
  compliance: string | null;
  postExitBehaviour: string | null;
  missedOpportunities: string | null;
  unexpectedOutcomes: string | null;
};

export type TradeReconstruction = {
  tradeId: string;
  pairAddress: string | null;
  before: BeforeTradeContext | null;
  during: DuringTradeContext | null;
  after: AfterTradeContext | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function latest(records: TradeMemoryRecord[], phase: TradeMemoryRecord["phase"]): TradeMemoryRecord | null {
  const rows = records.filter((record) => record.phase === phase);
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1) ?? null;
}

function beforeFrom(record: TradeMemoryRecord): BeforeTradeContext {
  const risk = record.context.riskCalculations;
  const riskCalculations: Record<string, string> = {};
  if (risk && typeof risk === "object" && !Array.isArray(risk)) {
    for (const [key, value] of Object.entries(risk)) {
      if (typeof value === "string") riskCalculations[key] = value;
    }
  }
  return {
    marketStructure: text(record.context.marketStructure),
    momentum: text(record.context.momentum),
    liquidityUsd: text(record.context.liquidityUsd),
    volumeUsd: text(record.context.volumeUsd),
    volatility: text(record.context.volatility),
    agentSignals: texts(record.context.agentSignals),
    historicalContext: text(record.context.historicalContext),
    strategyVersion: text(record.context.strategyVersion),
    entryHypothesis: text(record.context.entryHypothesis),
    riskCalculations,
  };
}

function duringFrom(record: TradeMemoryRecord): DuringTradeContext {
  return {
    priceEvolution: texts(record.context.priceEvolution),
    mfePct: text(record.context.mfePct),
    maePct: text(record.context.maePct),
    slippageBps: text(record.context.slippageBps),
    liquidityChanges: texts(record.context.liquidityChanges),
    regime: text(record.context.regime),
    riskEvents: texts(record.context.riskEvents),
    executionEvents: texts(record.context.executionEvents),
  };
}

function afterFrom(record: TradeMemoryRecord): AfterTradeContext {
  return {
    exitRationale: text(record.context.exitRationale),
    netPnlUsd: text(record.context.netPnlUsd) ?? text(record.context.realizedPnlUsd),
    costsUsd: text(record.context.costsUsd),
    compliance: text(record.context.compliance),
    postExitBehaviour: text(record.context.postExitBehaviour),
    missedOpportunities: text(record.context.missedOpportunities),
    unexpectedOutcomes: text(record.context.unexpectedOutcomes),
  };
}

export function reconstructTrade(records: TradeMemoryRecord[]): TradeReconstruction | null {
  if (records.length === 0) return null;
  const tradeId = records[0]?.tradeId ?? "";
  const scoped = records.filter((record) => record.tradeId === tradeId);
  const before = latest(scoped, "BEFORE");
  const during = latest(scoped, "DURING");
  const after = latest(scoped, "AFTER");
  return {
    tradeId,
    pairAddress: scoped[0]?.pairAddress ?? null,
    before: before ? beforeFrom(before) : null,
    during: during ? duringFrom(during) : null,
    after: after ? afterFrom(after) : null,
  };
}

export function featuresForEntry(store: TradeMemoryStore, tradeId: string): {
  tradeId: string;
  features: Record<string, string>;
  leakedKeys: string[];
} {
  const features: Record<string, string> = {};
  const leakedKeys: string[] = [];
  for (const record of memoryForEntryDecision(store, tradeId)) {
    if (record.phase === "AFTER" || record.postExit) {
      leakedKeys.push("phase:AFTER");
      continue;
    }
    for (const [key, value] of Object.entries(record.context)) {
      if ((ENTRY_FORBIDDEN as readonly string[]).includes(key)) {
        leakedKeys.push(key);
        continue;
      }
      if (typeof value === "string") features[key] = value;
    }
  }
  return { tradeId, features, leakedKeys };
}

export type OutcomeCohort = {
  tradeId: string;
  netPnlUsd: string | null;
  entryFactors: string[];
  classification: "WINNER" | "LOSER" | "UNMEASURABLE";
};

export function queryWinnersAndLosers(records: TradeMemoryRecord[]): {
  winners: OutcomeCohort[];
  losers: OutcomeCohort[];
  unmeasurable: OutcomeCohort[];
} {
  const byTrade = new Map<string, TradeMemoryRecord[]>();
  for (const record of records) {
    const bucket = byTrade.get(record.tradeId) ?? [];
    bucket.push(record);
    byTrade.set(record.tradeId, bucket);
  }
  const winners: OutcomeCohort[] = [];
  const losers: OutcomeCohort[] = [];
  const unmeasurable: OutcomeCohort[] = [];
  for (const [tradeId, rows] of byTrade) {
    const view = reconstructTrade(rows);
    const net = view?.after?.netPnlUsd ?? null;
    const entryFactors = Object.entries(featuresForEntry({ records: rows }, tradeId).features).map(
      ([key, value]) => `${key}=${value}`,
    );
    let classification: OutcomeCohort["classification"] = "UNMEASURABLE";
    if (net !== null) {
      const pnl = d(net);
      if (pnl.gt(0)) classification = "WINNER";
      else if (pnl.lt(0)) classification = "LOSER";
    }
    const cohort = { tradeId, netPnlUsd: net, entryFactors, classification };
    if (classification === "WINNER") winners.push(cohort);
    else if (classification === "LOSER") losers.push(cohort);
    else unmeasurable.push(cohort);
  }
  return { winners, losers, unmeasurable };
}
