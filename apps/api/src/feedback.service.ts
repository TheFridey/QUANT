import { Injectable, NotFoundException } from "@nestjs/common";
import {
  aggregateFeedback,
  counterfactualOutcome,
  DEFAULT_COUNTERFACTUAL_POLICY,
  FEEDBACK_RULES,
  FEEDBACK_VERSION,
  feedbackRules,
  lotFeedback,
  REJECTION_STAGES,
  type HypotheticalOutcome,
  type Lot,
  type LotFeedback,
  type MarkObservation,
  type PitObservation,
  type StoredEntrySnapshot,
} from "@odin/analytics";
import { PrismaClient } from "@odin/shared/db";
import { TerminalService } from "./terminal.service.js";
import { TradeLotsService } from "./trade-lots.service.js";

/** Bounded query sizes. */
export const FEEDBACK_SUMMARY_DEFAULT_LIMIT = 100;
export const FEEDBACK_SUMMARY_MAX_LIMIT = 500;
export const HYPOTHETICAL_DEFAULT_LIMIT = 25;
export const HYPOTHETICAL_MAX_LIMIT = 100;
const MAX_MARKS_PER_LOT = 5_000;
const MAX_BARS_PER_HYPOTHETICAL = 2_000;

export function boundedLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, 1), max);
}

const str = (value: { toString(): string } | null | undefined): string | null => (value == null ? null : value.toString());

/**
 * GENESIS Phase 7 read-only feedback API. Per-lot feedback is built from the lots TradeLotsService
 * rebuilds, the **stored** ENTRY snapshots (never rebuilt from current rows) and marks. Hypothetical
 * non-trades come from rejected OpportunityFunnelEvent rows and are reported separately, never mixed
 * with observed fills. Reads only; never writes any table, never touches engine config or promotion.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly terminal: TerminalService,
    private readonly lots: TradeLotsService,
  ) {}

  private async entrySnapshots(accountId: string, entryFillIds: string[]): Promise<Map<string, StoredEntrySnapshot>> {
    if (entryFillIds.length === 0) return new Map();
    const rows = await this.prisma.tradeLotSnapshot.findMany({
      where: { accountId, phase: "ENTRY", fillId: { in: entryFillIds } },
      select: { id: true, accountId: true, fillId: true, entryFillId: true, phase: true, asOf: true, viewHash: true, view: true },
    });
    return new Map(rows.map((row) => [row.fillId, { ...row, asOf: row.asOf.toISOString(), view: row.view as unknown }]));
  }

  /** Marks over [openedAt, closedAt + horizon] (capped at asOf), in the entry fill's environment and origin. */
  private async marks(lot: Lot, asOf: string): Promise<{ marks: MarkObservation[]; truncated: boolean }> {
    const scope = await this.lots.markScope(lot);
    const end = lot.closedAt ? Math.min(Date.parse(lot.closedAt) + FEEDBACK_RULES.postExitHorizonSeconds * 1000, Date.parse(asOf)) : Date.parse(asOf);
    const rows = await this.prisma.marketObservation.findMany({
      where: { pairAddress: lot.pairAddress, receivedAt: { gte: new Date(lot.openedAt), lte: new Date(end) }, priceUsd: { not: null }, ...scope },
      select: { receivedAt: true, priceUsd: true },
      orderBy: { receivedAt: "asc" },
      take: MAX_MARKS_PER_LOT + 1,
    });
    const truncated = rows.length > MAX_MARKS_PER_LOT;
    return {
      marks: (truncated ? rows.slice(0, MAX_MARKS_PER_LOT) : rows).map((row) => ({ pairAddress: lot.pairAddress, receivedAt: row.receivedAt.toISOString(), priceUsd: str(row.priceUsd) })),
      truncated,
    };
  }

  private async feedbackFor(accountId: string, lots: Lot[], asOf: string): Promise<LotFeedback[]> {
    const snapshots = await this.entrySnapshots(accountId, lots.map((lot) => lot.entryFillId));
    const out: LotFeedback[] = [];
    for (const lot of lots) {
      const { marks, truncated } = await this.marks(lot, asOf);
      out.push(lotFeedback({ lot, entrySnapshot: snapshots.get(lot.entryFillId) ?? null, marks, asOf, marksTruncated: truncated }));
    }
    return out;
  }

  /** Aggregated feedback over the newest `limit` CLOSED lots of the active account (observed fills only). */
  async summary(query: { limit?: string }) {
    const limit = boundedLimit(query.limit, FEEDBACK_SUMMARY_DEFAULT_LIMIT, FEEDBACK_SUMMARY_MAX_LIMIT);
    const loaded = await this.lots.load(new Date());
    const asOf = loaded.history.asOf;
    const closed = loaded.history.lots.filter((lot) => lot.status === "CLOSED").reverse(); // newest first
    const page = closed.slice(0, limit);
    const rows = await this.feedbackFor(loaded.accountId, page, asOf);
    return {
      accountId: loaded.accountId,
      asOf,
      version: FEEDBACK_VERSION,
      source: "OBSERVED_FILL" as const,
      limit,
      closedLotsTotal: closed.length,
      lotsEvaluated: page.length,
      openLotsExcluded: loaded.history.lots.length - closed.length,
      /** True when older closed lots were left out by the limit, or the fill read cap was hit. */
      truncated: closed.length > page.length || loaded.truncated,
      fillsTruncated: loaded.truncated,
      aggregate: aggregateFeedback(rows),
      lots: rows.map((row) => ({
        lotKey: row.lotKey,
        pairAddress: row.pairAddress,
        closedAt: row.retrospective!.closedAt,
        netPnlUsd: row.retrospective!.realised.netPnlUsd,
        primary: row.retrospective!.classification.primary,
        decisionRecordState: row.decisionRecordState,
        marksTruncated: row.marksTruncated,
      })),
    };
  }

  /** One lot: what QUANT knew at entry (decisionRecord) vs the retrospective outcome. */
  async lot(lotKey: string) {
    const loaded = await this.lots.load(new Date());
    const lot = loaded.history.lots.find((item) => item.lotKey === lotKey || (item.lifecycleId !== null && item.lifecycleId === lotKey));
    if (!lot) throw new NotFoundException("LOT_NOT_FOUND");
    const [row] = await this.feedbackFor(loaded.accountId, [lot], loaded.history.asOf);
    return {
      asOf: loaded.history.asOf,
      version: FEEDBACK_VERSION,
      ...row!,
      separation: {
        decisionRecord: "Stored ENTRY snapshot only; every timestamp at or before decisionRecord.asOf (the entry fill).",
        retrospective: "Outcome and hindsight: inTrade marks within the holding window, postExit marks after the exit only.",
      },
      rules: feedbackRules(),
    };
  }

  /** Counterfactual outcomes of the newest rejected opportunities. HYPOTHETICAL only; never mixed with fills. */
  async hypothetical(query: { limit?: string }) {
    const limit = boundedLimit(query.limit, HYPOTHETICAL_DEFAULT_LIMIT, HYPOTHETICAL_MAX_LIMIT);
    const accountId = await this.terminal.activeAccountId();
    const now = new Date();
    const events = await this.prisma.opportunityFunnelEvent.findMany({
      where: { accountId, stage: { in: [...REJECTION_STAGES] }, createdAt: { lte: now } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    const policy = DEFAULT_COUNTERFACTUAL_POLICY;
    const outcomes: HypotheticalOutcome[] = [];
    for (const event of events) {
      const decidedAt = event.createdAt;
      const feature = await this.prisma.marketObservation.findFirst({
        where: { pairAddress: event.pairAddress, receivedAt: { lte: decidedAt }, priceUsd: { not: null } },
        orderBy: { receivedAt: "desc" },
      });
      const features: PitObservation[] = feature
        ? [
            {
              id: feature.id,
              pairAddress: feature.pairAddress,
              receivedAt: feature.receivedAt.toISOString(),
              eventTime: feature.eventTime?.toISOString() ?? null,
              freshness: feature.freshness,
              dataOrigin: feature.dataOrigin,
              priceUsd: str(feature.priceUsd),
              liquidityUsd: str(feature.liquidityUsd),
              volume24hUsd: str(feature.volume24hUsd),
              priceChangeM5: str(feature.priceChangeM5),
              priceChangeH1: str(feature.priceChangeH1),
              pairCreatedAt: feature.pairCreatedAt?.toISOString() ?? null,
            },
          ]
        : [];
      const end = new Date(Math.min(decidedAt.getTime() + policy.horizonSeconds * 1000, now.getTime()));
      const bars = feature
        ? await this.prisma.marketObservation.findMany({
            where: {
              pairAddress: event.pairAddress,
              receivedAt: { gt: decidedAt, lte: end },
              priceUsd: { not: null },
              // Same environment and origin as the pre-decision observation: never mix fixture into paper.
              ...(feature.tradingEnvironment ? { tradingEnvironment: feature.tradingEnvironment } : {}),
              ...(feature.dataOrigin ? { dataOrigin: feature.dataOrigin } : {}),
            },
            select: { receivedAt: true, priceUsd: true },
            orderBy: { receivedAt: "asc" },
            take: MAX_BARS_PER_HYPOTHETICAL,
          })
        : [];
      outcomes.push(
        counterfactualOutcome({
          opportunity: {
            id: event.id,
            accountId: event.accountId,
            cycleId: event.cycleId,
            pairAddress: event.pairAddress,
            stage: event.stage,
            reasonCodes: event.reasonCodes,
            createdAt: decidedAt.toISOString(),
          },
          features,
          bars: bars.map((row) => ({ pairAddress: event.pairAddress, receivedAt: row.receivedAt.toISOString(), priceUsd: str(row.priceUsd) })),
          asOf: now.toISOString(),
          policy,
        }),
      );
    }
    const byStatus: Record<string, number> = {};
    for (const outcome of outcomes) byStatus[outcome.status] = (byStatus[outcome.status] ?? 0) + 1;
    return {
      accountId,
      asOf: now.toISOString(),
      version: FEEDBACK_VERSION,
      source: "HYPOTHETICAL" as const,
      note: "Counterfactual outcomes of rejected opportunities. Never observed fills; never aggregated with lot feedback.",
      limit,
      policy,
      byStatus,
      outcomes,
    };
  }
}
