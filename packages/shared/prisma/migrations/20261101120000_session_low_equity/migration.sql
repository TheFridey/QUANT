-- ASCEND-00 F1: lowest known equity this Europe/London day, so a daily-loss breach latches entries
-- until the next London day even if equity recovers. Reset by the worker on the session roll.
ALTER TABLE "PaperAccount" ADD COLUMN "sessionLowEquityUsd" DECIMAL(24,8);

-- Backfill from the current session's valued snapshots so a breach earlier today is not forgotten.
UPDATE "PaperAccount" AS a
SET "sessionLowEquityUsd" = s.low
FROM (
  SELECT e."accountId", MIN(e."equityUsd") AS low
  FROM "EquitySnapshot" e
  JOIN "PaperAccount" p ON p.id = e."accountId"
  WHERE p."sessionStartedAt" IS NOT NULL
    AND e."createdAt" >= p."sessionStartedAt"
    AND e."equityUsd" IS NOT NULL
    AND e.valuation IN ('LIVE', 'CASH_ONLY')
  GROUP BY e."accountId"
) AS s
WHERE s."accountId" = a.id;
