import { createHash } from "node:crypto";
import { barHash, normaliseBars, type BarRejection, type HistoricalBar } from "./integrity.js";
import { INTERVAL_MS, type HistoricalBarSource, type HistoryInterval } from "./sources.js";

/**
 * ASCEND-01 durable backfill. One job covers one (source, instrument, interval, window). The runner is
 * resumable: after every page it writes the raw batch, upserts normalised bars idempotently, and moves the
 * checkpoint, all through the injected store. A restart continues from the stored cursor. Requests are
 * bounded per run and rate-limited per source; nothing is fetched outside the job's window.
 */

export type BackfillJobState = {
  id: string;
  datasetId: string;
  sourceId: string;
  instrumentKey: string;
  interval: HistoryInterval;
  windowStartMs: number;
  windowEndMs: number;
  cursor: string | null;
  status: "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";
  attempts: number;
  rowsImported: number;
  rowsRejected: number;
  revisionsDetected: number;
  lastError: string | null;
};

export type RawBatchRecord = {
  jobId: string;
  sourceId: string;
  request: string;
  fetchedAt: number;
  payloadHash: string;
  rowCount: number;
  payload: unknown;
};

export interface BackfillStore {
  saveRawBatch(batch: RawBatchRecord): Promise<void>;
  /**
   * Insert bars that are new; for an existing (dataset, openTime) with a different hash, keep the original
   * and record a revision. Returns counts. Must be idempotent.
   */
  upsertBars(datasetId: string, bars: Array<HistoricalBar & { hash: string; collectedAt: number }>): Promise<{ inserted: number; unchanged: number; revised: number }>;
  saveRejections(datasetId: string, rejections: BarRejection[]): Promise<void>;
  saveJob(job: BackfillJobState): Promise<void>;
}

export type BackfillRunOptions = {
  /** Hard cap on provider requests in this run. */
  maxRequests: number;
  /** Consecutive failures before the job is marked FAILED. */
  maxAttempts?: number;
  /** Raw payloads larger than this are stored as hash + row count only. */
  maxRawPayloadBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Abort signal checked between pages (worker shutdown, operator pause). */
  shouldStop?: () => boolean;
};

export type BackfillRunResult = { job: BackfillJobState; requests: number; stoppedBy: "COMPLETED" | "REQUEST_BUDGET" | "FAILED" | "STOPPED" };

export async function runBackfill(input: { job: BackfillJobState; source: HistoricalBarSource; store: BackfillStore; options: BackfillRunOptions }): Promise<BackfillRunResult> {
  const { source, store, options } = input;
  if (input.job.sourceId !== source.id) throw new Error(`backfill job ${input.job.id} is for ${input.job.sourceId}, not ${source.id}`);
  if (!(input.job.windowEndMs > input.job.windowStartMs)) throw new Error("backfill window must be non-empty");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 5;
  const maxRaw = options.maxRawPayloadBytes ?? 2_000_000;
  const spacingMs = Math.ceil(60_000 / Math.max(1, source.maxRequestsPerMinute));
  const intervalMs = INTERVAL_MS[input.job.interval];
  let job: BackfillJobState = { ...input.job, status: "RUNNING" };
  if (input.job.status === "COMPLETED") return { job: input.job, requests: 0, stoppedBy: "COMPLETED" };
  await store.saveJob(job);
  let requests = 0;
  let lastRequestAt = 0;

  while (requests < options.maxRequests) {
    if (options.shouldStop?.()) {
      job = { ...job, status: "PAUSED" };
      await store.saveJob(job);
      return { job, requests, stoppedBy: "STOPPED" };
    }
    const wait = lastRequestAt + spacingMs - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
    requests += 1;
    const page = await source.fetchPage({ instrumentKey: job.instrumentKey, interval: job.interval, startMs: job.windowStartMs, endMs: job.windowEndMs, cursor: job.cursor });
    if (!page.ok) {
      const attempts = job.attempts + 1;
      const permanent = page.code === "MISSING_CREDENTIALS" || page.code === "INVALID_CONFIGURATION" || page.code === "INVALID";
      job = { ...job, attempts, lastError: `${page.code}: ${page.error}`, status: permanent || attempts >= maxAttempts ? "FAILED" : "RUNNING" };
      await store.saveJob(job);
      if (job.status === "FAILED") return { job, requests, stoppedBy: "FAILED" };
      // Bounded exponential backoff, or the provider's Retry-After.
      await sleep(page.retryAfterMs ?? Math.min(60_000, 1000 * 2 ** attempts));
      continue;
    }
    const fetchedAt = now();
    const serialised = JSON.stringify(page.payload);
    await store.saveRawBatch({
      jobId: job.id,
      sourceId: source.id,
      request: page.requestDescription,
      fetchedAt,
      payloadHash: createHash("sha256").update(serialised).digest("hex"),
      rowCount: page.bars.length,
      payload: serialised.length <= maxRaw ? page.payload : null,
    });
    const normalised = normaliseBars(page.bars, { intervalMs, collectedAt: fetchedAt });
    const result = await store.upsertBars(
      job.datasetId,
      normalised.bars.map((bar) => ({ ...bar, hash: barHash(bar), collectedAt: fetchedAt })),
    );
    if (normalised.rejected.length > 0) await store.saveRejections(job.datasetId, normalised.rejected);
    job = {
      ...job,
      attempts: 0,
      lastError: null,
      cursor: page.nextCursor,
      rowsImported: job.rowsImported + result.inserted,
      rowsRejected: job.rowsRejected + normalised.rejected.length,
      revisionsDetected: job.revisionsDetected + result.revised,
      status: page.nextCursor === null ? "COMPLETED" : "RUNNING",
    };
    await store.saveJob(job);
    if (job.status === "COMPLETED") return { job, requests, stoppedBy: "COMPLETED" };
  }
  job = { ...job, status: "PAUSED" };
  await store.saveJob(job);
  return { job, requests, stoppedBy: "REQUEST_BUDGET" };
}

/** In-memory store for tests and dry runs. Mirrors the Prisma store's idempotency rules. */
export class MemoryBackfillStore implements BackfillStore {
  readonly raw: RawBatchRecord[] = [];
  readonly bars = new Map<string, Map<number, HistoricalBar & { hash: string; collectedAt: number }>>();
  readonly revisions: Array<{ datasetId: string; openTime: number; previousHash: string; newHash: string }> = [];
  readonly rejections: BarRejection[] = [];
  readonly jobs = new Map<string, BackfillJobState>();

  async saveRawBatch(batch: RawBatchRecord) {
    this.raw.push(batch);
  }

  async upsertBars(datasetId: string, bars: Array<HistoricalBar & { hash: string; collectedAt: number }>) {
    const series = this.bars.get(datasetId) ?? new Map();
    this.bars.set(datasetId, series);
    let inserted = 0;
    let unchanged = 0;
    let revised = 0;
    for (const bar of bars) {
      const existing = series.get(bar.openTime);
      if (!existing) {
        series.set(bar.openTime, bar);
        inserted += 1;
      } else if (existing.hash === bar.hash) {
        unchanged += 1;
      } else {
        this.revisions.push({ datasetId, openTime: bar.openTime, previousHash: existing.hash, newHash: bar.hash });
        revised += 1;
      }
    }
    return { inserted, unchanged, revised };
  }

  async saveRejections(_datasetId: string, rejections: BarRejection[]) {
    this.rejections.push(...rejections);
  }

  async saveJob(job: BackfillJobState) {
    this.jobs.set(job.id, { ...job });
  }
}
