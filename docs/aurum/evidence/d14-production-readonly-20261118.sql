\set ON_ERROR_STOP on
\pset footer off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
\echo == snapshot
SELECT current_timestamp, current_setting('server_version') AS server_version, current_setting('transaction_read_only') AS read_only;
\echo == MarketObservation last 24h by source and environment
SELECT source, "tradingEnvironment", count(*) AS rows FROM "MarketObservation" WHERE "receivedAt" > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 3 DESC;
\echo == AgentDecision last 24h by agent and decision
SELECT agent, decision, count(*) AS rows FROM "AgentDecision" WHERE "createdAt" > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 3 DESC;
\echo == AgentDecision last 24h: rows with and without a pair
SELECT (("pairAddress" = '') ) AS per_cycle_row, count(*) FROM "AgentDecision" WHERE "createdAt" > now() - interval '24 hours' GROUP BY 1;
\echo == CyclePlan and CycleRun last 24h
SELECT count(*) AS plans, pg_size_pretty(sum(pg_column_size(plan))::bigint) AS plan_bytes FROM "CyclePlan" WHERE "plannedAt" > now() - interval '24 hours';
SELECT count(*) AS cycles FROM "CycleRun" WHERE "startedAt" > now() - interval '24 hours';
\echo == OpportunityFunnelEvent last 24h
SELECT count(*) AS rows FROM "OpportunityFunnelEvent" WHERE "createdAt" > now() - interval '24 hours';
\echo == obligations (for D3 readiness; not the activation check)
SELECT "accountId", count(*) AS open_positions FROM "Position" WHERE "baseQty" > 0 GROUP BY 1;
SELECT "accountId", status, count(*) FROM "Order" WHERE status IN ('PENDING','UNKNOWN','PRE_SUBMIT','SUBMITTED') GROUP BY 1,2;
\echo == EngineControl config flags
SELECT status, (config->>'pauseNewEntries') AS pause_new_entries, (config->>'marketDataPaperFxIngest') AS fx_ingest, (config->>'multiMarketPaperIngest') AS multi_market, (config->>'universeLimit') AS universe_limit FROM "EngineControl" WHERE id = 'primary';
COMMIT;
