\set ON_ERROR_STOP on
\pset footer off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH m1 AS (
  SELECT "openTime" t, open, high, low, close FROM "HistoricalBar"
  WHERE "datasetId" = (SELECT id FROM "HistoricalDataset" WHERE "instrumentKey"='XAU_USD' AND interval='1m' AND "sourceId"='oanda_practice')
    AND "openTime" >= '2025-10-01' AND "openTime" < '2025-11-01'
), d AS (
  SELECT date_trunc('hour', t) AS h,
         (array_agg(open ORDER BY t))[1] AS o, max(high) AS hi, min(low) AS lo, (array_agg(close ORDER BY t DESC))[1] AS c, count(*) AS members
  FROM m1 GROUP BY 1
), n AS (
  SELECT "openTime" h, open o, high hi, low lo, close c FROM "HistoricalBar"
  WHERE "datasetId" = (SELECT id FROM "HistoricalDataset" WHERE "instrumentKey"='XAU_USD' AND interval='1h' AND "sourceId"='oanda_practice')
    AND "openTime" >= '2025-10-01' AND "openTime" < '2025-11-01'
)
SELECT count(*) FILTER (WHERE d.h IS NOT NULL AND n.h IS NOT NULL) AS both,
       count(*) FILTER (WHERE d.h IS NULL) AS native_only,
       count(*) FILTER (WHERE n.h IS NULL) AS derived_only,
       count(*) FILTER (WHERE d.o = n.o AND d.hi = n.hi AND d.lo = n.lo AND d.c = n.c) AS exact_ohlc,
       count(*) FILTER (WHERE d.o <> n.o) AS open_diff,
       count(*) FILTER (WHERE d.hi <> n.hi) AS high_diff,
       count(*) FILTER (WHERE d.lo <> n.lo) AS low_diff,
       count(*) FILTER (WHERE d.c <> n.c) AS close_diff,
       max(abs(d.c - n.c)) AS max_close_abs_diff,
       count(*) FILTER (WHERE d.members < 60) AS derived_partial_hours
FROM d FULL OUTER JOIN n ON d.h = n.h;
COMMIT;
