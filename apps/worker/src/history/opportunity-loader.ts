import { buildOpportunityRows, type CounterfactualSeries, type OpportunityRow } from "@odin/backtest";
import { INTERVAL_MS, type HistoryInterval } from "@odin/market-data";
import type { PrismaClient } from "@odin/shared/db";

/**
 * GENESIS Phase 3 Opportunity History loader: one bounded time window, SELECTs only.
 *
 * Production AgentDecision is large (~1.6M rows / 1.4 GB), so nothing scans it by time. Cycles are picked by
 * `CycleRun.startedAt` (indexed), then funnel events, decisions and intents are read by `cycleId` in small
 * batches (AgentDecision's unique (cycleId, agent, pairAddress) index; the cycleId indexes on the other two),
 * selecting only the columns the dataset needs. Each window and each batch has a hard row cap; above it the
 * loader refuses and asks for a smaller window instead of reading more.
 */

export const MAX_CYCLES_PER_WINDOW = 5_000;
/** Small on purpose: each AgentDecision row carries its input/output JSON. */
export const CYCLE_BATCH = 10;
export const MAX_ROWS_PER_BATCH = 20_000;
const MAX_COUNTERFACTUAL_BARS = 50_000;

type Reader = Pick<PrismaClient, "cycleRun" | "opportunityFunnelEvent" | "agentDecision" | "tradeIntent" | "historicalDataset" | "historicalBar">;

export class WindowTooLarge extends Error {}

export type OpportunityWindowInput = {
  from: Date;
  to: Date;
  accountId?: string | null;
  maxCycleSpanMs?: number;
  counterfactualHorizonsMs?: number[] | null;
};

function capped<T>(rows: T[], cap: number, what: string): T[] {
  if (rows.length > cap) throw new WindowTooLarge(`${what} exceeds ${cap} rows; use a smaller --window-hours`);
  return rows;
}

const dec = (v: { toString(): string } | null) => (v === null ? null : v.toString());

/**
 * Rows for one window, yielded per batch of CYCLE_BATCH cycles so the caller can write and drop each batch:
 * memory is bounded by one batch (AgentDecision input/output JSON included), not by the window.
 */
export async function* iterateOpportunityBatches(prisma: Reader, input: OpportunityWindowInput): AsyncGenerator<OpportunityRow[]> {
  const cycles = capped(
    await prisma.cycleRun.findMany({
      where: { startedAt: { gte: input.from, lt: input.to }, ...(input.accountId ? { accountId: input.accountId } : {}) },
      select: { id: true, startedAt: true, accountId: true, tradingEnvironment: true, dataMode: true },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: MAX_CYCLES_PER_WINDOW + 1,
    }),
    MAX_CYCLES_PER_WINDOW,
    "CycleRun window",
  );
  if (cycles.length === 0) return;

  for (let i = 0; i < cycles.length; i += CYCLE_BATCH) {
    const batch = cycles.slice(i, i + CYCLE_BATCH);
    const ids = batch.map((c) => c.id);
    const [f, d, t] = await Promise.all([
      prisma.opportunityFunnelEvent.findMany({
        where: { cycleId: { in: ids } },
        select: { id: true, accountId: true, cycleId: true, pairAddress: true, instrumentId: true, stage: true, reasonCodes: true, detail: true, createdAt: true },
        take: MAX_ROWS_PER_BATCH + 1,
      }),
      prisma.agentDecision.findMany({
        where: { cycleId: { in: ids }, pairAddress: { not: "" } },
        select: { id: true, cycleId: true, agent: true, modelVersion: true, pairAddress: true, decision: true, confidence: true, reasonCodes: true, input: true, output: true, inputSource: true, createdAt: true, updatedAt: true },
        take: MAX_ROWS_PER_BATCH + 1,
      }),
      prisma.tradeIntent.findMany({
        where: { cycleId: { in: ids } },
        select: {
          id: true, cycleId: true, accountId: true, source: true, strategyInstanceId: true, strategyVersion: true, configHash: true, instrumentId: true, pairAddress: true,
          action: true, side: true, requestedQty: true, sizedQty: true, sizedNotionalUsd: true, observationId: true, observationAt: true, reasonCodes: true, status: true, statusReason: true, createdAt: true, updatedAt: true,
        },
        take: MAX_ROWS_PER_BATCH + 1,
      }),
    ]);
    const funnel = capped(f, MAX_ROWS_PER_BATCH, "OpportunityFunnelEvent batch");
    const decisions = capped(d, MAX_ROWS_PER_BATCH, "AgentDecision batch").map((r) => ({ ...r, confidence: r.confidence.toString() }));
    const intents = capped(t, MAX_ROWS_PER_BATCH, "TradeIntent batch").map((r) => ({
      ...r,
      requestedQty: dec(r.requestedQty),
      sizedQty: dec(r.sizedQty),
      sizedNotionalUsd: dec(r.sizedNotionalUsd),
    }));

    let counterfactual: { series: Map<string, CounterfactualSeries>; horizonsMs: number[] } | undefined;
    const horizons = input.counterfactualHorizonsMs;
    if (horizons && horizons.length > 0) {
      const pairs = [...new Set([...funnel, ...decisions, ...intents].map((r) => r.pairAddress).filter(Boolean))];
      // decisionAt is never earlier than the cycle start and never later than the last cycle start + span,
      // so these bound every reference and exit bar the batch can need.
      const span = input.maxCycleSpanMs ?? DEFAULT_MAX_CYCLE_SPAN_MS;
      const bounds = counterfactualBarBounds(batch[0]!.startedAt.getTime(), batch.at(-1)!.startedAt.getTime() + span, Math.max(...horizons));
      const series = await loadCounterfactualSeries(prisma, pairs, bounds);
      counterfactual = { series, horizonsMs: horizons };
    }

    // A batch holds whole cycles, and rows are keyed by (cycle, pair), so building per batch is exact.
    yield buildOpportunityRows({
      cycles: batch.map((c) => ({ cycleId: c.id, startedAt: c.startedAt, accountId: c.accountId, tradingEnvironment: c.tradingEnvironment, dataMode: c.dataMode })),
      funnel,
      decisions,
      intents,
      options: { maxCycleSpanMs: input.maxCycleSpanMs, counterfactual },
    });
  }
}

/** Collects every batch of one window. For tests and small windows; the CLI streams batches instead. */
export async function loadOpportunityWindow(prisma: Reader, input: OpportunityWindowInput): Promise<OpportunityRow[]> {
  const rows: OpportunityRow[] = [];
  for await (const batch of iterateOpportunityBatches(prisma, input)) rows.push(...batch);
  return rows;
}

const DEFAULT_MAX_CYCLE_SPAN_MS = 600_000;

/** availableAt range of bars a batch needs: reference bars before its earliest decision, exits up to latest + horizon. */
export function counterfactualBarBounds(earliestDecisionMs: number, latestDecisionMs: number, maxHorizonMs: number): { fromMs: number; untilMs: number } {
  return { fromMs: earliestDecisionMs, untilMs: latestDecisionMs + maxHorizonMs };
}

/**
 * Warehouse bars for pairs that have a dataset (GeckoTerminal instrumentKey = pool address). The finest
 * interval wins. Bars are read from three bars before the earliest decision to one bar past the latest exit
 * target, bounded by MAX_COUNTERFACTUAL_BARS. The dataset's own last bar decides BEYOND_DATA. HYPOTHETICAL only.
 */
async function loadCounterfactualSeries(prisma: Reader, pairs: string[], bounds: { fromMs: number; untilMs: number }): Promise<Map<string, CounterfactualSeries>> {
  const out = new Map<string, CounterfactualSeries>();
  for (let i = 0; i < pairs.length; i += 200) {
    const datasets = await prisma.historicalDataset.findMany({
      where: { instrumentKey: { in: pairs.slice(i, i + 200) } },
      select: { id: true, instrumentKey: true, interval: true, lastOpenTime: true },
      // Deterministic tie-break when several datasets share the finest interval: first by sourceId, then id.
      orderBy: [{ interval: "asc" }, { sourceId: "asc" }, { id: "asc" }],
    });
    const finest = new Map<string, { id: string; interval: string; intervalMs: number; lastOpenTime: Date | null }>();
    for (const d of datasets) {
      const ms = INTERVAL_MS[d.interval as HistoryInterval];
      if (!ms) continue;
      const current = finest.get(d.instrumentKey);
      if (!current || ms < current.intervalMs) finest.set(d.instrumentKey, { id: d.id, interval: d.interval, intervalMs: ms, lastOpenTime: d.lastOpenTime });
    }
    for (const [pair, d] of finest) {
      const bars = await prisma.historicalBar.findMany({
        // Back three bars for the reference close; forward one bar past the latest exit target.
        where: { datasetId: d.id, availableAt: { gte: new Date(bounds.fromMs - 3 * d.intervalMs), lte: new Date(bounds.untilMs + d.intervalMs) } },
        select: { openTime: true, availableAt: true, close: true },
        orderBy: { availableAt: "asc" },
        take: MAX_COUNTERFACTUAL_BARS + 1,
      });
      capped(bars, MAX_COUNTERFACTUAL_BARS, `HistoricalBar series for ${pair}`);
      out.set(pair, {
        datasetId: d.id,
        interval: d.interval,
        intervalMs: d.intervalMs,
        dataEndAvailableAt: d.lastOpenTime ? d.lastOpenTime.getTime() + d.intervalMs : null,
        bars: bars.map((b) => ({ openTime: b.openTime.getTime(), availableAt: b.availableAt.getTime(), close: b.close.toString() })),
      });
    }
  }
  return out;
}
