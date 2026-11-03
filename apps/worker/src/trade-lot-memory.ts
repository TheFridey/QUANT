/**
 * ASCEND-09 point-in-time trade memory writer.
 *
 * Runs in the ARCHIVIST stage, i.e. after the executor transaction has committed, and only reads
 * trading tables: it never touches Order, Fill, Position, LedgerEntry, allocations or reservations.
 * Its only write is an INSERT into the append-only TradeLotSnapshot table. Every row a view is built
 * from is queried with `<= asOf` (the fill time) and re-filtered by the pure builder, and the finished
 * view is checked with assertNoPostAsOfTimestamps before it is written.
 *
 * Progress is durable without a mutable cursor: every candidate fill receives exactly one row, either a
 * snapshot (ENTRY / ADD / EXIT) or an explicit SKIPPED marker whose eventKind is the reason (orphan sell,
 * pair over the fill cap, view refused by the temporal guard). Candidates are the account's fills with
 * no row at all, oldest first, in bounded batches, so a batch of unreconstructable fills can never stall
 * the backfill and nothing is abandoned because it is old.
 *
 * Settle margin (review L1): only fills older than SNAPSHOT_SETTLE_MS are candidates. An earlier fill
 * still inside an uncommitted transaction (bounded by the executor transaction timeout) therefore cannot
 * appear after its successor has already been classified.
 */
import {
  assertNoPostAsOfTimestamps,
  buildPointInTimeView,
  lotFillFromRow,
  phaseForEvent,
  reconstructLots,
  TRADE_MEMORY_BUILDER_VERSION,
  viewHash,
  type LifecycleHint,
  type PitDecision,
  type PitObservation,
  type PitPlanOrder,
} from "@odin/analytics";
import { canonicalJson, sha256 } from "@odin/shared";
import { Prisma, PrismaClient, toJson } from "@odin/shared/db";

export const SNAPSHOT_BATCH_LIMIT = 200;
/** Upper clamp of ODIN_EXECUTOR_TX_TIMEOUT_MS (stage-runner): no executor transaction stays open longer. */
export const SNAPSHOT_SETTLE_MS = 60_000;
export const MAX_PAIR_FILLS = 20_000;
export const MAX_MARKS = 5_000;

export type SnapshotSkipReason = "ORPHAN_SELL" | "PAIR_FILL_CAP_EXCEEDED" | "TEMPORAL_GUARD_REJECTED" | "NOT_IN_RECONSTRUCTION";

export type SnapshotReport = {
  candidates: number;
  /** Rows inserted (snapshots + skip markers); 0 for a plan-only call. */
  written: number;
  snapshots: number;
  skipped: Record<SnapshotSkipReason, number>;
  /** Only fills created before this instant were candidates. */
  settledBefore: string;
};

const str = (value: { toString(): string } | null | undefined): string | null => (value == null ? null : value.toString());

function planOrders(plan: unknown): PitPlanOrder[] {
  const orders = plan && typeof plan === "object" ? (plan as { orders?: unknown }).orders : null;
  if (!Array.isArray(orders)) return [];
  return orders
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && typeof (row as { clientOrderId?: unknown }).clientOrderId === "string")
    .map((row) => ({
      clientOrderId: row.clientOrderId as string,
      qty: typeof row.qty === "string" ? row.qty : undefined,
      estimatedCostUsd: typeof row.estimatedCostUsd === "string" ? row.estimatedCostUsd : undefined,
      estimatedNotionalUsd: typeof row.estimatedNotionalUsd === "string" ? row.estimatedNotionalUsd : undefined,
      reasonCodes: Array.isArray(row.reasonCodes) && row.reasonCodes.every((code) => typeof code === "string") ? (row.reasonCodes as string[]) : undefined,
    }));
}

function skipMarker(input: { accountId: string; pairAddress: string; fillId: string; asOf: Date; reason: SnapshotSkipReason }): Prisma.TradeLotSnapshotCreateManyInput {
  const view = { builderVersion: TRADE_MEMORY_BUILDER_VERSION, phase: "SKIPPED", asOf: input.asOf.toISOString(), accountId: input.accountId, fillId: input.fillId, reason: input.reason };
  return {
    accountId: input.accountId,
    pairAddress: input.pairAddress,
    entryFillId: "",
    fillId: input.fillId,
    phase: "SKIPPED",
    eventKind: input.reason,
    asOf: input.asOf,
    view: toJson(view),
    viewHash: sha256(canonicalJson(view)),
    builderVersion: TRADE_MEMORY_BUILDER_VERSION,
  };
}

/**
 * Build (but do not insert) the rows for this account's next candidate fills. With `fillIds`, rebuild
 * exactly those fills even if they already have a row (used to check that a stored view is reproducible).
 */
export async function planTradeLotSnapshots(
  prisma: PrismaClient,
  input: { accountId: string; limit?: number; now?: Date; settleMs?: number; maxPairFills?: number; fillIds?: string[] },
): Promise<{ rows: Prisma.TradeLotSnapshotCreateManyInput[]; report: SnapshotReport }> {
  const limit = Math.max(1, Math.min(input.limit ?? SNAPSHOT_BATCH_LIMIT, 1000));
  const maxPairFills = input.maxPairFills ?? MAX_PAIR_FILLS;
  const settledBefore = new Date((input.now ?? new Date()).getTime() - (input.settleMs ?? SNAPSHOT_SETTLE_MS));
  const report: SnapshotReport = {
    candidates: 0,
    written: 0,
    snapshots: 0,
    skipped: { ORPHAN_SELL: 0, PAIR_FILL_CAP_EXCEEDED: 0, TEMPORAL_GUARD_REJECTED: 0, NOT_IN_RECONSTRUCTION: 0 },
    settledBefore: settledBefore.toISOString(),
  };
  const candidates = input.fillIds
    ? await prisma.$queryRaw<Array<{ id: string; pairAddress: string }>>`
        SELECT f."id", f."pairAddress" FROM "Fill" f JOIN "Order" o ON o."id" = f."orderId"
        WHERE o."accountId" = ${input.accountId} AND f."id" = ANY(${input.fillIds}::text[])
        ORDER BY f."createdAt" ASC, f."id" ASC`
    : await prisma.$queryRaw<Array<{ id: string; pairAddress: string }>>`
        SELECT f."id", f."pairAddress"
        FROM "Fill" f
        JOIN "Order" o ON o."id" = f."orderId"
        WHERE o."accountId" = ${input.accountId}
          AND f."createdAt" < ${settledBefore}
          AND NOT EXISTS (SELECT 1 FROM "TradeLotSnapshot" s WHERE s."fillId" = f."id")
        ORDER BY f."createdAt" ASC, f."id" ASC
        LIMIT ${limit}`;
  report.candidates = candidates.length;
  const rows: Prisma.TradeLotSnapshotCreateManyInput[] = [];
  if (candidates.length === 0) return { rows, report };

  const wanted = new Set(candidates.map((row) => row.id));
  const pairs = [...new Set(candidates.map((row) => row.pairAddress))];
  const skip = (pairAddress: string, fillId: string, asOf: Date, reason: SnapshotSkipReason) => {
    report.skipped[reason] += 1;
    rows.push(skipMarker({ accountId: input.accountId, pairAddress, fillId, asOf, reason }));
  };

  for (const pairAddress of pairs) {
    const fills = await prisma.fill.findMany({
      where: { pairAddress, order: { accountId: input.accountId } },
      include: { order: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: maxPairFills + 1,
    });
    if (fills.length > maxPairFills) {
      // The full sequence is needed to classify a fill; never classify against a truncated history.
      const ids = candidates.filter((row) => row.pairAddress === pairAddress).map((row) => row.id);
      const times = await prisma.fill.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } });
      for (const row of times) skip(pairAddress, row.id, row.createdAt, "PAIR_FILL_CAP_EXCEEDED");
      continue;
    }
    // Identity labels only (never part of the view): recorded lifecycle ids for this account and pair.
    const [position, protections, labelled] = await Promise.all([
      prisma.position.findUnique({ where: { accountId_pairAddress: { accountId: input.accountId, pairAddress } } }),
      prisma.protectionOrder.findMany({
        where: { accountId: input.accountId, positionKey: `${input.accountId}:${pairAddress}`, lifecycleId: { not: null } },
        select: { lifecycleId: true, createdAt: true },
      }),
      prisma.tradeLotSnapshot.findMany({
        where: { accountId: input.accountId, pairAddress, phase: "ENTRY", lifecycleId: { not: null } },
        select: { entryFillId: true, lifecycleId: true },
      }),
    ]);
    const hints: LifecycleHint[] = [
      ...labelled.map((row) => ({ source: "TRADE_LOT_SNAPSHOT" as const, accountId: input.accountId, pairAddress, lifecycleId: row.lifecycleId!, entryFillId: row.entryFillId })),
      ...(position?.lifecycleId && Number(position.baseQty.toString()) > 0
        ? [{ source: "POSITION" as const, accountId: input.accountId, pairAddress, lifecycleId: position.lifecycleId }]
        : []),
      ...protections.map((row) => ({ source: "PROTECTION_ORDER" as const, accountId: input.accountId, pairAddress, lifecycleId: row.lifecycleId!, at: row.createdAt.toISOString() })),
    ];
    // Classification of a fill depends only on earlier fills (sequential rebuild), so later fills in this
    // list cannot change any event below; they only help resolve the lifecycle label.
    const history = reconstructLots({ fills: fills.map(lotFillFromRow), hints, asOf: new Date().toISOString() });
    const byId = new Map(fills.map((row) => [row.id, row]));
    const handled = new Set<string>();

    for (const orphan of history.orphanFills) {
      if (!wanted.has(orphan.fill.id)) continue;
      handled.add(orphan.fill.id);
      skip(pairAddress, orphan.fill.id, byId.get(orphan.fill.id)!.createdAt, "ORPHAN_SELL");
    }

    for (const lot of history.lots) {
      const entryFill = byId.get(lot.entryFillId)!;
      for (const event of lot.events) {
        if (!wanted.has(event.fillId)) continue;
        handled.add(event.fillId);
        const fill = byId.get(event.fillId)!;
        const order = fill.order;
        const asOf = fill.createdAt;
        const observationIds = [order.decisionObservationId, order.observationId, fill.observationId, order.fillObservationId].filter((id): id is string => Boolean(id));
        const [observations, decisions, plan, cycle, instance] = await Promise.all([
          prisma.marketObservation.findMany({ where: { id: { in: observationIds }, receivedAt: { lte: asOf } } }),
          prisma.agentDecision.findMany({ where: { cycleId: order.cycleId, pairAddress: { in: [pairAddress, ""] }, createdAt: { lte: asOf } } }),
          prisma.cyclePlan.findFirst({ where: { cycleId: order.cycleId, plannedAt: { lte: asOf } } }),
          prisma.cycleRun.findFirst({ where: { id: order.cycleId, startedAt: { lte: asOf } } }),
          order.strategyInstanceId ? prisma.strategyInstance.findUnique({ where: { id: order.strategyInstanceId } }) : Promise.resolve(null),
        ]);
        // Marks for EXIT excursions: same pair, and the entry fill observation's environment and origin,
        // so fixture or replay rows never mix into a paper lot (review L2).
        let marks: Array<{ receivedAt: Date; priceUsd: Prisma.Decimal | null }> = [];
        if (event.side === "SELL") {
          const entryObservation = entryFill.observationId
            ? await prisma.marketObservation.findFirst({
                where: { id: entryFill.observationId, receivedAt: { lte: entryFill.createdAt } },
                select: { tradingEnvironment: true, dataOrigin: true },
              })
            : null;
          const environment = cycle?.tradingEnvironment ?? entryObservation?.tradingEnvironment ?? null;
          const origin = entryObservation?.dataOrigin ?? null;
          marks = await prisma.marketObservation.findMany({
            where: {
              pairAddress,
              receivedAt: { gte: new Date(lot.openedAt), lte: asOf },
              priceUsd: { not: null },
              ...(environment ? { tradingEnvironment: environment } : {}),
              ...(origin ? { dataOrigin: origin } : {}),
            },
            select: { receivedAt: true, priceUsd: true },
            orderBy: { receivedAt: "asc" },
            take: MAX_MARKS,
          });
        }
        const pinnedAt = cycle?.configRevision ? new Date(cycle.configRevision) : null;
        const [pinned, latest] = await Promise.all([
          pinnedAt && Number.isFinite(pinnedAt.getTime())
            ? prisma.engineConfigRevision.findFirst({ where: { engineId: "primary", engineUpdatedAt: pinnedAt, createdAt: { lte: asOf } }, orderBy: { createdAt: "desc" } })
            : Promise.resolve(null),
          prisma.engineConfigRevision.findFirst({ where: { engineId: "primary", createdAt: { lte: asOf } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
        ]);
        const revisions = [pinned, latest]
          .filter((row): row is NonNullable<typeof row> => row !== null)
          .map((row) => ({ configHash: row.configHash, engineUpdatedAt: row.engineUpdatedAt.toISOString(), createdAt: row.createdAt.toISOString() }));

        const view = buildPointInTimeView({
          phase: phaseForEvent(event.kind),
          kind: event.kind,
          accountId: input.accountId,
          entryFillId: lot.entryFillId,
          openedAt: lot.openedAt,
          entryPriceUsd: lot.entryPriceUsd,
          marksTruncated: marks.length >= MAX_MARKS,
          fill: {
            id: fill.id,
            orderId: fill.orderId,
            pairAddress,
            side: event.side,
            qty: fill.qty.toString(),
            priceUsd: fill.priceUsd.toString(),
            notionalUsd: fill.notionalUsd.toString(),
            feeUsd: fill.feeUsd.toString(),
            feeKnown: fill.feeKnown,
            slippageBps: fill.slippageBps.toString(),
            liquidityUsd: fill.liquidityUsd.toString(),
            source: fill.source,
            createdAt: asOf.toISOString(),
            observationId: fill.observationId,
          },
          order: {
            id: order.id,
            clientOrderId: order.clientOrderId,
            cycleId: order.cycleId,
            intent: order.intent,
            ownerScope: order.ownerScope,
            reasonCodes: order.reasonCodes,
            strategyInstanceId: fill.strategyInstanceId ?? order.strategyInstanceId,
            strategyVersion: order.strategyVersion,
            executionMode: order.executionMode,
            venue: order.venue,
            createdAt: order.createdAt.toISOString(),
            decisionObservationId: order.decisionObservationId,
            observationId: order.observationId,
            fillObservationId: order.fillObservationId,
          },
          positionQtyBefore: event.positionQtyBefore,
          positionQtyAfter: event.positionQtyAfter,
          realizedPnlUsd: event.realizedPnlUsd,
          observations: observations.map(
            (row): PitObservation => ({
              id: row.id,
              pairAddress: row.pairAddress,
              receivedAt: row.receivedAt.toISOString(),
              eventTime: row.eventTime?.toISOString() ?? null,
              freshness: row.freshness,
              dataOrigin: row.dataOrigin,
              priceUsd: str(row.priceUsd),
              liquidityUsd: str(row.liquidityUsd),
              volume24hUsd: str(row.volume24hUsd),
              priceChangeM5: str(row.priceChangeM5),
              priceChangeH1: str(row.priceChangeH1),
              pairCreatedAt: row.pairCreatedAt?.toISOString() ?? null,
            }),
          ),
          marks: marks.map((row) => ({ pairAddress, receivedAt: row.receivedAt.toISOString(), priceUsd: str(row.priceUsd) })),
          decisions: decisions.map(
            (row): PitDecision => ({
              id: row.id,
              cycleId: row.cycleId,
              agent: row.agent,
              modelVersion: row.modelVersion,
              pairAddress: row.pairAddress,
              decision: row.decision,
              confidence: row.confidence.toString(),
              reasonCodes: row.reasonCodes,
              inputSource: row.inputSource,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              output: row.output,
            }),
          ),
          plan: plan ? { plannedAt: plan.plannedAt.toISOString(), orders: planOrders(plan.plan) } : null,
          configRevisions: revisions,
          cycle: cycle
            ? { id: cycle.id, startedAt: cycle.startedAt.toISOString(), configRevision: cycle.configRevision, tradingEnvironment: cycle.tradingEnvironment, dataMode: cycle.dataMode }
            : null,
          strategyInstance: instance
            ? { id: instance.id, name: instance.name, version: instance.version, moduleRef: instance.moduleRef, artifactHash: instance.artifactHash, sourceHash: instance.sourceHash, updatedAt: instance.updatedAt.toISOString() }
            : null,
        });
        try {
          assertNoPostAsOfTimestamps(view);
        } catch {
          skip(pairAddress, fill.id, asOf, "TEMPORAL_GUARD_REJECTED"); // never write a view that would leak post-fill data
          continue;
        }
        report.snapshots += 1;
        rows.push({
          accountId: input.accountId,
          pairAddress,
          entryFillId: lot.entryFillId,
          fillId: fill.id,
          phase: view.phase,
          eventKind: event.kind,
          asOf,
          lifecycleId: lot.lifecycleId,
          lifecycleIdSource: lot.lifecycleIdSource,
          strategyInstanceId: view.strategy.strategyInstanceId,
          strategyVersion: view.strategy.strategyVersion,
          configHash: view.config.configHash,
          view: toJson(view),
          viewHash: viewHash(view),
          builderVersion: TRADE_MEMORY_BUILDER_VERSION,
        });
      }
    }
    for (const row of candidates) {
      if (row.pairAddress === pairAddress && !handled.has(row.id)) skip(pairAddress, row.id, byId.get(row.id)?.createdAt ?? new Date(0), "NOT_IN_RECONSTRUCTION");
    }
  }
  return { rows, report };
}

/** Plan and insert. Idempotent on fillId (createMany skipDuplicates). */
export async function persistTradeLotSnapshots(
  prisma: PrismaClient,
  input: { accountId: string; limit?: number; now?: Date; settleMs?: number; maxPairFills?: number },
): Promise<SnapshotReport> {
  const { rows, report } = await planTradeLotSnapshots(prisma, input);
  const result = rows.length > 0 ? await prisma.tradeLotSnapshot.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  return { ...report, written: result.count };
}
