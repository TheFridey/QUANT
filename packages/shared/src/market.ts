import { z } from "zod";
import { DATA_STATES } from "./freshness.js";

export const AGENT_NAMES = ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR", "ARCHIVIST", "ORACLE"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
/** Live paper pipeline agents only. ORACLE is supervisory / advisory and never fills. */
export const PIPELINE_AGENT_NAMES = ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR", "ARCHIVIST"] as const;

export const ENGINE_STATUSES = ["STOPPED", "RUNNING", "PAUSED", "EMERGENCY_STOP"] as const;
export type EngineStatus = (typeof ENGINE_STATUSES)[number];

export const ENGINE_ACTIONS = ["start", "pause", "resume", "emergency_stop", "stop"] as const;
export type EngineAction = (typeof ENGINE_ACTIONS)[number];

export const ORDER_SIDES = ["BUY", "SELL"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_INTENTS = ["ENTRY", "EXIT", "FLATTEN", "OPERATOR"] as const;
export type OrderIntent = (typeof ORDER_INTENTS)[number];

export const QUEUES = {
  ingest: "odin.ingest",
  sentinel: "odin.sentinel",
  pulse: "odin.pulse",
  aegis: "odin.aegis",
  atlas: "odin.atlas",
  executor: "odin.executor",
  archivist: "odin.archivist",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const STAGE_ORDER = [
  "created",
  "sentinel",
  "pulse",
  "aegis",
  "atlas",
  "executor",
  "archivist",
  "complete",
] as const;
export type CycleStage = (typeof STAGE_ORDER)[number];

export const TERMINAL_CHANNEL = "odin:terminal";
export const AGENT_BUS_CHANNEL = "odin:agent-bus";

export const EXECUTION_VENUE = "PAPER" as const;

/** Quote mints accepted for automatic entries. Symbols are not trusted. */
export const TRADABLE_QUOTE_MINTS = [
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
] as const;

export function isTradableQuote(quoteAddress: string): boolean {
  if ((TRADABLE_QUOTE_MINTS as readonly string[]).includes(quoteAddress)) return true;
  // Paper FX/ETF quotes settle in USD (or listed fiat codes) — not Solana mints.
  const fiat = quoteAddress.trim().toUpperCase();
  return fiat === "USD" || fiat === "EUR" || fiat === "GBP" || fiat === "JPY";
}

export function isPaperMultiMarketPair(pair: { chainId: string; source: string }): boolean {
  return (
    pair.chainId === "fx" ||
    pair.chainId === "equity" ||
    pair.source === "fx_stub" ||
    pair.source === "etf_stub"
  );
}

export const MARKET_SOURCES = [
  "dexscreener",
  "birdeye",
  "replay",
  "fx_stub",
  "etf_stub",
  "index_stub",
] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];

export const MARKET_CHAIN_IDS = ["solana", "fx", "equity"] as const;
export type MarketChainId = (typeof MARKET_CHAIN_IDS)[number];

export const normalizedPairSchema = z.object({
  source: z.enum(MARKET_SOURCES),
  chainId: z.enum(MARKET_CHAIN_IDS),
  /** Solana pair address or canonical paper instrument id (e.g. fx:EURUSD). */
  pairAddress: z.string().min(1).max(128),
  dexId: z.string().min(1),
  url: z.string().nullable(),
  baseAddress: z.string().min(1),
  baseSymbol: z.string().min(1),
  baseName: z.string().min(1),
  quoteAddress: z.string().min(1),
  quoteSymbol: z.string().min(1),
  priceUsd: z.string().nullable(),
  liquidityUsd: z.string().nullable(),
  volume24hUsd: z.string().nullable(),
  volume5mUsd: z.string().nullable(),
  priceChangeM5Pct: z.string().nullable(),
  priceChangeH1Pct: z.string().nullable(),
  priceChangeH24Pct: z.string().nullable(),
  txnsM5Buys: z.number().int().nullable(),
  txnsM5Sells: z.number().int().nullable(),
  /** Pair creation time from provider when available. */
  pairCreatedAt: z.string().datetime().nullable().optional(),
  /** Fully diluted valuation when the provider supplies it. */
  fdvUsd: z.string().nullable().optional(),
  /** Market cap / valuation when the provider supplies it. */
  marketCapUsd: z.string().nullable().optional(),
  raw: z.unknown(),
});

export type NormalizedPair = z.infer<typeof normalizedPairSchema>;

export const cyclePairSchema = normalizedPairSchema.omit({ raw: true }).extend({
  observationId: z.string().min(1),
  freshness: z.enum(DATA_STATES),
  receivedAt: z.string().min(20),
  pairCreatedAt: z.string().datetime().nullable().optional(),
  fdvUsd: z.string().nullable().optional(),
  marketCapUsd: z.string().nullable().optional(),
});

export type CyclePair = z.infer<typeof cyclePairSchema>;

export const loginSchema = z
  .object({
    email: z.string().trim().min(3).max(200),
    password: z.string().min(8).max(200),
  })
  .strict();

export const operatorOrderSchema = z.discriminatedUnion("side", [
  z
    .object({
      side: z.literal("BUY"),
      pairAddress: z.string().min(1).max(128),
      notionalUsd: z.string().regex(/^\d+(\.\d{1,8})?$/),
    })
    .strict(),
  z
    .object({
      side: z.literal("SELL"),
      pairAddress: z.string().min(1).max(128),
    })
    .strict(),
]);

export type OperatorOrder = z.infer<typeof operatorOrderSchema>;

export const emergencyStopSchema = z
  .object({
    flatten: z.boolean().optional(),
  })
  .strict();
