\set ON_ERROR_STOP on
\pset footer off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
\echo == snapshot
SELECT current_database(), current_timestamp, current_setting('transaction_read_only') AS read_only;
\echo == trial counts
SELECT count(*) AS raw_rows,
       count(*) FILTER (WHERE "window" IN ('TRAIN','FULL_GRID')) AS counted_registry_rows
FROM "ResearchTrial";
\echo == trials by window
SELECT "window",count(*) AS rows FROM "ResearchTrial" GROUP BY 1 ORDER BY 1;
\echo == run inventory
SELECT r."id",r."createdAt",r."datasetId",r."datasetVersion",r."codeVersion",
       r."strategyId",r."strategyVersion",count(t."id") AS rows,
       count(t."id") FILTER (WHERE t."window" IN ('TRAIN','FULL_GRID')) AS counted
FROM "ResearchRun" r LEFT JOIN "ResearchTrial" t ON t."runId"=r."id"
GROUP BY r."id" ORDER BY r."createdAt",r."id";
\echo == ledger by kind
SELECT "kind",count(*) AS rows,sum("trials") AS trials
FROM "ResearchTrialLedger" GROUP BY 1 ORDER BY 1;
\echo == ledger rows
SELECT "id","kind","unitId","trials","priorTrials","actor","note"
FROM "ResearchTrialLedger" ORDER BY "id";
\echo == campaigns
SELECT count(*) AS campaigns FROM "ResearchCampaign";
SELECT count(*) AS runs FROM "ResearchCampaignRun";
\echo == campaign units by state (doc said status; the column is state)
SELECT "state",count(*) FROM "ResearchCampaignUnit" GROUP BY 1 ORDER BY 1;
\echo == gold datasets
SELECT d."id",d."sourceId",d."instrumentKey",d."interval",d."versionHash",
       d."barCount",d."firstOpenTime",d."lastOpenTime",d."updatedAt"
FROM "HistoricalDataset" d WHERE d."instrumentKey" IN ('XAU_USD','XAUUSD','commodity:XAUUSD')
ORDER BY d."sourceId",d."interval";
\echo == storage (catalogue only)
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes;
SELECT c.relname AS table_name, pg_size_pretty(pg_total_relation_size(c.oid)) AS total, pg_total_relation_size(c.oid) AS bytes, c.reltuples::bigint AS est_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8;
COMMIT;
