import type { PrismaClient } from "@odin/shared/db";
import { datasetQualityReport, survivorshipSummary, type DatasetQualityInput, type DatasetQualityReport, type SurvivorshipSummary } from "./quality.js";

/**
 * GENESIS Phase 3: read-only loader for the dataset quality report, shared by the worker CLI and the API.
 * SELECTs only; bars are bounded by the ASCEND-01 storage quota (200k per dataset), and only the columns
 * the report needs are read.
 */

export const MAX_QUALITY_BARS = 200_000;

type Reader = Pick<PrismaClient, "historicalDataset" | "historicalBar" | "historicalBarRevision" | "historicalBarRejection">;

export async function loadDatasetQualityInput(prisma: Reader, datasetId: string, asOf: Date, options?: DatasetQualityInput["options"]): Promise<DatasetQualityInput | null> {
  const dataset = await prisma.historicalDataset.findUnique({
    where: { id: datasetId },
    select: { id: true, sourceId: true, instrumentKey: true, instrumentKind: true, cohort: true, interval: true, versionHash: true, lastOpenTime: true },
  });
  if (!dataset) return null;
  // A window is pushed into the query (openTime bounds) rather than filtered in memory.
  const window = options?.window;
  const openTime = window ? { gte: new Date(window.fromOpenTime), lte: new Date(window.toOpenTime) } : undefined;
  const scoped = openTime ? { datasetId, openTime } : { datasetId };
  const [rows, revisions, rejections] = await Promise.all([
    prisma.historicalBar.findMany({
      where: scoped,
      select: { openTime: true, availableAt: true, open: true, high: true, low: true, close: true, volume: true },
      orderBy: { openTime: "asc" },
      take: MAX_QUALITY_BARS + 1,
    }),
    prisma.historicalBarRevision.count({ where: scoped }),
    prisma.historicalBarRejection.groupBy({ by: ["reason"], where: scoped, _count: { _all: true } }),
  ]);
  if (rows.length > MAX_QUALITY_BARS) throw new Error(`dataset ${datasetId} has more than ${MAX_QUALITY_BARS} bars; refusing an unbounded read`);
  const { lastOpenTime, ...meta } = dataset;
  return {
    dataset: { ...meta, lastOpenTime: lastOpenTime?.getTime() ?? null },
    bars: rows.map((row) => ({
      openTime: row.openTime.getTime(),
      availableAt: row.availableAt.getTime(),
      // Decimal text as stored, so the content hash reproduces HistoricalDataset.versionHash.
      open: row.open.toString(),
      high: row.high.toString(),
      low: row.low.toString(),
      close: row.close.toString(),
      volume: row.volume === null ? null : row.volume.toString(),
    })),
    revisions,
    rejectionsByReason: Object.fromEntries(rejections.map((r) => [r.reason, r._count._all])),
    asOf: asOf.getTime(),
    options,
  };
}

export async function datasetQuality(prisma: Reader, datasetId: string, asOf: Date, options?: DatasetQualityInput["options"]): Promise<DatasetQualityReport | null> {
  const input = await loadDatasetQualityInput(prisma, datasetId, asOf, options);
  return input ? datasetQualityReport(input) : null;
}

export type DatasetListing = {
  datasets: Array<{ id: string; sourceId: string; instrumentKey: string; instrumentKind: string; cohort: string; interval: string; barCount: number; firstOpenTime: string | null; lastOpenTime: string | null; versionHash: string | null }>;
  survivorship: SurvivorshipSummary;
};

/** Dataset metadata plus the universe survivorship disclosure; reads no bars. */
export async function listDatasetsForQuality(prisma: Pick<PrismaClient, "historicalDataset">, asOf: Date): Promise<DatasetListing> {
  const rows = await prisma.historicalDataset.findMany({
    select: { id: true, sourceId: true, instrumentKey: true, instrumentKind: true, cohort: true, interval: true, barCount: true, firstOpenTime: true, lastOpenTime: true, versionHash: true },
    orderBy: [{ cohort: "asc" }, { instrumentKey: "asc" }, { interval: "asc" }],
    take: 1_000,
  });
  return {
    datasets: rows.map((r) => ({ ...r, firstOpenTime: r.firstOpenTime?.toISOString() ?? null, lastOpenTime: r.lastOpenTime?.toISOString() ?? null })),
    survivorship: survivorshipSummary(rows.map((r) => ({ cohort: r.cohort, interval: r.interval, lastOpenTime: r.lastOpenTime?.getTime() ?? null })), asOf.getTime()),
  };
}
