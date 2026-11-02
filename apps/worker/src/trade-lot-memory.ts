/**
 * ASCEND-09 point-in-time trade memory writer.
 *
 * Runs in the ARCHIVIST stage, i.e. after the executor transaction has committed, and only reads
 * trading tables: it never touches Order, Fill, Position, LedgerEntry, allocations or reservations.
 * Its only write is an INSERT into the append-only TradeLotSnapshot table (one row per fill,
 * idempotent on fillId). Every row a view is built from is queried with `<= asOf` (the fill time) and
 * re-filtered by the pure builder, and the finished view is checked with assertNoPostAsOfTimestamps
 * before it is written.
 *
 * Candidates are this account's fills without a snapshot, oldest first, in bounded batches, so fills
 * settled outside their own cycle (pending orders, sandbox outbox) and history before this feature are
 * picked up on later cycles.
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
import { Prisma, PrismaClient, toJson } from "@odin/shared/db";

export const SNAPSHOT_BATCH_LIMIT = 200;
/** Candidate window behind the newest snapshot; older fills without one (orphan sells) are not retried forever. */
const CANDIDATE_LOOKBACK_MS = 10 * 60_000;
const MAX_PAIR_FILLS = 20_000;
const MAX_MARKS = 5_000;

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
    }));
}

export async function persistTradeLotSnapshots(
  prisma: PrismaClient,
  input: { accountId: string; limit?: number },
): Promise<{ candidates: number; written: number; skipped: number }> {
  const limit = Math.max(1, Math.min(input.limit ?? SNAPSHOT_BATCH_LIMIT, 1000));
  const newest = await prisma.tradeLotSnapshot.aggregate({ where: { accountId: input.accountId }, _max: { asOf: true } });
  const since = newest._max.asOf ? new Date(newest._max.asOf.getTime() - CANDIDATE_LOOKBACK_MS) : new Date(0);
  const candidates = await prisma.$queryRaw<Array<{ id: string; pairAddress: string }>>`
    SELECT f."id", f."pairAddress"
    FROM "Fill" f
    JOIN "Order" o ON o."id" = f."orderId"
    LEFT JOIN "TradeLotSnapshot" s ON s."fillId" = f."id"
    WHERE o."accountId" = ${input.accountId} AND s."id" IS NULL AND f."createdAt" >= ${since}
    ORDER BY f."createdAt" ASC, f."id" ASC
    LIMIT ${limit}`;
  if (candidates.length === 0) return { candidates: 0, written: 0, skipped: 0 };

  const wanted = new Set(candidates.map((row) => row.id));
  const pairs = [...new Set(candidates.map((row) => row.pairAddress))];
  const rows: Prisma.TradeLotSnapshotCreateManyInput[] = [];
  let skipped = 0;

  for (const pairAddress of pairs) {
    const fills = await prisma.fill.findMany({
      where: { pairAddress, order: { accountId: input.accountId } },
      include: { order: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_PAIR_FILLS,
    });
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

    for (const lot of history.lots) {
      for (const event of lot.events) {
        if (!wanted.has(event.fillId)) continue;
        const fill = byId.get(event.fillId)!;
        const order = fill.order;
        const asOf = fill.createdAt;
        const observationIds = [order.decisionObservationId, order.observationId, fill.observationId, order.fillObservationId].filter((id): id is string => Boolean(id));
        const [observations, decisions, plan, cycle, instance, marks] = await Promise.all([
          prisma.marketObservation.findMany({ where: { id: { in: observationIds }, receivedAt: { lte: asOf } } }),
          prisma.agentDecision.findMany({ where: { cycleId: order.cycleId, pairAddress: { in: [pairAddress, ""] }, createdAt: { lte: asOf } } }),
          prisma.cyclePlan.findFirst({ where: { cycleId: order.cycleId, plannedAt: { lte: asOf } } }),
          prisma.cycleRun.findFirst({ where: { id: order.cycleId, startedAt: { lte: asOf } } }),
          order.strategyInstanceId ? prisma.strategyInstance.findUnique({ where: { id: order.strategyInstanceId } }) : Promise.resolve(null),
          event.side === "SELL"
            ? prisma.marketObservation.findMany({
                where: { pairAddress, receivedAt: { gte: new Date(lot.openedAt), lte: asOf }, priceUsd: { not: null } },
                select: { receivedAt: true, priceUsd: true },
                orderBy: { receivedAt: "asc" },
                take: MAX_MARKS,
              })
            : Promise.resolve([]),
        ]);
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
          skipped += 1; // never write a view that would leak post-fill data
          continue;
        }
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
    // Orphan sells (no reconstructed open lot) get no snapshot; the lot API reports them as unreconciled.
    skipped += history.orphanFills.filter((orphan) => wanted.has(orphan.fill.id)).length;
  }
  const result = rows.length > 0 ? await prisma.tradeLotSnapshot.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  return { candidates: candidates.length, written: result.count, skipped };
}
