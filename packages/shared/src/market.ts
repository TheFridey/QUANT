import { z } from "zod";
import { DATA_STATES } from "./freshness.js";

export const AGENT_NAMES = ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR", "ARCHIVIST"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

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

export const normalizedPairSchema = z.object({
  source: z.enum(["dexscreener", "birdeye", "replay"]),
  chainId: z.literal("solana"),
  pairAddress: z.string().min(32).max(128),
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
  raw: z.unknown(),
});

export type NormalizedPair = z.infer<typeof normalizedPairSchema>;

export const cyclePairSchema = normalizedPairSchema.omit({ raw: true }).extend({
  observationId: z.string().min(1),
  freshness: z.enum(DATA_STATES),
  receivedAt: z.string().min(20),
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
      pairAddress: z.string().min(32).max(128),
      notionalUsd: z.string().regex(/^\d+(\.\d{1,8})?$/),
    })
    .strict(),
  z
    .object({
      side: z.literal("SELL"),
      pairAddress: z.string().min(32).max(128),
    })
    .strict(),
]);

export type OperatorOrder = z.infer<typeof operatorOrderSchema>;

export const emergencyStopSchema = z
  .object({
    flatten: z.boolean().optional(),
  })
  .strict();
