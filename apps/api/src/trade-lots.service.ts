import { Injectable, NotFoundException } from "@nestjs/common";
import {
  collectTimestamps,
  lotExcursion,
  lotFillFromRow,
  lotMark,
  reconcileLotsWithLedger,
  reconstructLots,
  summariseLotAttribution,
  viewHash,
  type LifecycleHint,
  type Lot,
  type LotHistory,
  type PointInTimeView,
} from "@odin/analytics";
import { PrismaClient } from "@odin/shared/db";
import { TerminalService } from "./terminal.service.js";

/** Upper bound on fills read for one account; above it reconciliation reports INCOMPLETE rather than guessing. */
export const MAX_ACCOUNT_FILLS = 50_000;
const MAX_MARKS_PER_LOT = 5_000;

export type Loaded = { accountId: string; history: LotHistory; truncated: boolean; fillCount: number };

/**
 * ASCEND-09 read-only lot history API: lots rebuilt from the active account's fills, one lot's timeline
 * with its point-in-time snapshots, and per-instance attribution reconciled against the ledger.
 * Reads only; never writes any table.
 */
@Injectable()
export class TradeLotsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly terminal: TerminalService,
  ) {}

  /** Also read by FeedbackService (GENESIS Phase 7), so not private. */
  async load(now: Date): Promise<Loaded> {
    const accountId = await this.terminal.activeAccountId();
    const rows = await this.prisma.fill.findMany({
      where: { order: { accountId } },
      include: { order: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_ACCOUNT_FILLS + 1,
    });
    const truncated = rows.length > MAX_ACCOUNT_FILLS;
    const fills = (truncated ? rows.slice(0, MAX_ACCOUNT_FILLS) : rows).map(lotFillFromRow);
    const [positions, protections, snapshots] = await Promise.all([
      this.prisma.position.findMany({ where: { accountId, lifecycleId: { not: null } }, select: { pairAddress: true, lifecycleId: true, baseQty: true } }),
      this.prisma.protectionOrder.findMany({ where: { accountId, lifecycleId: { not: null } }, select: { positionKey: true, lifecycleId: true, createdAt: true } }),
      this.prisma.tradeLotSnapshot.findMany({ where: { accountId, phase: "ENTRY", lifecycleId: { not: null } }, select: { pairAddress: true, entryFillId: true, lifecycleId: true } }),
    ]);
    const prefix = `${accountId}:`;
    const hints: LifecycleHint[] = [
      ...snapshots.map((row) => ({ source: "TRADE_LOT_SNAPSHOT" as const, accountId, pairAddress: row.pairAddress, lifecycleId: row.lifecycleId!, entryFillId: row.entryFillId })),
      ...positions
        .filter((row) => Number(row.baseQty.toString()) > 0)
        .map((row) => ({ source: "POSITION" as const, accountId, pairAddress: row.pairAddress, lifecycleId: row.lifecycleId! })),
      ...protections
        .filter((row) => row.positionKey.startsWith(prefix))
        .map((row) => ({ source: "PROTECTION_ORDER" as const, accountId, pairAddress: row.positionKey.slice(prefix.length), lifecycleId: row.lifecycleId!, at: row.createdAt.toISOString() })),
    ];
    return { accountId, history: reconstructLots({ fills, hints, asOf: now.toISOString() }), truncated, fillCount: fills.length };
  }

  /** Environment and origin of the entry fill's observation: marks from another environment never mix in. */
  async markScope(lot: Lot): Promise<{ tradingEnvironment?: string; dataOrigin?: string }> {
    const entry = await this.prisma.fill.findUnique({ where: { id: lot.entryFillId }, select: { observationId: true } });
    if (!entry?.observationId) return {};
    const observation = await this.prisma.marketObservation.findUnique({ where: { id: entry.observationId }, select: { tradingEnvironment: true, dataOrigin: true } });
    return {
      ...(observation?.tradingEnvironment ? { tradingEnvironment: observation.tradingEnvironment } : {}),
      ...(observation?.dataOrigin ? { dataOrigin: observation.dataOrigin } : {}),
    };
  }

  private async enrich(lot: Lot, asOf: string) {
    const scope = await this.markScope(lot);
    const marks = await this.prisma.marketObservation.findMany({
      where: { pairAddress: lot.pairAddress, receivedAt: { gte: new Date(lot.openedAt), lte: new Date(lot.closedAt ?? asOf) }, priceUsd: { not: null }, ...scope },
      select: { receivedAt: true, priceUsd: true },
      orderBy: { receivedAt: "asc" },
      take: MAX_MARKS_PER_LOT,
    });
    const excursion = lotExcursion(
      { ...lot, referencePriceUsd: lot.entryPriceUsd },
      marks.map((row) => ({ pairAddress: lot.pairAddress, receivedAt: row.receivedAt.toISOString(), priceUsd: row.priceUsd?.toString() ?? null })),
      asOf,
    );
    let mark = null;
    if (lot.status === "OPEN") {
      const latest = await this.prisma.marketObservation.findFirst({
        where: { pairAddress: lot.pairAddress, receivedAt: { lte: new Date(asOf) }, priceUsd: { not: null }, ...scope },
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true, priceUsd: true },
      });
      mark = latest ? { priceUsd: latest.priceUsd?.toString() ?? null, receivedAt: latest.receivedAt.toISOString() } : null;
    }
    return { excursion, excursionTruncated: marks.length >= MAX_MARKS_PER_LOT, valuation: lotMark(lot, mark) };
  }

  private summary(lot: Lot) {
    const { events, ...rest } = lot;
    return { ...rest, eventCount: events.length, label: lot.status };
  }

  async listLots(query: { status?: string; pair?: string; limit?: string; offset?: string }) {
    const now = new Date();
    const loaded = await this.load(now);
    const status = query.status === "OPEN" || query.status === "CLOSED" ? query.status : null;
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "25", 10) || 25, 1), 100);
    const offset = Math.max(Number.parseInt(query.offset ?? "0", 10) || 0, 0);
    const filtered = loaded.history.lots
      .filter((lot) => (status ? lot.status === status : true))
      .filter((lot) => (query.pair ? lot.pairAddress === query.pair : true))
      .reverse(); // newest first
    const page = filtered.slice(offset, offset + limit);
    const lots = [];
    for (const lot of page) lots.push({ ...this.summary(lot), ...(await this.enrich(lot, loaded.history.asOf)) });
    return {
      accountId: loaded.accountId,
      asOf: loaded.history.asOf,
      version: loaded.history.version,
      total: filtered.length,
      limit,
      offset,
      fillsRead: loaded.fillCount,
      truncated: loaded.truncated,
      orphanFills: loaded.history.orphanFills.length,
      lots,
    };
  }

  async lotTimeline(lotKey: string) {
    const now = new Date();
    const loaded = await this.load(now);
    const lot = loaded.history.lots.find((item) => item.lotKey === lotKey || (item.lifecycleId !== null && item.lifecycleId === lotKey));
    if (!lot) throw new NotFoundException("LOT_NOT_FOUND");
    const enriched = await this.enrich(lot, loaded.history.asOf);
    const snapshots = await this.prisma.tradeLotSnapshot.findMany({
      where: { accountId: loaded.accountId, entryFillId: lot.entryFillId },
      orderBy: [{ asOf: "asc" }, { id: "asc" }],
    });
    const stored = snapshots.map((row) => {
      const view = row.view as unknown as PointInTimeView;
      const recomputed = viewHash(view);
      const latestStamp = collectTimestamps(view).reduce((max, item) => Math.max(max, Date.parse(item.at)), 0);
      // The view must describe the row it is stored in (review L4): same fill, time, account, lot and phase.
      const identityMatches =
        view.asOf === row.asOf.toISOString() &&
        view.fill?.id === row.fillId &&
        view.accountId === row.accountId &&
        view.entryFillId === row.entryFillId &&
        view.phase === row.phase;
      return {
        id: row.id,
        fillId: row.fillId,
        phase: row.phase,
        eventKind: row.eventKind,
        asOf: row.asOf.toISOString(),
        createdAt: row.createdAt.toISOString(),
        builderVersion: row.builderVersion,
        viewHash: row.viewHash,
        /**
         * HASH_MATCH: the stored view re-hashes to viewHash and its asOf / fill / account / lot / phase equal
         * the row's columns. This detects corruption, not tampering: anyone able to write the row could
         * recompute the hash (the append-only triggers are the tamper control).
         */
        integrity: recomputed !== row.viewHash ? "HASH_MISMATCH" : identityMatches ? "HASH_MATCH" : "IDENTITY_MISMATCH",
        /** No timestamp inside the view is later than its asOf. */
        temporalBoundary: latestStamp <= row.asOf.getTime() ? "OK" : "VIOLATED",
        view,
      };
    });
    const entry = stored.find((row) => row.phase === "ENTRY") ?? null;
    return {
      accountId: loaded.accountId,
      asOf: loaded.history.asOf,
      lot: { ...lot, label: lot.status },
      ...enriched,
      entryView: entry ? entry.view : null,
      entryViewState: entry ? "STORED_SNAPSHOT" : "NOT_RECORDED_YET",
      snapshots: stored,
      timeline: [
        ...lot.events.map((item) => ({ at: item.at, type: `FILL_${item.kind}`, fillId: item.fillId, detail: item })),
        ...stored.map((item) => ({ at: item.asOf, type: `SNAPSHOT_${item.phase}`, fillId: item.fillId, detail: { id: item.id, viewHash: item.viewHash, integrity: item.integrity } })),
      ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.type.localeCompare(right.type)),
    };
  }

  async attribution() {
    const now = new Date();
    const loaded = await this.load(now);
    const [ledger, positions, allocations, coverage] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { accountId: loaded.accountId, type: { in: ["REALIZED_PNL", "FEE"] } },
        select: { id: true, accountId: true, type: true, amountUsd: true, fillId: true, orderId: true },
      }),
      this.prisma.position.findMany({ where: { accountId: loaded.accountId }, select: { pairAddress: true, baseQty: true } }),
      this.prisma.strategyAllocation.findMany({ where: { accountId: loaded.accountId } }),
      this.prisma.tradeLotSnapshot.groupBy({ by: ["phase", "eventKind"], where: { accountId: loaded.accountId }, _count: { _all: true } }),
    ]);
    const reconciliation = reconcileLotsWithLedger({
      accountId: loaded.accountId,
      history: loaded.history,
      ledger: ledger.map((row) => ({ ...row, amountUsd: row.amountUsd.toString() })),
      positions: positions.map((row) => ({ pairAddress: row.pairAddress, baseQty: row.baseQty.toString() })),
      allocations: allocations.map((row) => ({
        strategyInstanceId: row.strategyInstanceId,
        pairAddress: row.pairAddress,
        qty: row.qty.toString(),
        realizedPnlUsd: row.realizedPnlUsd.toString(),
        feesUsd: row.feesUsd.toString(),
        costBasisKnown: row.costBasisKnown,
      })),
    });
    return {
      accountId: loaded.accountId,
      asOf: loaded.history.asOf,
      version: loaded.history.version,
      fillsRead: loaded.fillCount,
      truncated: loaded.truncated,
      /** INCOMPLETE when the fill cap was hit: totals then cover only part of the ledger. */
      status: loaded.truncated ? "INCOMPLETE" : reconciliation.status,
      attribution: summariseLotAttribution(loaded.history.lots),
      reconciliation,
      /** Point-in-time memory rows by phase; SKIPPED rows name the reason fills could not be reconstructed. */
      snapshotCoverage: coverage
        .map((row) => ({ phase: row.phase, eventKind: row.eventKind, count: row._count._all }))
        .sort((left, right) => left.phase.localeCompare(right.phase) || left.eventKind.localeCompare(right.eventKind)),
      rules: [
        "Lot realised P&L uses the ledger's average-cost arithmetic (fees in cost basis, 8 dp, ROUND_HALF_UP)",
        "PNL_FEES_RECONCILED requires |ledger REALIZED_PNL total − lot total| ≤ 1e-8, |FEE rows − fill fees| ≤ 1e-8 and no itemised discrepancy; cash lines are not checked",
        "Instance realised P&L splits each sell fill's ledger-basis P&L by attributed quantity; quantity no allocation owns is shown as 'unresolved'",
        "allocationBasisRealizedPnlUsd mirrors StrategyAllocation (instance's own cost basis) and is compared with the stored rows separately",
      ],
    };
  }
}
