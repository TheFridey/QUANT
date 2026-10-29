import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  buildPositionKey,
  d,
  parseStrategyConfig,
  resolveExecutionContext,
  SAFETY_CODES,
  type StrategyConfig,
} from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { loadActiveSafetyStates, resolveSafetyState } from "@odin/trading-engine";
import { z } from "zod";
import {
  classifyNoTradeReason,
  NO_TRADE_FAMILIES,
  parseWindow,
  summarizeNoTrades,
  windowStart,
  type ActiveCondition,
} from "./why-no-trades.js";

export const WHY_NO_TRADES_BOUNDS = { cycles: 300, decisions: 5_000, intents: 500 } as const;

export const CAPACITY_BOUNDS = {
  instances: 50,
  allocations: 1_000,
  waitingIntentsTotal: 200,
  waitingIntentsPerInstance: 5,
  positions: 200,
  protectionLegs: 1_000,
  recoveryCases: 50,
} as const;

/** Intent statuses that mean "the strategy wanted to trade but is waiting or was refused". */
export const WAITING_INTENT_STATUSES = ["DEFERRED", "REJECTED", "PENDING", "UNKNOWN"] as const;

/**
 * Every RecoveryCase kind is an unresolved discrepancy (settlement, drift, unknown submission,
 * incomplete fill, protection gap, unknown cancel), so any OPEN case blocks resuming entries.
 */

/** A clean local reconcile older than this does not prove current state. */
export const RECONCILE_MAX_AGE_MS = 15 * 60_000;

export const strategyInstancePatchSchema = z
  .object({
    status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]).optional(),
    budgetUsd: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,8})?$/, "budgetUsd must be a non-negative decimal string")
      .optional(),
  })
  .strict()
  .refine((value) => value.status !== undefined || value.budgetUsd !== undefined, {
    message: "Provide status and/or budgetUsd",
  });

export type ProtectionState = "PROTECTED" | "REQUESTED" | "UNPROTECTED";

type ProtectionLeg = {
  positionKey: string;
  lifecycleId: string | null;
  kind: string;
  status: string;
  ackState: string;
  remainingQty: { toString(): string };
  protectedQty: { toString(): string };
};

const STOP_KINDS = new Set(["STOP", "TRAILING"]);
const DEAD_LEG_STATUSES = new Set(["CANCELLED", "FAILED", "FILLED"]);

/**
 * Current-lifecycle protection for one net position.
 * PROTECTED only when an ARMED + ACKED stop leg covers the full local qty.
 */
export function protectionForPosition(input: {
  positionKey: string;
  lifecycleId: string | null;
  localQty: string;
  legs: ProtectionLeg[];
}): { status: ProtectionState; coveredQty: string; legCount: number } {
  const legs = input.legs.filter(
    (leg) =>
      leg.positionKey === input.positionKey &&
      STOP_KINDS.has(leg.kind) &&
      (input.lifecycleId ? leg.lifecycleId === input.lifecycleId : leg.lifecycleId === null),
  );
  let covered = d("0");
  for (const leg of legs) {
    if (leg.status !== "ARMED" || leg.ackState !== "ACKED") continue;
    const remaining = d(leg.remainingQty.toString());
    const qty = remaining.gt(0) ? remaining : d(leg.protectedQty.toString());
    if (qty.gt(covered)) covered = qty;
  }
  const local = d(input.localQty);
  if (local.gt(0) && covered.gte(local)) {
    return { status: "PROTECTED", coveredQty: covered.toFixed(8), legCount: legs.length };
  }
  const requested = legs.some(
    (leg) =>
      !DEAD_LEG_STATUSES.has(leg.status) &&
      (leg.ackState === "DESIRED_ONLY" || leg.ackState === "SUBMITTED" || leg.status === "SUBMITTED"),
  );
  return { status: requested ? "REQUESTED" : "UNPROTECTED", coveredQty: covered.toFixed(8), legCount: legs.length };
}

function differencePairs(differences: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) visit(item);
      return;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.pairAddress === "string") out.add(row.pairAddress);
    else if (typeof row.instrumentId === "string") out.add(row.instrumentId);
    if (Array.isArray(row.items)) visit(row.items);
  };
  visit(differences);
  return out;
}

function money(value: { toString(): string } | null | undefined): string {
  return d(value?.toString() ?? "0").toFixed(8);
}

@Injectable()
export class OperatorCapacityService {
  constructor(private readonly prisma: PrismaClient) {}

  async executionContext() {
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) throw new NotFoundException("Engine is not initialised");
    let config: StrategyConfig | null = null;
    try {
      config = parseStrategyConfig(engine.config);
    } catch {
      config = null;
    }
    const tradingEnvironment = config?.tradingEnvironment ?? "MARKET_DATA_PAPER";
    const dataMode = process.env.DATA_MODE === "replay" || process.env.DATA_MODE === "demo" ? process.env.DATA_MODE : "live";
    const ctx = resolveExecutionContext({ config: { tradingEnvironment }, dataMode });
    return { engine, config, ctx };
  }

  async capacity(now = new Date()) {
    const { ctx } = await this.executionContext();
    const accountId = ctx.accountId;
    const account = await this.prisma.paperAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException(`Paper account is not initialised for ${ctx.tradingEnvironment} (${accountId})`);
    }

    const instances = await this.prisma.strategyInstance.findMany({
      where: { accountId },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      take: CAPACITY_BOUNDS.instances,
    });
    const instanceIds = instances.map((row) => row.id);

    const [allocations, pendingByInstance, waitingRows, positions, recoveryCases, latestLocal, latestBroker, safety] =
      await Promise.all([
        this.prisma.strategyAllocation.findMany({
          where: { accountId },
          orderBy: [{ pairAddress: "asc" }, { strategyInstanceId: "asc" }],
          take: CAPACITY_BOUNDS.allocations,
        }),
        instanceIds.length === 0
          ? Promise.resolve([])
          : this.prisma.riskReservation.groupBy({
              by: ["strategyInstanceId"],
              where: { accountId, status: "HELD", strategyInstanceId: { in: instanceIds } },
              _sum: { remainingCashUsd: true },
            }),
        instanceIds.length === 0
          ? Promise.resolve([])
          : this.prisma.tradeIntent.findMany({
              where: {
                accountId,
                tradingEnvironment: ctx.tradingEnvironment,
                strategyInstanceId: { in: instanceIds },
                status: { in: [...WAITING_INTENT_STATUSES] },
              },
              orderBy: { createdAt: "desc" },
              take: CAPACITY_BOUNDS.waitingIntentsTotal,
            }),
        this.prisma.position.findMany({
          where: { accountId, baseQty: { gt: 0 } },
          orderBy: { pairAddress: "asc" },
          take: CAPACITY_BOUNDS.positions,
        }),
        this.prisma.recoveryCase.findMany({
          where: { accountId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
          take: CAPACITY_BOUNDS.recoveryCases,
        }),
        this.prisma.reconciliationRun.findFirst({
          where: { accountId, scope: "LOCAL_ALLOCATION" },
          orderBy: { startedAt: "desc" },
        }),
        this.prisma.reconciliationRun.findFirst({
          where: { accountId, scope: "BROKER" },
          orderBy: { startedAt: "desc" },
        }),
        loadActiveSafetyStates(this.prisma, accountId),
      ]);

    const pendingMap = new Map<string, string>();
    for (const row of pendingByInstance) {
      if (row.strategyInstanceId) pendingMap.set(row.strategyInstanceId, money(row._sum.remainingCashUsd));
    }
    const allocationsByInstance = new Map<string, typeof allocations>();
    for (const row of allocations) {
      const list = allocationsByInstance.get(row.strategyInstanceId) ?? [];
      list.push(row);
      allocationsByInstance.set(row.strategyInstanceId, list);
    }
    const waitingByInstance = new Map<string, typeof waitingRows>();
    for (const row of waitingRows) {
      if (!row.strategyInstanceId) continue;
      const list = waitingByInstance.get(row.strategyInstanceId) ?? [];
      if (list.length < CAPACITY_BOUNDS.waitingIntentsPerInstance) list.push(row);
      waitingByInstance.set(row.strategyInstanceId, list);
    }

    const instanceViews = instances.map((row) => {
      const owned = allocationsByInstance.get(row.id) ?? [];
      const filled = owned.reduce((sum, alloc) => sum.plus(d(alloc.committedCapitalUsd.toString())), d("0"));
      const pending = d(pendingMap.get(row.id) ?? "0");
      const budget = d(row.budgetUsd.toString());
      const remaining = budget.minus(filled).minus(pending);
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        status: row.status,
        health: row.health,
        moduleRef: row.moduleRef,
        instrumentIds: row.instrumentIds,
        budgetUsd: budget.toFixed(8),
        filledCommittedUsd: filled.toFixed(8),
        pendingCommittedUsd: pending.toFixed(8),
        availableUsd: (remaining.gt(0) ? remaining : d("0")).toFixed(8),
        overCommittedUsd: (remaining.lt(0) ? remaining.neg() : d("0")).toFixed(8),
        updatedAt: row.updatedAt.toISOString(),
        allocations: owned.map((alloc) => ({
          pairAddress: alloc.pairAddress,
          instrumentId: alloc.instrumentId,
          qty: money(alloc.qty),
          reservedExitQty: money(alloc.reservedExitQty),
          avgCostUsd: money(alloc.avgCostUsd),
          committedCapitalUsd: money(alloc.committedCapitalUsd),
          realizedPnlUsd: money(alloc.realizedPnlUsd),
          feesUsd: money(alloc.feesUsd),
          ownership: alloc.ownership,
          costBasisKnown: alloc.costBasisKnown,
        })),
        waitingIntents: (waitingByInstance.get(row.id) ?? []).map((intent) => {
          const family = classifyNoTradeReason(intent.statusReason, intent.reasonCodes);
          return {
            id: intent.id,
            pairAddress: intent.pairAddress,
            instrumentId: intent.instrumentId,
            action: intent.action,
            side: intent.side,
            status: intent.status,
            statusReason: intent.statusReason,
            reasonCodes: intent.reasonCodes,
            family,
            familyLabel: family ? NO_TRADE_FAMILIES[family].label : null,
            createdAt: intent.createdAt.toISOString(),
          };
        }),
      };
    });

    const positionKeys = positions.map((row) => buildPositionKey(accountId, row.pairAddress));
    const legs =
      positionKeys.length === 0
        ? []
        : await this.prisma.protectionOrder.findMany({
            where: { accountId, positionKey: { in: positionKeys } },
            orderBy: { updatedAt: "desc" },
            take: CAPACITY_BOUNDS.protectionLegs,
            select: {
              positionKey: true,
              lifecycleId: true,
              kind: true,
              status: true,
              ackState: true,
              remainingQty: true,
              protectedQty: true,
            },
          });

    const driftPairs = latestLocal ? differencePairs(latestLocal.differences) : new Set<string>();
    const casePairs = new Set(recoveryCases.map((row) => row.pairAddress).filter((v): v is string => Boolean(v)));
    const instanceNames = new Map(instances.map((row) => [row.id, row.name]));

    const netPositions = positions.map((position) => {
      const owners = allocations.filter((alloc) => alloc.pairAddress === position.pairAddress);
      const local = d(position.baseQty.toString());
      const strategyOwned = owners
        .filter((alloc) => alloc.ownership === "STRATEGY")
        .reduce((sum, alloc) => sum.plus(d(alloc.qty.toString())), d("0"));
      const explicitUnattributed = owners
        .filter((alloc) => alloc.ownership !== "STRATEGY")
        .reduce((sum, alloc) => sum.plus(d(alloc.qty.toString())), d("0"));
      const remainder = local.minus(strategyOwned);
      const protection = protectionForPosition({
        positionKey: buildPositionKey(accountId, position.pairAddress),
        lifecycleId: position.lifecycleId,
        localQty: local.toFixed(8),
        legs,
      });
      const reconciliation = casePairs.has(position.pairAddress)
        ? "RECOVERY_OPEN"
        : !latestLocal
          ? "NOT_RUN"
          : driftPairs.has(position.pairAddress)
            ? "DRIFT"
            : latestLocal.status;
      return {
        pairAddress: position.pairAddress,
        baseSymbol: position.baseSymbol,
        lifecycleId: position.lifecycleId,
        localQty: local.toFixed(8),
        allocatedQty: strategyOwned.toFixed(8),
        unattributedQty: (remainder.gt(0) ? remainder : d("0")).toFixed(8),
        explicitUnattributedQty: explicitUnattributed.toFixed(8),
        overAllocatedQty: (remainder.lt(0) ? remainder.neg() : d("0")).toFixed(8),
        owners: owners.map((alloc) => ({
          strategyInstanceId: alloc.strategyInstanceId,
          instanceName: instanceNames.get(alloc.strategyInstanceId) ?? null,
          qty: money(alloc.qty),
          reservedExitQty: money(alloc.reservedExitQty),
          ownership: alloc.ownership,
          costBasisKnown: alloc.costBasisKnown,
        })),
        protection,
        reconciliation,
      };
    });

    const presentRun = (run: typeof latestLocal) =>
      run
        ? {
            id: run.id,
            scope: run.scope,
            venue: run.venue,
            status: run.status,
            complete: run.complete,
            startedAt: run.startedAt.toISOString(),
            completedAt: run.completedAt?.toISOString() ?? null,
            ageMs: now.getTime() - (run.completedAt ?? run.startedAt).getTime(),
            coverage: run.coverage,
            differenceCount: differencePairs(run.differences).size,
          }
        : null;

    const totals = instanceViews.reduce(
      (acc, row) => ({
        budgetUsd: acc.budgetUsd.plus(d(row.budgetUsd)),
        filledCommittedUsd: acc.filledCommittedUsd.plus(d(row.filledCommittedUsd)),
        pendingCommittedUsd: acc.pendingCommittedUsd.plus(d(row.pendingCommittedUsd)),
        availableUsd: acc.availableUsd.plus(d(row.availableUsd)),
      }),
      { budgetUsd: d("0"), filledCommittedUsd: d("0"), pendingCommittedUsd: d("0"), availableUsd: d("0") },
    );

    return {
      serverTime: now.toISOString(),
      accountId,
      tradingEnvironment: ctx.tradingEnvironment,
      account: {
        cashUsd: money(account.cashUsd),
        startingBalanceUsd: money(account.startingBalanceUsd),
      },
      totals: {
        budgetUsd: totals.budgetUsd.toFixed(8),
        filledCommittedUsd: totals.filledCommittedUsd.toFixed(8),
        pendingCommittedUsd: totals.pendingCommittedUsd.toFixed(8),
        availableUsd: totals.availableUsd.toFixed(8),
      },
      entriesSuspended: safety.some((row) => row.code === SAFETY_CODES.ENTRIES_SUSPENDED),
      safetyStates: safety.map((row) => ({ code: row.code, activatedAt: row.activatedAt.toISOString() })),
      instances: instanceViews,
      netPositions,
      recoveryCases: recoveryCases.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        pairAddress: row.pairAddress,
        strategyInstanceId: row.strategyInstanceId,
        orderId: row.orderId,
        clientOrderId: row.clientOrderId,
        detail: row.detail,
        blocking: true,
        attempts: row.attempts,
        createdAt: row.createdAt.toISOString(),
      })),
      reconciliation: {
        localAllocation: presentRun(latestLocal),
        broker: presentRun(latestBroker),
      },
      bounds: CAPACITY_BOUNDS,
      notes: {
        budget: "Lowering an instance budget below its committed capital never sells — it only blocks new entries until capacity frees up.",
        available: "Available = max(0, budget − filled committed − pending reservations).",
      },
    };
  }

  async updateStrategyInstance(id: string, body: unknown, actor: string) {
    const parsed = strategyInstancePatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid strategy instance patch",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const patch = parsed.data;
    const { ctx } = await this.executionContext();
    const existing = await this.prisma.strategyInstance.findUnique({ where: { id } });
    // Another account's instance is indistinguishable from a missing one to this operator scope.
    if (!existing || existing.accountId !== ctx.accountId) throw new NotFoundException("Strategy instance not found");
    const data: { status?: string; budgetUsd?: string } = {};
    if (patch.status !== undefined && patch.status !== existing.status) data.status = patch.status;
    if (patch.budgetUsd !== undefined && !d(patch.budgetUsd).eq(d(existing.budgetUsd.toString()))) {
      data.budgetUsd = d(patch.budgetUsd).toFixed(8);
    }
    const before = { status: existing.status, budgetUsd: money(existing.budgetUsd) };
    if (Object.keys(data).length === 0) {
      return { instance: this.presentInstance(existing), changed: false, before, after: before };
    }
    const at = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.strategyInstance.update({ where: { id }, data });
      await tx.observabilityEvent.create({
        data: {
          category: "OPERATOR_AUDIT",
          name: "strategy_instance.update",
          meta: toJson({
            actor,
            at: at.toISOString(),
            accountId: ctx.accountId,
            tradingEnvironment: ctx.tradingEnvironment,
            strategyInstanceId: id,
            before,
            after: { status: row.status, budgetUsd: money(row.budgetUsd) },
          }),
        },
      });
      return row;
    });
    return {
      instance: this.presentInstance(updated),
      changed: true,
      before,
      after: { status: updated.status, budgetUsd: money(updated.budgetUsd) },
      audit: { actor, at: at.toISOString() },
      note:
        data.budgetUsd !== undefined
          ? "Budget changes never force a sale; a budget below committed capital only blocks new entries."
          : undefined,
    };
  }

  async recoveryPrerequisites(now = new Date()) {
    const { ctx } = await this.executionContext();
    const accountId = ctx.accountId;
    const [openCases, latestLocal, unknownOrders, unknownIntents, safety] = await Promise.all([
      this.prisma.recoveryCase.findMany({
        where: { accountId, status: "OPEN" },
        orderBy: { createdAt: "desc" },
        take: CAPACITY_BOUNDS.recoveryCases,
        select: { id: true, kind: true, pairAddress: true },
      }),
      this.prisma.reconciliationRun.findFirst({
        where: { accountId, scope: "LOCAL_ALLOCATION" },
        orderBy: { startedAt: "desc" },
      }),
      this.prisma.order.count({ where: { accountId, submissionState: "UNKNOWN" } }),
      this.prisma.tradeIntent.count({
        where: { accountId, tradingEnvironment: ctx.tradingEnvironment, status: "UNKNOWN" },
      }),
      loadActiveSafetyStates(this.prisma, accountId),
    ]);
    const unmet: Array<{ code: string; message: string; detail?: Record<string, unknown> }> = [];
    const blockingCases = openCases;
    if (blockingCases.length > 0) {
      unmet.push({
        code: "OPEN_RECOVERY_CASES",
        message: `${blockingCases.length} open recovery case${blockingCases.length === 1 ? "" : "s"} must be resolved first.`,
        detail: { cases: blockingCases.slice(0, 10) },
      });
    }
    if (!latestLocal) {
      unmet.push({ code: "RECONCILE_NOT_RUN", message: "No local allocation reconciliation has run for this account." });
    } else {
      const finishedAt = latestLocal.completedAt ?? latestLocal.startedAt;
      const ageMs = now.getTime() - finishedAt.getTime();
      if (latestLocal.status !== "CLEAN" || !latestLocal.complete) {
        unmet.push({
          code: "RECONCILE_NOT_CLEAN",
          message: `Latest local allocation reconciliation is ${latestLocal.status}${latestLocal.complete ? "" : " (incomplete coverage)"}.`,
          detail: { runId: latestLocal.id, status: latestLocal.status, complete: latestLocal.complete },
        });
      }
      if (ageMs > RECONCILE_MAX_AGE_MS) {
        unmet.push({
          code: "RECONCILE_STALE",
          message: `Latest reconciliation finished ${Math.round(ageMs / 60_000)} min ago; it must be under ${RECONCILE_MAX_AGE_MS / 60_000} min.`,
          detail: { runId: latestLocal.id, finishedAt: finishedAt.toISOString() },
        });
      }
    }
    if (unknownOrders > 0 || unknownIntents > 0) {
      unmet.push({
        code: "UNKNOWN_SUBMISSIONS",
        message: `${unknownOrders + unknownIntents} submission${unknownOrders + unknownIntents === 1 ? "" : "s"} in UNKNOWN state must be resolved.`,
        detail: { unknownOrders, unknownIntents },
      });
    }
    const suspended = safety.some((row) => row.code === SAFETY_CODES.ENTRIES_SUSPENDED);
    return {
      accountId,
      tradingEnvironment: ctx.tradingEnvironment,
      entriesSuspended: suspended,
      ready: unmet.length === 0,
      unmet,
      latestLocalReconciliation: latestLocal
        ? {
            id: latestLocal.id,
            status: latestLocal.status,
            complete: latestLocal.complete,
            completedAt: latestLocal.completedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  async recoverSafety(actor: string, now = new Date()) {
    const check = await this.recoveryPrerequisites(now);
    if (!check.ready) {
      throw new ConflictException({
        message: "Recovery prerequisites not met",
        code: "RECOVERY_PREREQUISITES_UNMET",
        unmet: check.unmet,
        entriesSuspended: check.entriesSuspended,
      });
    }
    const resolved = await resolveSafetyState(this.prisma, {
      accountId: check.accountId,
      codes: [SAFETY_CODES.ENTRIES_SUSPENDED],
      now,
    });
    await this.prisma.observabilityEvent.create({
      data: {
        category: "OPERATOR_AUDIT",
        name: "safety.recover",
        value: String(resolved),
        meta: toJson({
          actor,
          at: now.toISOString(),
          accountId: check.accountId,
          tradingEnvironment: check.tradingEnvironment,
          resolvedCodes: resolved > 0 ? [SAFETY_CODES.ENTRIES_SUSPENDED] : [],
          reconciliationRunId: check.latestLocalReconciliation?.id ?? null,
        }),
      },
    });
    return {
      accountId: check.accountId,
      resolved: resolved > 0,
      resolvedCodes: resolved > 0 ? [SAFETY_CODES.ENTRIES_SUSPENDED] : [],
      message: resolved > 0 ? "Entries resumed after clean reconciliation." : "Entries were not suspended; nothing to resolve.",
    };
  }

  async whyNoTrades(windowRaw: string | undefined, now = new Date()) {
    const window = parseWindow(windowRaw);
    const since = windowStart(window, now);
    const { engine, config, ctx } = await this.executionContext();
    const accountId = ctx.accountId;
    const cycles = await this.prisma.cycleRun.findMany({
      where: { accountId, tradingEnvironment: ctx.tradingEnvironment, startedAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      take: WHY_NO_TRADES_BOUNDS.cycles,
      select: { id: true },
    });
    const cycleIds = cycles.map((row) => row.id);
    const [decisions, intents, ordered, filled, capacity, unresolvedProtection, selections] = await Promise.all([
      cycleIds.length === 0
        ? Promise.resolve([])
        : this.prisma.agentDecision.findMany({
            where: { cycleId: { in: cycleIds } },
            orderBy: { createdAt: "desc" },
            take: WHY_NO_TRADES_BOUNDS.decisions,
            select: { cycleId: true, agent: true, pairAddress: true, decision: true, reasonCodes: true, createdAt: true },
          }),
      this.prisma.tradeIntent.findMany({
        where: {
          accountId,
          tradingEnvironment: ctx.tradingEnvironment,
          createdAt: { gte: since },
          status: { in: ["DEFERRED", "REJECTED", "EXPIRED", "CANCELLED", "UNKNOWN"] },
        },
        orderBy: { createdAt: "desc" },
        take: WHY_NO_TRADES_BOUNDS.intents,
        select: {
          id: true,
          cycleId: true,
          pairAddress: true,
          strategyInstanceId: true,
          status: true,
          statusReason: true,
          reasonCodes: true,
          createdAt: true,
        },
      }),
      this.prisma.order.count({ where: { accountId, createdAt: { gte: since } } }),
      this.prisma.order.count({ where: { accountId, createdAt: { gte: since }, status: "FILLED" } }),
      this.capacity(now),
      this.prisma.protectionIntent.count({ where: { accountId, status: "UNRESOLVED" } }),
      this.prisma.marketSelection.groupBy({ by: ["enabled"], _count: { _all: true } }),
    ]);

    const active: ActiveCondition[] = [];
    if (engine.status !== "RUNNING") {
      active.push({ family: "ENGINE_NOT_RUNNING", detail: `Engine is ${engine.status}.`, count: 1 });
    }
    if (capacity.safetyStates.length > 0) {
      active.push({
        family: "SAFETY_SUSPENSION",
        detail: `Active safety controls: ${capacity.safetyStates.map((row) => row.code).join(", ")}.`,
        count: capacity.safetyStates.length,
      });
    }
    if (config?.pauseNewEntries === true) {
      active.push({ family: "SAFETY_SUSPENSION", detail: "Operator paused new entries.", count: 1 });
    }
    const localRun = capacity.reconciliation.localAllocation;
    if (capacity.recoveryCases.length > 0 || (localRun && localRun.status !== "CLEAN")) {
      active.push({
        family: "RECONCILIATION_REQUIRED",
        detail: `${capacity.recoveryCases.length} open recovery case(s); latest local reconcile ${localRun?.status ?? "not run"}.`,
        count: capacity.recoveryCases.length || 1,
      });
    }
    if (unresolvedProtection > 0) {
      active.push({ family: "PROTECTION_ISSUE", detail: `${unresolvedProtection} unresolved protective exit(s).`, count: unresolvedProtection });
    }
    const inactive = capacity.instances.filter((row) => row.status === "PAUSED" || row.status === "DISABLED");
    if (inactive.length > 0) {
      active.push({
        family: "STRATEGY_PAUSED",
        detail: inactive.map((row) => `${row.name} is ${row.status.toLowerCase()}`).join("; ") + ".",
        count: inactive.length,
      });
    }
    const exhausted = capacity.instances.filter((row) => row.status === "ACTIVE" && d(row.availableUsd).lte(0));
    if (exhausted.length > 0) {
      active.push({
        family: "INSTANCE_BUDGET_EXHAUSTED",
        detail: exhausted.map((row) => `${row.name} has no available budget`).join("; ") + ".",
        count: exhausted.length,
      });
    }
    const enabledSelections = selections.find((row) => row.enabled)?._count._all ?? 0;
    const totalSelections = selections.reduce((sum, row) => sum + row._count._all, 0);
    if (totalSelections > 0 && enabledSelections === 0) {
      active.push({ family: "MARKET_NOT_SELECTED", detail: "No instruments are enabled in Market Selector.", count: 1 });
    }

    const summary = summarizeNoTrades({ decisions, intents, active });
    return {
      window,
      since: since.toISOString(),
      serverTime: now.toISOString(),
      accountId,
      tradingEnvironment: ctx.tradingEnvironment,
      cyclesInWindow: cycleIds.length,
      ordersInWindow: ordered,
      filledInWindow: filled,
      bounds: WHY_NO_TRADES_BOUNDS,
      truncated: {
        cycles: cycleIds.length >= WHY_NO_TRADES_BOUNDS.cycles,
        decisions: decisions.length >= WHY_NO_TRADES_BOUNDS.decisions,
        intents: intents.length >= WHY_NO_TRADES_BOUNDS.intents,
      },
      ...summary,
    };
  }

  private presentInstance(row: {
    id: string;
    name: string;
    status: string;
    health: string;
    budgetUsd: { toString(): string };
    moduleRef: string | null;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      health: row.health,
      budgetUsd: money(row.budgetUsd),
      moduleRef: row.moduleRef,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
