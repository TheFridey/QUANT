import { normaliseHistoricalDrawdown, type HistoricalDrawdown, type HistoricalDrawdownRow } from "@odin/analytics";
import type { PrismaClient } from "@odin/shared/db";

/**
 * All-history max drawdown for one account, computed in PostgreSQL.
 *
 * Running peak = max(equityUsd) over every earlier snapshot (window function,
 * ordered by createdAt then id); drawdown = (peak - equity) / peak * 100. Returns a
 * single bounded row regardless of how many snapshots exist. Parameterised via
 * the $queryRaw tagged template (no string interpolation).
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
        max(s."equityUsd") OVER (
          ORDER BY s."createdAt", s.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS peak
      FROM "EquitySnapshot" s
      WHERE s."accountId" = ${accountId} AND s."equityUsd" IS NOT NULL
    ),
    worst AS (
      SELECT at, equity, peak, (peak - equity) / peak * 100 AS dd
      FROM series
      WHERE peak > 0
      ORDER BY (peak - equity) / peak DESC, at ASC
      LIMIT 1
    )
    SELECT
      (SELECT count(*)::int FROM series) AS "sampleCount",
      (SELECT min(at) FROM series) AS "firstAt",
      (SELECT max(at) FROM series) AS "lastAt",
      w.dd::text AS "maxDrawdownPct",
      w.peak::text AS "peakEquityUsd",
      w.equity::text AS "troughEquityUsd",
      (SELECT max(p.at) FROM series p WHERE p.at <= w.at AND p.equity = w.peak) AS "peakAt",
      w.at AS "troughAt"
    FROM (SELECT 1) AS one
    LEFT JOIN worst w ON true
  `;
  return normaliseHistoricalDrawdown(rows[0]);
}
