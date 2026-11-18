-- D3 preflight: read-only zero-obligation check for every account. Run immediately before activation and again
-- right after the worker restart. Every "must be 0" row must be 0; the status listings are for a human to read.
\set ON_ERROR_STOP on
\pset footer off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
\echo == snapshot
SELECT current_timestamp, current_setting('transaction_read_only') AS read_only;
\echo == must be 0
SELECT 'open positions' AS check, count(*) FROM "Position" WHERE "baseQty" > 0
UNION ALL SELECT 'orders not terminal', count(*) FROM "Order" WHERE status NOT IN ('FILLED','CANCELLED','REJECTED','EXPIRED')
UNION ALL SELECT 'unresolved protection intents', count(*) FROM "ProtectionIntent" WHERE status = 'UNRESOLVED'
UNION ALL SELECT 'live protection legs', count(*) FROM "ProtectionOrder" WHERE status IN ('ARMED','TRIGGERED','SUBMITTED')
UNION ALL SELECT 'open recovery cases', count(*) FROM "RecoveryCase" WHERE status = 'OPEN'
UNION ALL SELECT 'held risk reservations', count(*) FROM "RiskReservation" WHERE status = 'HELD'
-- Narrowed 18 Nov: TradeIntent rows are never read back to place or settle orders, and production holds
-- hundreds of stale ADMITTED/DEFERRED rows whose orders are terminal or absent. An intent is only an
-- obligation when its order is still live.
UNION ALL SELECT 'trade intents with a live order', count(*) FROM "TradeIntent" ti JOIN "Order" o ON o."clientOrderId" = ti."clientOrderId" WHERE o.status NOT IN ('FILLED','CANCELLED','REJECTED','EXPIRED')
UNION ALL SELECT 'trade intents SUBMITTED/PENDING/PARTIALLY_FILLED/UNKNOWN', count(*) FROM "TradeIntent" WHERE status IN ('SUBMITTED','PENDING','PARTIALLY_FILLED','UNKNOWN')
UNION ALL SELECT 'running research campaign units', count(*) FROM "ResearchCampaignUnit" WHERE state IN ('PENDING','RUNNING');
\echo == status listings (read by a human: any unfamiliar non-terminal value blocks activation)
SELECT 'Order' AS t, status, count(*) FROM "Order" GROUP BY 2
UNION ALL SELECT 'ProtectionOrder', status, count(*) FROM "ProtectionOrder" GROUP BY 2
UNION ALL SELECT 'ProtectionIntent', status, count(*) FROM "ProtectionIntent" GROUP BY 2
UNION ALL SELECT 'RiskReservation', status, count(*) FROM "RiskReservation" GROUP BY 2
ORDER BY 1, 2;
\echo == money state to compare before and after (must not change)
SELECT id, "cashUsd", "highWaterMarkUsd", "sessionStartEquityUsd", "sessionLowEquityUsd" FROM "PaperAccount" ORDER BY id;
SELECT status, (config->>'pauseNewEntries') AS pause_new_entries, md5(config::text) AS config_md5, "updatedAt" FROM "EngineControl" WHERE id = 'primary';
\echo == discovery activity in the last 10 minutes (expect >0 before, 0 after)
SELECT count(*) AS solana_observations_10m FROM "MarketObservation" WHERE source = 'dexscreener' AND "receivedAt" > now() - interval '10 minutes';
SELECT count(*) AS buys_10m FROM "Order" WHERE side = 'BUY' AND "createdAt" > now() - interval '10 minutes';
COMMIT;
