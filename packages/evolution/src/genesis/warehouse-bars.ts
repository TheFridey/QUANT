import type { ResearchBar } from "@odin/backtest/ml2";
import type { PrismaClient } from "@odin/shared/db";
import type { ShadowBarSource } from "./shadow.js";

/**
 * Shadow bar source over the ASCEND-01 warehouse (HistoricalDataset / HistoricalBar), read only. Returns
 * only bars whose `availableAt` (bar close) is at or before `asOf`. Interval names mirror INTERVAL_MS in
 * packages/market-data/src/history/sources.ts (copied, not imported, so shadow code has no import path into
 * market-data). With several sources for one instrument and interval, the dataset with the latest bar wins
 * (ties by id), so the choice is deterministic.
 */
export const WAREHOUSE_INTERVALS: Readonly<Record<number, string>> = {
  60_000: "1m",
  300_000: "5m",
  900_000: "15m",
  3_600_000: "1h",
  14_400_000: "4h",
  86_400_000: "1d",
};

type BarRow = { openTime: Date; open: unknown; high: unknown; low: unknown; close: unknown; volume: unknown };

function toBar(row: BarRow): ResearchBar {
  return { t: row.openTime.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) };
}

export function warehouseBarSource(prisma: PrismaClient): ShadowBarSource {
  const datasetFor = async (instrumentKey: string, barMs: number) => {
    const interval = WAREHOUSE_INTERVALS[barMs];
    if (!interval) return null;
    return prisma.historicalDataset.findFirst({ where: { instrumentKey, interval }, orderBy: [{ lastOpenTime: { sort: "desc", nulls: "last" } }, { id: "asc" }], select: { id: true } });
  };
  return {
    async latestBars(instrumentKey, barMs, asOf, limit) {
      const dataset = await datasetFor(instrumentKey, barMs);
      if (!dataset) return [];
      const rows = await prisma.historicalBar.findMany({
        where: { datasetId: dataset.id, availableAt: { lte: asOf } },
        orderBy: { openTime: "desc" },
        take: limit,
        select: { openTime: true, open: true, high: true, low: true, close: true, volume: true },
      });
      return rows.reverse().map(toBar);
    },
    async barsBetween(instrumentKey, barMs, fromOpen, toOpen, asOf) {
      const dataset = await datasetFor(instrumentKey, barMs);
      if (!dataset) return [];
      const rows = await prisma.historicalBar.findMany({
        where: { datasetId: dataset.id, openTime: { gte: fromOpen, lte: toOpen }, availableAt: { lte: asOf } },
        orderBy: { openTime: "asc" },
        select: { openTime: true, open: true, high: true, low: true, close: true, volume: true },
      });
      return rows.map(toBar);
    },
  };
}
