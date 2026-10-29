import { newId } from "@odin/shared";
import { toJson, type PrismaClient } from "@odin/shared/db";
import {
  createBreakoutHoldStrategy,
  createMeanRevertFadeStrategy,
  createPulseMomentumStrategy,
  type StrategyModule,
  type StrategySignal,
  type StrategyContext,
  type StrategyBar,
} from "./strategy-library.js";

export type DurableStrategyInstance = {
  id: string;
  name: string;
  version: string;
  accountId: string;
  instrumentIds: string[];
  timeframe: string;
  params: Record<string, unknown>;
  budgetUsd: string;
  health: string;
  status: string;
  artifactHash: string | null;
  sourceHash: string | null;
};

/** Prisma client or interactive transaction — both expose strategyInstance. */
export type StrategyInstanceStore = Pick<PrismaClient, "strategyInstance">;

/**
 * Persist concurrent strategy instances — allocations are not venue net.
 * Runtime scheduler loads ACTIVE rows and evaluates each through the library module.
 */
export async function upsertStrategyInstance(
  prisma: StrategyInstanceStore,
  input: {
    name: string;
    version: string;
    accountId: string;
    instrumentIds: string[];
    timeframe?: string;
    params?: Record<string, unknown>;
    budgetUsd: string;
    artifactHash?: string | null;
    sourceHash?: string | null;
    id?: string;
  },
): Promise<DurableStrategyInstance> {
  const id = input.id ?? newId("stratinst");
  const row = await prisma.strategyInstance.upsert({
    where: { id },
    create: {
      id,
      name: input.name,
      version: input.version,
      accountId: input.accountId,
      instrumentIds: input.instrumentIds,
      timeframe: input.timeframe ?? "M5",
      params: toJson(input.params ?? {}),
      budgetUsd: input.budgetUsd,
      health: "HEALTHY",
      status: "ACTIVE",
      artifactHash: input.artifactHash ?? null,
      sourceHash: input.sourceHash ?? null,
    },
    update: {
      instrumentIds: input.instrumentIds,
      params: toJson(input.params ?? {}),
      budgetUsd: input.budgetUsd,
      status: "ACTIVE",
      health: "HEALTHY",
      artifactHash: input.artifactHash ?? null,
      sourceHash: input.sourceHash ?? null,
    },
  });
  return mapRow(row);
}

export async function listActiveStrategyInstances(
  prisma: StrategyInstanceStore,
  accountId: string,
): Promise<DurableStrategyInstance[]> {
  const rows = await prisma.strategyInstance.findMany({
    where: { accountId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapRow);
}

/** Seed ≥3 concurrent instances (crypto / FX / ETF) when account has none. */
export async function ensureDefaultStrategyInstances(
  prisma: StrategyInstanceStore,
  accountId: string,
): Promise<DurableStrategyInstance[]> {
  const existing = await listActiveStrategyInstances(prisma, accountId);
  if (existing.length >= 3) return existing;
  const seeds = [
    {
      id: `stratinst_${accountId}_crypto`,
      name: "pulse-momentum-v1",
      version: "1.0.0",
      accountId,
      instrumentIds: ["solana:spot:universe"],
      budgetUsd: "10000.00000000",
    },
    {
      id: `stratinst_${accountId}_fx`,
      name: "pulse-momentum-v1-fx",
      version: "1.0.0",
      accountId,
      instrumentIds: ["fx:EURUSD", "fx:GBPUSD", "fx:USDJPY"],
      budgetUsd: "10000.00000000",
    },
    {
      id: `stratinst_${accountId}_etf`,
      name: "mean-revert-fade-v1",
      version: "1.0.0",
      accountId,
      instrumentIds: ["etf:SPY", "etf:QQQ"],
      budgetUsd: "10000.00000000",
    },
  ];
  for (const seed of seeds) {
    if (existing.some((row) => row.id === seed.id)) continue;
    await upsertStrategyInstance(prisma, seed);
  }
  return listActiveStrategyInstances(prisma, accountId);
}

export function moduleForInstance(instance: DurableStrategyInstance): StrategyModule {
  const ids = instance.instrumentIds;
  if (instance.name.includes("mean-revert")) {
    return createMeanRevertFadeStrategy({ id: instance.name, instrumentIds: ids });
  }
  if (instance.name.includes("breakout")) {
    return createBreakoutHoldStrategy({ id: instance.name, instrumentIds: ids });
  }
  return createPulseMomentumStrategy({ id: instance.name, instrumentIds: ids });
}

export type AttributedSignal = StrategySignal & {
  strategyInstanceId: string;
  strategyVersion: string;
  artifactHash: string | null;
  sourceHash: string | null;
};

/**
 * Run ≥N durable instances on bars. Exit signals sort before entries (exit priority).
 * Same-symbol instances are safe: signals stay attributed; netting is caller's job.
 */
export function evaluateConcurrentInstances(input: {
  instances: DurableStrategyInstance[];
  bars: StrategyBar[];
  context: StrategyContext;
}): AttributedSignal[] {
  const signals: AttributedSignal[] = [];
  for (const instance of input.instances) {
    const mod = moduleForInstance(instance);
    for (const bar of input.bars) {
      const id = bar.instrumentId || bar.pairAddress || "";
      if (!instance.instrumentIds.includes(id) && !instance.instrumentIds.includes(bar.pairAddress ?? "")) {
        // Allow wildcard crypto universe instances.
        if (!instance.instrumentIds.some((x) => x.startsWith("solana:"))) continue;
      }
      const signal = mod.onBar(bar, {
        ...input.context,
        config: { ...input.context.config, ...(instance.params as object) },
      });
      signals.push({
        ...signal,
        strategyInstanceId: instance.id,
        strategyVersion: `${instance.name}@${instance.version}`,
        artifactHash: instance.artifactHash,
        sourceHash: instance.sourceHash,
      });
    }
  }
  const rank = (intent: string) =>
    intent.startsWith("EXIT") || intent === "EXIT_LONG" ? 0 : intent.startsWith("ENTER") ? 2 : 1;
  signals.sort((a, b) => rank(a.intent) - rank(b.intent) || a.strategyInstanceId.localeCompare(b.strategyInstanceId));
  return signals;
}

/**
 * Deterministic opportunity allocation with exit priority + round-robin fairness
 * across instances when multiple entries compete for the same slot budget.
 */
export function allocateOpportunities(input: {
  signals: AttributedSignal[];
  maxNewEntries: number;
}): { accepted: AttributedSignal[]; deferred: AttributedSignal[] } {
  const exits = input.signals.filter((s) => s.intent === "EXIT_LONG");
  const entries = input.signals.filter((s) => s.intent === "ENTER_LONG");
  const holds = input.signals.filter((s) => s.intent === "HOLD" || s.intent === "RESEARCH_NOTE");
  const accepted: AttributedSignal[] = [...exits];
  const deferred: AttributedSignal[] = [...holds];
  // Fairness: round-robin by instance id order.
  const byInstance = new Map<string, AttributedSignal[]>();
  for (const entry of entries) {
    const list = byInstance.get(entry.strategyInstanceId) ?? [];
    list.push(entry);
    byInstance.set(entry.strategyInstanceId, list);
  }
  const queues = [...byInstance.entries()].sort(([a], [b]) => a.localeCompare(b));
  let admitted = 0;
  let progressed = true;
  while (admitted < input.maxNewEntries && progressed) {
    progressed = false;
    for (const [, queue] of queues) {
      if (admitted >= input.maxNewEntries) break;
      const next = queue.shift();
      if (!next) continue;
      accepted.push(next);
      admitted += 1;
      progressed = true;
    }
  }
  for (const [, queue] of queues) deferred.push(...queue);
  return { accepted, deferred };
}

/**
 * Build plan gates from allocated instance signals.
 * Empty entryAllowlist is intentional: zero ENTER intents ⇒ zero automatic entries
 * (never coerce to null / ungated fallback).
 */
export function buildInstancePlanGates(accepted: AttributedSignal[]): {
  entryAllowlist: Set<string>;
  exitByPair: Map<string, string>;
  instanceByPair: Map<string, string>;
} {
  const entryAllowlist = new Set<string>();
  const exitByPair = new Map<string, string>();
  const instanceByPair = new Map<string, string>();
  for (const signal of accepted) {
    const key = signal.pairAddress || signal.instrumentId;
    if (!key) continue;
    instanceByPair.set(key, signal.strategyInstanceId);
    if (signal.intent === "ENTER_LONG") {
      entryAllowlist.add(key);
    }
    if (signal.intent === "EXIT_LONG") {
      exitByPair.set(key, signal.strategyInstanceId);
    }
  }
  return { entryAllowlist, exitByPair, instanceByPair };
}

function mapRow(row: {
  id: string;
  name: string;
  version: string;
  accountId: string;
  instrumentIds: string[];
  timeframe: string;
  params: unknown;
  budgetUsd: { toString(): string };
  health: string;
  status: string;
  artifactHash: string | null;
  sourceHash: string | null;
}): DurableStrategyInstance {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    accountId: row.accountId,
    instrumentIds: row.instrumentIds,
    timeframe: row.timeframe,
    params: (row.params ?? {}) as Record<string, unknown>,
    budgetUsd: row.budgetUsd.toString(),
    health: row.health,
    status: row.status,
    artifactHash: row.artifactHash,
    sourceHash: row.sourceHash,
  };
}
