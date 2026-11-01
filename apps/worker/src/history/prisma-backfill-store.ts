import { Prisma, type PrismaClient } from "@odin/shared/db";
import { datasetVersionHash, type BackfillJobState, type BackfillStore, type BarRejection, type HistoricalBar, type HistoricalBarSource, type HistoryInterval, type RawBatchRecord } from "@odin/market-data";

/**
 * ASCEND-01 Prisma store for the backfill runner. Bars are inserted with ON CONFLICT DO NOTHING
 * (idempotent); a conflicting value is recorded as a revision and the stored bar is left untouched
 * (the table is append-only by trigger). Storage quotas refuse inserts rather than evicting evidence.
 */

export type StorageQuota = { maxBarsPerDataset: number; maxTotalBars: number };

export const DEFAULT_STORAGE_QUOTA: StorageQuota = { maxBarsPerDataset: 200_000, maxTotalBars: 5_000_000 };

export class StorageQuotaExceeded extends Error {}

export class PrismaBackfillStore implements BackfillStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly quota: StorageQuota = DEFAULT_STORAGE_QUOTA,
  ) {}

  async saveRawBatch(batch: RawBatchRecord): Promise<void> {
    await this.prisma.historicalRawBatch.create({
      data: {
        jobId: batch.jobId,
        sourceId: batch.sourceId,
        request: batch.request,
        fetchedAt: new Date(batch.fetchedAt),
        payloadHash: batch.payloadHash,
        rowCount: batch.rowCount,
        payload: batch.payload === null ? Prisma.DbNull : (batch.payload as Prisma.InputJsonValue),
      },
    });
  }

  async upsertBars(datasetId: string, bars: Array<HistoricalBar & { hash: string; collectedAt: number }>) {
    if (bars.length === 0) return { inserted: 0, unchanged: 0, revised: 0 };
    const existing = await this.prisma.historicalBar.findMany({
      where: { datasetId, openTime: { in: bars.map((bar) => new Date(bar.openTime)) } },
      select: { openTime: true, hash: true },
    });
    const known = new Map(existing.map((row) => [row.openTime.getTime(), row.hash]));
    const fresh = bars.filter((bar) => !known.has(bar.openTime));
    const revised = bars.filter((bar) => known.has(bar.openTime) && known.get(bar.openTime) !== bar.hash);

    if (fresh.length > 0) {
      const [datasetCount, totalCount] = await Promise.all([
        this.prisma.historicalBar.count({ where: { datasetId } }),
        this.prisma.historicalBar.count(),
      ]);
      if (datasetCount + fresh.length > this.quota.maxBarsPerDataset || totalCount + fresh.length > this.quota.maxTotalBars) {
        throw new StorageQuotaExceeded(`storage quota: dataset ${datasetCount}+${fresh.length}/${this.quota.maxBarsPerDataset}, total ${totalCount}+${fresh.length}/${this.quota.maxTotalBars}`);
      }
    }

    const inserted = fresh.length
      ? (
          await this.prisma.historicalBar.createMany({
            data: fresh.map((bar) => ({
              datasetId,
              openTime: new Date(bar.openTime),
              availableAt: new Date(bar.availableAt),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              extra: bar.extra ? (bar.extra as Prisma.InputJsonValue) : Prisma.DbNull,
              hash: bar.hash,
              collectedAt: new Date(bar.collectedAt),
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;
    if (revised.length > 0) {
      await this.prisma.historicalBarRevision.createMany({
        data: revised.map((bar) => ({
          datasetId,
          openTime: new Date(bar.openTime),
          previousHash: known.get(bar.openTime)!,
          newHash: bar.hash,
          newValues: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
        })),
      });
    }
    if (inserted > 0) await this.refreshDataset(datasetId);
    return { inserted, unchanged: bars.length - fresh.length - revised.length, revised: revised.length };
  }

  async saveRejections(datasetId: string, rejections: BarRejection[]): Promise<void> {
    await this.prisma.historicalBarRejection.createMany({
      data: rejections.map((rejection) => ({ datasetId, openTime: new Date(rejection.openTime), reason: rejection.reason })),
    });
  }

  async saveJob(job: BackfillJobState): Promise<void> {
    await this.prisma.historicalBackfillJob.update({
      where: { id: job.id },
      data: {
        cursor: job.cursor,
        status: job.status,
        attempts: job.attempts,
        rowsImported: job.rowsImported,
        rowsRejected: job.rowsRejected,
        revisionsDetected: job.revisionsDetected,
        lastError: job.lastError,
      },
    });
  }

  /** Recompute the dataset's version hash and coverage bounds from the stored bars. */
  async refreshDataset(datasetId: string): Promise<void> {
    const rows = await this.prisma.historicalBar.findMany({ where: { datasetId }, orderBy: { openTime: "asc" } });
    const bars: HistoricalBar[] = rows.map((row) => ({
      openTime: row.openTime.getTime(),
      availableAt: row.availableAt.getTime(),
      open: row.open.toString(),
      high: row.high.toString(),
      low: row.low.toString(),
      close: row.close.toString(),
      volume: row.volume === null ? null : row.volume.toString(),
    }));
    await this.prisma.historicalDataset.update({
      where: { id: datasetId },
      data: {
        // Hash the stored values as stored (Decimal text), so a re-read reproduces the same version.
        versionHash: rows.length ? datasetVersionHash(bars) : null,
        barCount: rows.length,
        firstOpenTime: rows[0]?.openTime ?? null,
        lastOpenTime: rows.at(-1)?.openTime ?? null,
      },
    });
  }
}

/** Create (or reuse) the dataset and a PENDING job for one bounded window. */
export async function ensureBackfillJob(
  prisma: PrismaClient,
  input: { source: HistoricalBarSource; instrumentKey: string; instrumentKind: string; cohort: string; interval: HistoryInterval; windowStart: Date; windowEnd: Date; maxWindowDays: number },
): Promise<BackfillJobState> {
  const spanDays = (input.windowEnd.getTime() - input.windowStart.getTime()) / 86_400_000;
  if (!(spanDays > 0) || spanDays > input.maxWindowDays) throw new Error(`backfill window must be within (0, ${input.maxWindowDays}] days`);
  const dataset = await prisma.historicalDataset.upsert({
    where: { sourceId_instrumentKey_interval: { sourceId: input.source.id, instrumentKey: input.instrumentKey, interval: input.interval } },
    create: { sourceId: input.source.id, instrumentKey: input.instrumentKey, instrumentKind: input.instrumentKind, cohort: input.cohort, interval: input.interval, licence: input.source.licence },
    update: {},
  });
  const open = await prisma.historicalBackfillJob.findFirst({
    where: { datasetId: dataset.id, windowStart: input.windowStart, windowEnd: input.windowEnd, status: { in: ["PENDING", "RUNNING", "PAUSED"] } },
  });
  const job =
    open ??
    (await prisma.historicalBackfillJob.create({
      data: { datasetId: dataset.id, windowStart: input.windowStart, windowEnd: input.windowEnd, status: "PENDING" },
    }));
  return {
    id: job.id,
    datasetId: dataset.id,
    sourceId: input.source.id,
    instrumentKey: input.instrumentKey,
    interval: input.interval,
    windowStartMs: job.windowStart.getTime(),
    windowEndMs: job.windowEnd.getTime(),
    cursor: job.cursor,
    status: job.status as BackfillJobState["status"],
    attempts: job.attempts,
    rowsImported: job.rowsImported,
    rowsRejected: job.rowsRejected,
    revisionsDetected: job.revisionsDetected,
    lastError: job.lastError,
  };
}
