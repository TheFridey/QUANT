import { normaliseHistoricalDrawdown, type HistoricalDrawdown, type HistoricalDrawdownRow } from "@odin/analytics";
import type { PrismaClient } from "@odin/shared/db";

/**
 * All-history max drawdown for one account, computed in PostgreSQL.
 *
 * One scan and one sort of the account's EquitySnapshot rows:
 * - running peak and the time it was set come from a single window aggregate,
 *   max(ARRAY[equity, epoch(createdAt)]) ordered by (createdAt, id): arrays compare
 *   element-wise, so equal peaks resolve to the latest time (matching
 *   computeHistoricalDrawdown in @odin/analytics);
 * - sample count and first/last timestamps are whole-partition windows in the
 *   same pass;
 * - the worst row is picked with ORDER BY drawdown DESC, createdAt ASC LIMIT 1.
 * drawdown = (peak - equity) / peak * 100. Always returns one row (sampleCount 0
 * when the account has no snapshots). Parameterised via the $queryRaw tagged
 * template (no string interpolation).
 *
 * Cost is still O(n log n) in the account's snapshot count per call, so polling
 * callers should go through HistoricalDrawdownCache.
 */
export async function queryHistoricalDrawdown(
  prisma: Pick<PrismaClient, "$queryRaw">,
  accountId: string,
): Promise<HistoricalDrawdown> {
  const rows = await prisma.$queryRaw<HistoricalDrawdownRow[]>`
    WITH series AS (
      SELECT
        s."createdAt" AS at,
        s."equityUsd" AS equity,
        max(ARRAY[s."equityUsd", extract(epoch FROM s."createdAt")]) OVER (
          ORDER BY s."createdAt", s.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS peak,
        count(*) OVER () AS n,
        min(s."createdAt") OVER () AS first_at,
        max(s."createdAt") OVER () AS last_at
      FROM "EquitySnapshot" s
      WHERE s."accountId" = ${accountId} AND s."equityUsd" IS NOT NULL
    ),
    worst AS (
      SELECT
        at, equity, peak[1] AS peak_equity, peak[2] AS peak_epoch, n, first_at, last_at,
        CASE WHEN peak[1] > 0 THEN (peak[1] - equity) / peak[1] * 100 END AS dd
      FROM series
      ORDER BY dd DESC NULLS LAST, at ASC
      LIMIT 1
    )
    SELECT
      coalesce(w.n, 0)::int AS "sampleCount",
      w.first_at AS "firstAt",
      w.last_at AS "lastAt",
      w.dd::text AS "maxDrawdownPct",
      w.peak_equity::text AS "peakEquityUsd",
      w.equity::text AS "troughEquityUsd",
      (timestamp 'epoch' + w.peak_epoch * interval '1 second') AS "peakAt",
      w.at AS "troughAt"
    FROM (SELECT 1) AS one
    LEFT JOIN worst w ON true
  `;
  return normaliseHistoricalDrawdown(rows[0]);
}

export const HISTORICAL_DRAWDOWN_CACHE_TTL_MS = 30_000;

/**
 * Per-account TTL cache in front of queryHistoricalDrawdown so dashboard polling
 * does not rescan the snapshot history on every request. Entries expire purely by
 * age (no other invalidation); a new snapshot appears in the figure within one TTL.
 * Concurrent misses for the same account share one in-flight query; a failed
 * query is not cached.
 */
export class HistoricalDrawdownCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<HistoricalDrawdown> }>();

  constructor(
    private readonly load: (accountId: string) => Promise<HistoricalDrawdown>,
    private readonly ttlMs: number = HISTORICAL_DRAWDOWN_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(accountId: string): Promise<HistoricalDrawdown> {
    const at = this.now();
    const hit = this.entries.get(accountId);
    if (hit && hit.expiresAt > at) return hit.value;
    const value = this.load(accountId);
    const entry = { expiresAt: at + this.ttlMs, value };
    this.entries.set(accountId, entry);
    value.catch(() => {
      if (this.entries.get(accountId) === entry) this.entries.delete(accountId);
    });
    return value;
  }
}
