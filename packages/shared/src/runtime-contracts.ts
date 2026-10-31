/**
 * Frozen release contracts for attributed intents, allocations, order state,
 * and operator inactivity reasons. Parallel workstreams must extend additively.
 * See docs/archive/launch/RUNTIME_CONTRACTS.md.
 */
import { z } from "zod";

export const ATTRIBUTED_INTENT_ACTIONS = [
  "ENTER",
  "EXIT",
  "REDUCE",
  "HOLD",
  "RESEARCH",
] as const;

export type AttributedIntentAction = (typeof ATTRIBUTED_INTENT_ACTIONS)[number];

export const canonicalAttributedIntentSchema = z
  .object({
    strategyInstanceId: z.string().min(1).max(128),
    strategyVersion: z.string().min(1).max(256),
    moduleRef: z.string().min(1).max(256).nullable(),
    accountId: z.string().min(1).max(128),
    tradingEnvironment: z.string().min(1).max(64).nullable(),
    instrumentId: z.string().min(1).max(256),
    pairAddress: z.string().min(1).max(256),
    action: z.enum(ATTRIBUTED_INTENT_ACTIONS),
    observationId: z.string().min(1).max(128).nullable(),
    observationReceivedAt: z.string().datetime().nullable(),
    reasonCodes: z.array(z.string().min(1).max(64)),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/i).nullable(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/i).nullable(),
    libraryIntent: z.string().min(1).max(64),
  })
  .strict();

export type CanonicalAttributedIntentContract = z.infer<typeof canonicalAttributedIntentSchema>;

export const strategyAllocationViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    accountId: z.string().min(1).max(128),
    strategyInstanceId: z.string().min(1).max(128),
    instrumentId: z.string().min(1).max(256),
    pairAddress: z.string().min(1).max(256),
    lifecycleId: z.string().min(1).max(128).nullable(),
    qty: z.string().regex(/^-?\d+(\.\d+)?$/),
    avgCostUsd: z.string().regex(/^-?\d+(\.\d+)?$/),
    realizedPnlUsd: z.string().regex(/^-?\d+(\.\d+)?$/),
    committedCapitalUsd: z.string().regex(/^-?\d+(\.\d+)?$/),
    pendingCapitalUsd: z.string().regex(/^-?\d+(\.\d+)?$/),
  })
  .strict();

export type StrategyAllocationViewContract = z.infer<typeof strategyAllocationViewSchema>;

export const ORDER_EXECUTION_MODES = ["PAPER", "SANDBOX", "LIVE"] as const;
export const RUNTIME_ORDER_INTENTS = ["ENTRY", "EXIT", "FLATTEN", "OPERATOR"] as const;
export const RUNTIME_ORDER_STATUSES = [
  "PENDING",
  "FILLED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "UNKNOWN",
] as const;

export const orderIdentitySchema = z
  .object({
    clientOrderId: z.string().min(1).max(128),
    accountId: z.string().min(1).max(128),
    cycleId: z.string().min(1).max(128),
    pairAddress: z.string().min(1).max(256),
    instrumentId: z.string().min(1).max(256).nullable(),
    side: z.enum(["BUY", "SELL"]),
    intent: z.enum(RUNTIME_ORDER_INTENTS),
    status: z.enum(RUNTIME_ORDER_STATUSES),
    strategyInstanceId: z.string().min(1).max(128).nullable(),
    executionMode: z.enum(ORDER_EXECUTION_MODES),
    venue: z.string().min(1).max(64),
  })
  .strict();

export type OrderIdentityContract = z.infer<typeof orderIdentitySchema>;

/** Operator-visible reasons why automatic trades did not occur. */
export const WHY_NO_TRADES_FAMILIES = [
  "NO_EDGE",
  "NO_INTENT",
  "STRATEGY_INSTANCE_GATING",
  "BUDGET_EXHAUSTED",
  "MARKET_ENTRY_DISABLED",
  "ENTRIES_SUSPENDED",
  "PROTECTION_RECOVERY",
  "RECONCILE_ISSUE",
  "MISSING_CREDENTIALS",
  "BLOCKED_EXTERNAL",
  "DATA_UNAVAILABLE",
  "ENGINE_NOT_RUNNING",
] as const;

export type WhyNoTradesFamily = (typeof WHY_NO_TRADES_FAMILIES)[number];

export const whyNoTradesItemSchema = z
  .object({
    family: z.enum(WHY_NO_TRADES_FAMILIES),
    reasonCodes: z.array(z.string()),
    count: z.number().int().nonnegative(),
    detail: z.string().max(512).optional(),
  })
  .strict();

export type WhyNoTradesItem = z.infer<typeof whyNoTradesItemSchema>;

export const fairnessCursorSchema = z
  .object({
    /** Last instance id that received an ENTER admission (RR resume point). */
    lastAdmittedInstanceId: z.string().min(1).max(128).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type FairnessCursor = z.infer<typeof fairnessCursorSchema>;

/** Shared advisory lock key for DB-mutating integration tests (serialize group). */
export const INTEGRATION_TEST_ADVISORY_LOCK = 641099;
