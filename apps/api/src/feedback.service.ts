import { Injectable, NotFoundException } from "@nestjs/common";
import {
  aggregateFeedback,
  closedLotsNewestFirst,
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

/** Bounded query sizes (review: the summary is authenticated but not admin-gated, so keep it cheap). */
export const FEEDBACK_SUMMARY_DEFAULT_LIMIT = 50;
export const FEEDBACK_SUMMARY_MAX_LIMIT = 100;
export const HYPOTHETICAL_DEFAULT_LIMIT = 25;
export const HYPOTHETICAL_MAX_LIMIT = 100;
/** Summary results are reused for this long per (account, limit). */
export const FEEDBACK_SUMMARY_CACHE_TTL_MS = 30_000;
const SUMMARY_CACHE_MAX_ENTRIES = 32;
/** Mark rows read per (pair, environment, origin) group in one query. */
export const MAX_MARKS_PER_GROUP = 20_000;
const MAX_BARS_PER_HYPOTHETICAL = 2_000;

export function boundedLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, 1), max);
}

const str = (value: { toString(): string } | null | undefined): string | null => (value == null ? null : value.toString());

type MarkScope = { tradingEnvironment?: string; dataOrigin?: string };
type SummaryResult = Awaited<ReturnType<FeedbackService["computeSummary"]>>;

/**
 * GENESIS Phase 7 read-only feedback API. Per-lot feedback is built from the lots TradeLotsService
 * rebuilds, the **stored** ENTRY snapshots (never rebuilt from current rows) and marks. Hypothetical
 * non-trades come from rejected OpportunityFunnelEvent rows and are reported separately, never mixed
 * with observed fills. Reads only; never writes any table, never touches engine config or promotion.
 */
@Injectable()
export class FeedbackService {
  private readonly summaryCache = new Map<string, { at: number; value: SummaryResult }>();

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

  /**
   * Mark scope per lot, batched: the entry fill's observation environment and origin (same rule as
   * TradeLotsService.markScope), with two IN queries for all lots instead of two lookups per lot.
   */
  private async markScopes(lots: readonly Lot[]): Promise<Map<string, MarkScope>> {
    const fills = await this.prisma.fill.findMany({ where: { id: { in: lots.map((lot) => lot.entryFillId) } }, select: { id: true, observationId: true } });
    const observationIds = [...new Set(fills.map((row) => row.observationId).filter((id): id is string => Boolean(id)))];
    const observations = observationIds.length
      ? await this.prisma.marketObservation.findMany({ where: { id: { in: observationIds } }, select: { id: true, tradingEnvironment: true, dataOrigin: true } })
      : [];
    const byObservation = new Map(observations.map((row) => [row.id, row]));
    const byFill = new Map(fills.map((row) => [row.id, row.observationId]));
    const out = new Map<string, MarkScope>();
    for (const lot of lots) {
      const observation = byObservation.get(byFill.get(lot.entryFillId) ?? "");
      out.set(lot.lotKey, {
        ...(observation?.tradingEnvironment ? { tradingEnvironment: observation.tradingEnvironment } : {}),
        ...(observation?.dataOrigin ? { dataOrigin: observation.dataOrigin } : {}),
      });
    }
    return out;
  }

  /**
   * Marks for many lots: one query per (pair, environment, origin) over the union of the lots' windows
   * [openedAt, closedAt + horizon] (capped at asOf). A lot is marksTruncated when its group hit the row
   * cap before the end of the lot's window.
   */
  private async marksFor(lots: readonly Lot[], asOf: string): Promise<Map<string, { marks: MarkObservation[]; truncated: boolean }>> {
    const scopes = await this.markScopes(lots);
    const asOfMs = Date.parse(asOf);
    const windowEnd = (lot: Lot) => (lot.closedAt ? Math.min(Date.parse(lot.closedAt) + FEEDBACK_RULES.postExitHorizonSeconds * 1000, asOfMs) : asOfMs);
    const groups = new Map<string, { pairAddress: string; scope: MarkScope; lots: Lot[] }>();
    for (const lot of lots) {
      const scope = scopes.get(lot.lotKey) ?? {};
      const key = `${lot.pairAddress}|${scope.tradingEnvironment ?? ""}|${scope.dataOrigin ?? ""}`;
      const group = groups.get(key) ?? { pairAddress: lot.pairAddress, scope, lots: [] };
      group.lots.push(lot);
      groups.set(key, group);
    }
    const out = new Map<string, { marks: MarkObservation[]; truncated: boolean }>();
    for (const group of groups.values()) {
      const start = Math.min(...group.lots.map((lot) => Date.parse(lot.openedAt)));
      const end = Math.max(...group.lots.map(windowEnd));
      const rows = await this.prisma.marketObservation.findMany({
        where: { pairAddress: group.pairAddress, receivedAt: { gte: new Date(start), lte: new Date(end) }, priceUsd: { not: null }, ...group.scope },
        select: { receivedAt: true, priceUsd: true },
        orderBy: { receivedAt: "asc" },
        take: MAX_MARKS_PER_GROUP + 1,
      });
      const truncated = rows.length > MAX_MARKS_PER_GROUP;
      const kept = (truncated ? rows.slice(0, MAX_MARKS_PER_GROUP) : rows).map((row) => ({
        at: row.receivedAt.getTime(),
        mark: { pairAddress: group.pairAddress, receivedAt: row.receivedAt.toISOString(), priceUsd: str(row.priceUsd) },
      }));
      const lastRead = kept.length ? kept[kept.length - 1]!.at : start;
      for (const lot of group.lots) {
        const from = Date.parse(lot.openedAt);
        const to = windowEnd(lot);
        out.set(lot.lotKey, { marks: kept.filter((row) => row.at >= from && row.at <= to).map((row) => row.mark), truncated: truncated && lastRead < to });
      }
    }
    return out;
  }

  private async feedbackFor(accountId: string, lots: Lot[], asOf: string): Promise<LotFeedback[]> {
    const [snapshots, marks] = await Promise.all([this.entrySnapshots(accountId, lots.map((lot) => lot.entryFillId)), this.marksFor(lots, asOf)]);
    return lots.map((lot) => {
      const found = marks.get(lot.lotKey) ?? { marks: [], truncated: false };
      return lotFeedback({ lot, entrySnapshot: snapshots.get(lot.entryFillId) ?? null, marks: found.marks, asOf, marksTruncated: found.truncated });
    });
  }

  /**
   * Aggregated feedback over the `limit` most recently **closed** lots of the active account (observed
   * fills only). Cached per (account, limit) for FEEDBACK_SUMMARY_CACHE_TTL_MS.
   */
  async summary(query: { limit?: string }) {
    const limit = boundedLimit(query.limit, FEEDBACK_SUMMARY_DEFAULT_LIMIT, FEEDBACK_SUMMARY_MAX_LIMIT);
    const accountId = await this.terminal.activeAccountId();
    const key = `${accountId}|${limit}`;
    const now = Date.now();
    const cached = this.summaryCache.get(key);
    if (cached && now - cached.at < FEEDBACK_SUMMARY_CACHE_TTL_MS) {
      return { ...cached.value, cache: { hit: true, ttlSeconds: FEEDBACK_SUMMARY_CACHE_TTL_MS / 1000, computedAt: new Date(cached.at).toISOString() } };
    }
    const value = await this.computeSummary(limit);
    for (const [entryKey, entry] of this.summaryCache) if (now - entry.at >= FEEDBACK_SUMMARY_CACHE_TTL_MS) this.summaryCache.delete(entryKey);
    if (this.summaryCache.size >= SUMMARY_CACHE_MAX_ENTRIES) this.summaryCache.delete(this.summaryCache.keys().next().value!);
    this.summaryCache.set(key, { at: now, value });
    return { ...value, cache: { hit: false, ttlSeconds: FEEDBACK_SUMMARY_CACHE_TTL_MS / 1000, computedAt: new Date(now).toISOString() } };
  }

  private async computeSummary(limit: number) {
    const loaded = await this.lots.load(new Date());
    const asOf = loaded.history.asOf;
    const closed = closedLotsNewestFirst(loaded.history.lots);
    const page = closed.slice(0, limit);
    const rows = await this.feedbackFor(loaded.accountId, page, asOf);
    return {
      accountId: loaded.accountId,
      asOf,
      version: FEEDBACK_VERSION,
      source: "OBSERVED_FILL" as const,
      limit,
      order: "CLOSED_AT_DESC" as const,
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
      // Latest observation known at the decision: received at or before it, and produced at or before it
      // when the provider time is known. Filtered in the query, so a later-produced row cannot hide an
      // earlier valid one. Staleness is judged by counterfactualOutcome (maxPreDecisionAgeSeconds).
      const feature = await this.prisma.marketObservation.findFirst({
        where: {
          pairAddress: event.pairAddress,
          receivedAt: { lte: decidedAt },
          priceUsd: { not: null },
          OR: [{ eventTime: null }, { eventTime: { lte: decidedAt } }],
        },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
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
    for (const outcome of outcomes) {
      const key = outcome.notEvaluatedReason ? `${outcome.status}:${outcome.notEvaluatedReason}` : outcome.status;
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
    return {
      accountId,
      asOf: now.toISOString(),
      version: FEEDBACK_VERSION,
      source: "HYPOTHETICAL" as const,
      note: "Counterfactual outcomes of rejected opportunities, entered at the last pre-decision mark (not the next mark). Never observed fills; never aggregated with lot feedback.",
      limit,
      policy,
      byStatus,
      outcomes,
    };
  }
}
