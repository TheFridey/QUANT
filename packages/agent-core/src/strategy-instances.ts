import { clientOrderIdFor, intentIdFor, intentIdempotencyKey, newId } from "@odin/shared";
import { toJson, type PrismaClient } from "@odin/shared/db";
import { defaultModuleRefForSeed, resolveStrategyBinding } from "./strategy-binding.js";
import type { StrategyModule, StrategySignal, StrategyContext, StrategyBar } from "./strategy-library.js";
import type { PlanIntent } from "./types.js";

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
 *
 * `ownedByInstance` gives each instance its OWN allocation view: strategy B must not
 * see strategy A's holding as "held" (that suppressed B's entries and invented exits
 * B does not own). Without it, the legacy net view is used.
 */
export function evaluateConcurrentInstances(input: {
  instances: DurableStrategyInstance[];
  bars: StrategyBar[];
  context: StrategyContext;
  tradingEnvironment?: string | null;
  ownedByInstance?: ReadonlyMap<string, StrategyContext["openPositions"]>;
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
    const openPositions = input.ownedByInstance
      ? (input.ownedByInstance.get(instance.id) ?? [])
      : input.context.openPositions;
    for (const bar of input.bars) {
      if (!instanceMatchesInstrument(instance, bar)) continue;
      try {
        const signal = mod.onBar(bar, {
          ...input.context,
          openPositions,
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
          : (signal.intent as string) === "REDUCE_LONG"
            ? "REDUCE"
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
 * Attach durable identity to actionable signals. Identity includes the owning
 * instance, so two instances entering the same symbol in one cycle never collide,
 * while a retry of the same cycle reproduces the same intentId/clientOrderId.
 */
export function toPlanIntents(
  signals: readonly AttributedSignal[],
  opts: { cycleId: string; accountId: string; configHashByInstance?: ReadonlyMap<string, string> },
): PlanIntent[] {
  const out: PlanIntent[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const action =
      signal.intent === "ENTER_LONG"
        ? ("ENTER" as const)
        : signal.intent === "EXIT_LONG"
          ? ("EXIT" as const)
          : (signal.intent as string) === "REDUCE_LONG"
            ? ("REDUCE" as const)
            : null;
    if (!action) continue;
    const pairAddress = signal.pairAddress || signal.instrumentId;
    if (!pairAddress) continue;
    const idempotencyKey = intentIdempotencyKey({
      cycleId: opts.cycleId,
      accountId: opts.accountId,
      source: "STRATEGY",
      ownerRef: signal.strategyInstanceId,
      pairAddress,
      action,
    });
    // Genuine duplicate (same owner, same instrument, same action, same cycle) collapses; independent owners do not.
    if (seen.has(idempotencyKey)) continue;
    seen.add(idempotencyKey);
    out.push({
      intentId: intentIdFor(idempotencyKey),
      idempotencyKey,
      clientOrderId: clientOrderIdFor(idempotencyKey),
      source: "STRATEGY",
      strategyInstanceId: signal.strategyInstanceId,
      strategyVersion: signal.strategyVersion,
      moduleRef: signal.moduleRef,
      artifactHash: signal.artifactHash,
      sourceHash: signal.sourceHash,
      configHash: opts.configHashByInstance?.get(signal.strategyInstanceId) ?? null,
      instrumentId: signal.instrumentId,
      pairAddress,
      action,
      requestedQty: null,
      reasonCodes: signal.reasonCodes,
      observationReceivedAt: signal.observationReceivedAt ?? null,
    });
  }
  return out;
}

/**
 * Deterministic fair ordering with exit priority + round-robin across instances (§15).
 * `fairnessCursor` rotates the starting instance so alphabetical order cannot permanently win.
 *
 * Returns ALL entries in fair order (`ordered`). The planner admits from the front and,
 * when a candidate is rejected (budget, risk, session…), continues with the next one —
 * a rejected candidate never consumes another strategy's turn. `accepted`/`deferred`
 * preview the first `maxNewEntries` for diagnostics. No mandatory trade quota.
 */
export function allocateOpportunities<T extends { strategyInstanceId: string; intent?: string; action?: string }>(input: {
  signals: T[];
  maxNewEntries: number;
  /** Last admitted instance id from prior cycle — resume RR after that id. */
  fairnessCursor?: string | null;
}): {
  ordered: T[];
  accepted: T[];
  deferred: T[];
  nextFairnessCursor: string | null;
} {
  const kind = (s: T) => {
    const v = (s.action ?? s.intent ?? "") as string;
    if (v === "EXIT_LONG" || v === "REDUCE_LONG" || v === "EXIT" || v === "REDUCE") return "EXIT";
    if (v === "ENTER_LONG" || v === "ENTER") return "ENTER";
    return "OTHER";
  };
  const exits = input.signals.filter((s) => kind(s) === "EXIT");
  const entries = input.signals.filter((s) => kind(s) === "ENTER");
  const holds = input.signals.filter((s) => kind(s) === "OTHER");
  const byInstance = new Map<string, T[]>();
  for (const entry of entries) {
    const list = byInstance.get(entry.strategyInstanceId) ?? [];
    list.push(entry);
    byInstance.set(entry.strategyInstanceId, list);
  }
  const queues = [...byInstance.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (queues.length > 0 && input.fairnessCursor) {
    // Resume strictly after the cursor id, even when that instance has no entries this cycle.
    const cursor = input.fairnessCursor;
    const found = queues.findIndex(([id]) => id > cursor);
    const startAt = found < 0 ? 0 : found;
    const rotated = [...queues.slice(startAt), ...queues.slice(0, startAt)];
    queues.splice(0, queues.length, ...rotated);
  }
  const fairEntries: T[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [, queue] of queues) {
      const next = queue.shift();
      if (!next) continue;
      fairEntries.push(next);
      progressed = true;
    }
  }
  const limit = Math.max(0, input.maxNewEntries);
  const accepted = [...exits, ...fairEntries.slice(0, limit)];
  const deferred = [...holds, ...fairEntries.slice(limit)];
  const lastPreview = fairEntries.slice(0, limit).at(-1);
  return {
    ordered: [...exits, ...fairEntries],
    accepted,
    deferred,
    nextFairnessCursor: lastPreview?.strategyInstanceId ?? input.fairnessCursor ?? null,
  };
}

/** Fairness cursor after planning: the last instance whose entry was actually admitted. */
export function fairnessCursorAfterAdmission(
  admittedEntryInstanceIds: readonly string[],
  prior: string | null,
): string | null {
  return admittedEntryInstanceIds.at(-1) ?? prior;
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
