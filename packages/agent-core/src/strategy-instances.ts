import { d, newId } from "@odin/shared";
import { toJson, type PrismaClient } from "@odin/shared/db";
import { defaultModuleRefForSeed, resolveStrategyBinding } from "./strategy-binding.js";
import type { StrategyModule, StrategySignal, StrategyContext, StrategyBar } from "./strategy-library.js";

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
  /** Explicit validated module binding — never derived from display name. */
  moduleRef: string | null;
  artifactHash: string | null;
  sourceHash: string | null;
};

/** Prisma client or interactive transaction — both expose strategyInstance. */
export type StrategyInstanceStore = Pick<PrismaClient, "strategyInstance">;

export type StrategyInstanceStatus = "ACTIVE" | "PAUSED" | "DISABLED" | "UNHEALTHY";

/**
 * Canonical attributed intent feeding risk / preview / exec / audit.
 * Strategies never submit broker orders; this is the only economic signal shape.
 */
export type CanonicalAttributedIntent = {
  strategyInstanceId: string;
  strategyVersion: string;
  moduleRef: string | null;
  accountId: string;
  /** Trading environment when known at evaluation (may be filled by worker). */
  tradingEnvironment: string | null;
  instrumentId: string;
  pairAddress: string;
  action: "ENTER" | "EXIT" | "REDUCE" | "HOLD" | "RESEARCH";
  observationId: string | null;
  observationReceivedAt: string | null;
  reasonCodes: string[];
  artifactHash: string | null;
  sourceHash: string | null;
  /** Original library intent for diagnostics. */
  libraryIntent: StrategySignal["intent"] | "REDUCE_LONG";
};

export type AttributedSignal = StrategySignal & {
  strategyInstanceId: string;
  strategyVersion: string;
  moduleRef: string | null;
  accountId: string;
  artifactHash: string | null;
  sourceHash: string | null;
  observationReceivedAt?: string | null;
};

/**
 * Persist concurrent strategy instances — allocations are not venue net.
 * Updates never silently reactivate PAUSED/DISABLED or overwrite operator budgets/params
 * unless the caller explicitly opts in.
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
    moduleRef?: string | null;
    artifactHash?: string | null;
    sourceHash?: string | null;
    id?: string;
    status?: StrategyInstanceStatus;
    health?: string;
    /** When true, update may change status/params/budget (operator/API). Seed path leaves false. */
    overwriteOperatorFields?: boolean;
  },
): Promise<DurableStrategyInstance> {
  const id = input.id ?? newId("stratinst");
  const moduleRef = input.moduleRef ?? null;
  if (moduleRef) {
    const binding = resolveStrategyBinding({
      moduleRef,
      artifactHash: input.artifactHash,
      name: input.name,
      instrumentIds: input.instrumentIds,
      instanceId: id,
    });
    if (!binding.ok) {
      throw new Error(`${binding.code}: ${binding.message}`);
    }
  }

  const existing = await prisma.strategyInstance.findUnique({ where: { id } });
  if (!existing) {
    const row = await prisma.strategyInstance.create({
      data: {
        id,
        name: input.name,
        version: input.version,
        accountId: input.accountId,
        instrumentIds: input.instrumentIds,
        timeframe: input.timeframe ?? "M5",
        params: toJson(input.params ?? {}),
        budgetUsd: input.budgetUsd,
        health: input.health ?? "HEALTHY",
        status: input.status ?? "ACTIVE",
        moduleRef,
        artifactHash: input.artifactHash ?? null,
        sourceHash: input.sourceHash ?? null,
      },
    });
    return mapRow(row);
  }

  // Existing row: seed / default init must preserve operator state.
  if (!input.overwriteOperatorFields) {
    return mapRow(existing);
  }

  const row = await prisma.strategyInstance.update({
    where: { id },
    data: {
      name: input.name,
      version: input.version,
      instrumentIds: input.instrumentIds,
      timeframe: input.timeframe ?? existing.timeframe,
      params: input.params !== undefined ? toJson(input.params) : undefined,
      budgetUsd: input.budgetUsd,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.health !== undefined ? { health: input.health } : {}),
      ...(moduleRef !== null ? { moduleRef } : {}),
      artifactHash: input.artifactHash ?? existing.artifactHash,
      sourceHash: input.sourceHash ?? existing.sourceHash,
    },
  });
  return mapRow(row);
}

/** ACTIVE instances only — used by the scheduler for evaluation. */
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

/** Discover instances regardless of status (for init / operator views). */
export async function listStrategyInstances(
  prisma: StrategyInstanceStore,
  accountId: string,
): Promise<DurableStrategyInstance[]> {
  const rows = await prisma.strategyInstance.findMany({
    where: { accountId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapRow);
}

/**
 * Seed default instances only when their durable ids are absent.
 * Never upserts PAUSED/DISABLED/unhealthy rows back to ACTIVE.
 * Concurrent init is idempotent (create-if-absent by fixed id).
 */
export async function ensureDefaultStrategyInstances(
  prisma: StrategyInstanceStore,
  accountId: string,
): Promise<DurableStrategyInstance[]> {
  const existing = await listStrategyInstances(prisma, accountId);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const seeds = [
    {
      id: `stratinst_${accountId}_crypto`,
      name: "pulse-momentum-v1",
      moduleRef: defaultModuleRefForSeed("crypto"),
      version: "1.0.0",
      accountId,
      instrumentIds: ["solana:spot:universe"],
      budgetUsd: "10000.00000000",
    },
    {
      id: `stratinst_${accountId}_fx`,
      name: "pulse-momentum-v1-fx",
      moduleRef: defaultModuleRefForSeed("fx"),
      version: "1.0.0",
      accountId,
      instrumentIds: ["fx:EURUSD", "fx:GBPUSD", "fx:USDJPY"],
      budgetUsd: "10000.00000000",
    },
    {
      id: `stratinst_${accountId}_etf`,
      name: "mean-revert-fade-v1",
      moduleRef: defaultModuleRefForSeed("etf"),
      version: "1.0.0",
      accountId,
      instrumentIds: ["etf:SPY", "etf:QQQ"],
      budgetUsd: "10000.00000000",
    },
  ];
  for (const seed of seeds) {
    if (byId.has(seed.id)) continue;
    await upsertStrategyInstance(prisma, seed);
  }
  return listActiveStrategyInstances(prisma, accountId);
}

/**
 * Resolve the StrategyModule for an instance via explicit moduleRef.
 * Throws on unknown / unavailable bindings — callers should isolate per instance.
 */
export function moduleForInstance(instance: DurableStrategyInstance): StrategyModule {
  const binding = resolveStrategyBinding({
    moduleRef: instance.moduleRef,
    artifactHash: instance.artifactHash,
    name: instance.name,
    instrumentIds: instance.instrumentIds,
    instanceId: instance.id,
  });
  if (!binding.ok) {
    throw new Error(`${binding.code}: ${binding.message}`);
  }
  return binding.module;
}

/**
 * Exact / wildcard market scoping (§14).
 * `solana:spot:universe` matches Solana instruments only — never EURUSD/ETF.
 * Held-position monitoring is separate (MarketSelection still allows exits).
 */
export function instanceMatchesInstrument(
  instance: Pick<DurableStrategyInstance, "instrumentIds">,
  bar: Pick<StrategyBar, "instrumentId" | "pairAddress">,
): boolean {
  const id = bar.instrumentId || bar.pairAddress || "";
  const pair = bar.pairAddress || bar.instrumentId || "";
  if (!id && !pair) return false;
  for (const scope of instance.instrumentIds) {
    if (scope === id || scope === pair) return true;
    if (scope === "*") return true;
    if (scope.endsWith(":*")) {
      const prefix = scope.slice(0, -1);
      if (id.startsWith(prefix) || pair.startsWith(prefix)) return true;
    }
    if (scope === "solana:spot:universe") {
      if (isSolanaInstrument(id) || isSolanaInstrument(pair)) return true;
    }
  }
  return false;
}

function isSolanaInstrument(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("solana:")) return true;
  if (value.startsWith("fx:") || value.startsWith("etf:") || value.startsWith("commodity:") || value.startsWith("index:")) {
    return false;
  }
  // Base58-ish Solana mint/pair addresses are long; reject short non-solana keys.
  return /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value);
}

/**
 * Run durable instances on bars. One invalid/unhealthy binding does not abort others.
 * Exit signals sort before entries (exit priority).
 */
export function evaluateConcurrentInstances(input: {
  instances: DurableStrategyInstance[];
  bars: StrategyBar[];
  context: StrategyContext;
  tradingEnvironment?: string | null;
}): { signals: AttributedSignal[]; errors: Array<{ strategyInstanceId: string; message: string }> } {
  const signals: AttributedSignal[] = [];
  const errors: Array<{ strategyInstanceId: string; message: string }> = [];
  for (const instance of input.instances) {
    if (instance.status !== "ACTIVE") continue;
    let mod: StrategyModule;
    try {
      mod = moduleForInstance(instance);
    } catch (err) {
      errors.push({
        strategyInstanceId: instance.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const bar of input.bars) {
      if (!instanceMatchesInstrument(instance, bar)) continue;
      try {
        const signal = mod.onBar(bar, {
          ...input.context,
          config: { ...input.context.config, ...(instance.params as object) },
        });
        signals.push({
          ...signal,
          strategyInstanceId: instance.id,
          strategyVersion: `${instance.moduleRef ?? instance.name}@${instance.version}`,
          moduleRef: instance.moduleRef,
          accountId: instance.accountId,
          artifactHash: instance.artifactHash,
          sourceHash: instance.sourceHash,
          observationReceivedAt: bar.receivedAt,
        });
      } catch (err) {
        errors.push({
          strategyInstanceId: instance.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const rank = (intent: string) =>
    intent.startsWith("EXIT") || intent === "EXIT_LONG" || intent === "REDUCE_LONG"
      ? 0
      : intent.startsWith("ENTER")
        ? 2
        : 1;
  signals.sort((a, b) => rank(a.intent) - rank(b.intent) || a.strategyInstanceId.localeCompare(b.strategyInstanceId));
  return { signals, errors };
}

/**
 * Atomic-ish budget gate for real admission (§10): drop ENTER when committed+pending
 * capital already meets/exceeds instance budgetUsd. Pending counts toward capacity.
 */
export async function filterSignalsByInstanceBudget(
  prisma: Pick<PrismaClient, "strategyAllocation">,
  accountId: string,
  instances: DurableStrategyInstance[],
  signals: AttributedSignal[],
): Promise<AttributedSignal[]> {
  const budgets = new Map(instances.map((i) => [i.id, d(i.budgetUsd)]));
  const allocs = await prisma.strategyAllocation.findMany({
    where: { accountId, strategyInstanceId: { in: [...budgets.keys()] } },
  });
  const used = new Map<string, ReturnType<typeof d>>();
  for (const row of allocs) {
    const prior = used.get(row.strategyInstanceId) ?? d("0");
    used.set(
      row.strategyInstanceId,
      prior.plus(d(row.committedCapitalUsd.toString())).plus(d(row.pendingCapitalUsd.toString())),
    );
  }
  return signals.filter((signal) => {
    if (signal.intent !== "ENTER_LONG") return true;
    const budget = budgets.get(signal.strategyInstanceId);
    if (!budget) return false;
    const spent = used.get(signal.strategyInstanceId) ?? d("0");
    if (spent.gte(budget)) {
      return false;
    }
    return true;
  });
}

/** Convert library signals into canonical intents for planning/risk/audit. */
export function toCanonicalIntents(
  signals: AttributedSignal[],
  opts?: { tradingEnvironment?: string | null; observationIdByPair?: ReadonlyMap<string, string> },
): CanonicalAttributedIntent[] {
  return signals.map((signal) => {
    const pair = signal.pairAddress || signal.instrumentId;
    const action =
      signal.intent === "ENTER_LONG"
        ? "ENTER"
        : signal.intent === "EXIT_LONG"
          ? "EXIT"
          : signal.intent === "RESEARCH_NOTE"
            ? "RESEARCH"
            : "HOLD";
    return {
      strategyInstanceId: signal.strategyInstanceId,
      strategyVersion: signal.strategyVersion,
      moduleRef: signal.moduleRef,
      accountId: signal.accountId,
      tradingEnvironment: opts?.tradingEnvironment ?? null,
      instrumentId: signal.instrumentId,
      pairAddress: pair,
      action,
      observationId: opts?.observationIdByPair?.get(pair) ?? null,
      observationReceivedAt: signal.observationReceivedAt ?? null,
      reasonCodes: signal.reasonCodes,
      artifactHash: signal.artifactHash,
      sourceHash: signal.sourceHash,
      libraryIntent: signal.intent,
    };
  });
}

/**
 * Deterministic opportunity allocation with exit priority + deficit round-robin fairness
 * across instances when multiple entries compete for the same slot budget (§15).
 * `fairnessCursor` rotates the starting instance so alphabetical order cannot permanently win.
 * No mandatory trade quota.
 */
export function allocateOpportunities(input: {
  signals: AttributedSignal[];
  maxNewEntries: number;
  /** Last admitted instance id from prior cycle — resume RR after that id. */
  fairnessCursor?: string | null;
}): {
  accepted: AttributedSignal[];
  deferred: AttributedSignal[];
  nextFairnessCursor: string | null;
} {
  const exits = input.signals.filter(
    (s) => s.intent === "EXIT_LONG" || (s.intent as string) === "REDUCE_LONG",
  );
  const entries = input.signals.filter((s) => s.intent === "ENTER_LONG");
  const holds = input.signals.filter((s) => s.intent === "HOLD" || s.intent === "RESEARCH_NOTE");
  const accepted: AttributedSignal[] = [...exits];
  const deferred: AttributedSignal[] = [...holds];
  const byInstance = new Map<string, AttributedSignal[]>();
  for (const entry of entries) {
    const list = byInstance.get(entry.strategyInstanceId) ?? [];
    list.push(entry);
    byInstance.set(entry.strategyInstanceId, list);
  }
  const queues = [...byInstance.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (queues.length > 0 && input.fairnessCursor) {
    const idx = queues.findIndex(([id]) => id === input.fairnessCursor);
    if (idx >= 0) {
      const rotated = [...queues.slice(idx + 1), ...queues.slice(0, idx + 1)];
      queues.splice(0, queues.length, ...rotated);
    }
  }
  let admitted = 0;
  let progressed = true;
  let lastAdmitted: string | null = input.fairnessCursor ?? null;
  while (admitted < input.maxNewEntries && progressed) {
    progressed = false;
    for (const [instanceId, queue] of queues) {
      if (admitted >= input.maxNewEntries) break;
      const next = queue.shift();
      if (!next) continue;
      accepted.push(next);
      admitted += 1;
      lastAdmitted = instanceId;
      progressed = true;
    }
  }
  for (const [, queue] of queues) deferred.push(...queue);
  return { accepted, deferred, nextFairnessCursor: lastAdmitted };
}

/**
 * Build plan gates + attributed entry/exit maps from allocated instance signals.
 * Empty entryAllowlist is intentional: zero ENTER intents ⇒ zero automatic entries.
 * entryByPair / exitByPair carry full attribution so planning does not need a second strategy ACT.
 */
export function buildInstancePlanGates(accepted: AttributedSignal[]): {
  entryAllowlist: Set<string>;
  exitByPair: Map<string, string>;
  /** Full attributed ENTER — planning uses this path directly (not allowlist+pulse). */
  entryByPair: Map<string, AttributedSignal>;
  /** Full attributed EXIT / REDUCE. */
  exitSignalByPair: Map<string, AttributedSignal>;
  instanceByPair: Map<string, string>;
} {
  const entryAllowlist = new Set<string>();
  const exitByPair = new Map<string, string>();
  const entryByPair = new Map<string, AttributedSignal>();
  const exitSignalByPair = new Map<string, AttributedSignal>();
  const instanceByPair = new Map<string, string>();
  for (const signal of accepted) {
    const key = signal.pairAddress || signal.instrumentId;
    if (!key) continue;
    instanceByPair.set(key, signal.strategyInstanceId);
    if (signal.intent === "ENTER_LONG") {
      entryAllowlist.add(key);
      entryByPair.set(key, signal);
    }
    if (signal.intent === "EXIT_LONG") {
      exitByPair.set(key, signal.strategyInstanceId);
      exitSignalByPair.set(key, signal);
    }
  }
  return { entryAllowlist, exitByPair, entryByPair, exitSignalByPair, instanceByPair };
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
  moduleRef?: string | null;
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
    moduleRef: row.moduleRef ?? null,
    artifactHash: row.artifactHash,
    sourceHash: row.sourceHash,
  };
}
