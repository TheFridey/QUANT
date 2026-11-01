import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackfill, type HistoricalBarSource, type SourcePage } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { ensureBackfillJob, PrismaBackfillStore, StorageQuotaExceeded } from "./prisma-backfill-store.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);

class PagedSource implements HistoricalBarSource {
  readonly id = "it_source";
  readonly licence = { provider: "integration", terms: "test", attribution: null, redistribution: "NO" as const };
  readonly maxRequestsPerMinute = 6000;
  constructor(private readonly pages: SourcePage[], private i = 0) {}
  async fetchPage(): Promise<SourcePage> {
    return this.pages[Math.min(this.i++, this.pages.length - 1)]!;
  }
}
const bar = (i: number, close = 1 + i / 100) => ({ openTime: T0 + i * H, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10 });
const page = (bars: ReturnType<typeof bar>[], nextCursor: string | null): SourcePage => ({ ok: true, bars, nextCursor, requestDescription: "it", payload: { n: bars.length } });

/** ASCEND-01: the warehouse is idempotent, resumable, append-only and bounded. */
describe.skipIf(!enabled)("historical warehouse (Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641101)`;
    // TRUNCATE does not fire the row-level immutability triggers.
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "HistoricalBar", "HistoricalBarRevision", "HistoricalBarRejection", "HistoricalRawBatch", "HistoricalBackfillJob", "HistoricalDataset" CASCADE`);
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641101)`;
    await prisma.$disconnect();
  });

  const args = (source: HistoricalBarSource) => ({ source, instrumentKey: "POOLIT", instrumentKind: "SOLANA_POOL", cohort: "SPECULATIVE_SOLANA", interval: "1h" as const, windowStart: new Date(T0), windowEnd: new Date(T0 + 100 * H), maxWindowDays: 30 });

  it("imports across an interruption, records revisions, and stamps a reproducible version", async () => {
    const store = new PrismaBackfillStore(prisma);
    const first = new PagedSource([page([bar(5), bar(6)], "c1")]);
    const job = await ensureBackfillJob(prisma, args(first));
    const paused = await runBackfill({ job, source: first, store, options: { maxRequests: 1, sleep: async () => {} } });
    expect(paused.job.status).toBe("PAUSED");

    // Same arguments resume the same job from its checkpoint.
    const second = new PagedSource([page([bar(3), bar(4), bar(5, 9)], null)]);
    const resumed = await ensureBackfillJob(prisma, args(second));
    expect(resumed.id).toBe(job.id);
    expect(resumed.cursor).toBe("c1");
    const done = await runBackfill({ job: resumed, source: second, store, options: { maxRequests: 5, sleep: async () => {} } });
    expect(done.job).toMatchObject({ status: "COMPLETED", rowsImported: 4, revisionsDetected: 1 });

    const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: job.datasetId } });
    expect(dataset.barCount).toBe(4);
    const version = dataset.versionHash;
    await store.refreshDataset(job.datasetId);
    expect((await prisma.historicalDataset.findUniqueOrThrow({ where: { id: job.datasetId } })).versionHash).toBe(version);
    const original = await prisma.historicalBar.findUniqueOrThrow({ where: { datasetId_openTime: { datasetId: job.datasetId, openTime: new Date(T0 + 5 * H) } } });
    expect(original.close.toString()).toBe("1.05");
  });

  it("refuses to update or delete stored bars and raw batches", async () => {
    await expect(prisma.historicalBar.updateMany({ data: { close: "2" } })).rejects.toThrow(/append-only/);
    await expect(prisma.historicalRawBatch.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it("refuses inserts beyond the storage quota rather than evicting evidence", async () => {
    const source = new PagedSource([page([bar(50), bar(51)], null)]);
    const job = await ensureBackfillJob(prisma, { ...args(source), instrumentKey: "POOLQUOTA" });
    const store = new PrismaBackfillStore(prisma, { maxBarsPerDataset: 1, maxTotalBars: 1_000 });
    await expect(runBackfill({ job, source, store, options: { maxRequests: 1, sleep: async () => {} } })).rejects.toBeInstanceOf(StorageQuotaExceeded);
  });
});
