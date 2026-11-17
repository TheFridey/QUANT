# Historical trial reconciliation and gold data

17 November 2026. Repository investigation only. No production query, provider acquisition, campaign, declaration or holdout read performed.

## Counting semantics (VERIFIED_REPOSITORY)

`packages/evolution/src/campaign/accounting.ts:programmeTrials` counts ResearchTrial rows only for windows TRAIN and FULL_GRID, plus LEGACY_DECLARED trials, plus SETTLED campaign counts or unresolved RESERVED bounds. A raw count of all ResearchTrial rows is a different quantity. The documented 2,454 raw rows and 2,170 programme count can coexist without proving missing/deleted trials. Their dates and window partitions still require operator verification. Neither is verified-current here.

`docs/genesis/EXECUTION_LEDGER.md` records 4 November CSV experiments on a production warehouse export with a manually supplied prior count. `docs/horizon/LEDGER.md` records warehouse-fed daily gold studies and hourly/daily OANDA acquisitions before the integrity work. At historical commit `5902f49`, horizon-cli implements both CSV and warehouse modes. This proves capability, not that every historical run used warehouse mode. The ledger's explicit statement that a daily gold study ran directly from the production warehouse is repository evidence of a reported warehouse-mode run; no corresponding current DB row was independently inspected.

The questionnaire in `docs/integrity/F03-F06-RESEARCH-INTEGRITY.md` contains a proposed subtraction from a rounded cumulative figure. TITANIUM does not endorse its approximate 550/830 residuals. A count of TRAIN/FULL_GRID configurations, fold rows, validation rows, ML learners, repeated reruns and manually supplied prior counts cannot be subtracted interchangeably. The 3,000 figure is not an audited run inventory or upper bound.

## Exact operator read-only SQL (not executed)

Run through an approved read-only production connection. Output contains identifiers and aggregate research metadata, no credentials or bar values. The transaction reads metadata only and never opens sealed holdout data.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SELECT current_database(), current_timestamp;
SELECT count(*) AS raw_rows,
       count(*) FILTER (WHERE "window" IN ('TRAIN','FULL_GRID')) AS counted_registry_rows
FROM "ResearchTrial";
SELECT "window",count(*) AS rows FROM "ResearchTrial" GROUP BY 1 ORDER BY 1;
SELECT r."id",r."createdAt",r."datasetId",r."datasetVersion",r."codeVersion",
       r."strategyId",r."strategyVersion",count(t."id") AS rows,
       count(t."id") FILTER (WHERE t."window" IN ('TRAIN','FULL_GRID')) AS counted
FROM "ResearchRun" r LEFT JOIN "ResearchTrial" t ON t."runId"=r."id"
GROUP BY r."id" ORDER BY r."createdAt",r."id";
SELECT "kind",count(*) AS rows,sum("trials") AS trials
FROM "ResearchTrialLedger" GROUP BY 1 ORDER BY 1;
SELECT "id","kind","unitId","trials","priorTrials","actor","note"
FROM "ResearchTrialLedger" ORDER BY "id";
SELECT count(*) AS campaigns FROM "ResearchCampaign";
SELECT count(*) AS runs FROM "ResearchCampaignRun";
SELECT "status",count(*) FROM "ResearchCampaignUnit" GROUP BY 1 ORDER BY 1;
SELECT d."id",d."sourceId",d."instrumentKey",d."interval",d."versionHash",
       d."barCount",d."firstOpenTime",d."lastOpenTime",d."updatedAt"
FROM "HistoricalDataset" d WHERE d."instrumentKey" IN ('XAU_USD','XAUUSD','commodity:XAUUSD')
ORDER BY d."sourceId",d."interval";
COMMIT;
```

The run inventory query is bounded by statement timeout, not an arbitrary LIMIT that would silently omit trials. Operator should export complete metadata if it exceeds that budget, using keyset pagination under an agreed consistent snapshot. Pending studies are identified by matching study-open/study-close note keys with the existing accounting helper; manual declarations are distinguished from study closes and campaign reservations.

Final declaration request is BLOCKED on these results and the operator's CSV/warehouse run inventory, including aborted/disclosed runs, grid sizes, learners and which registry entries already represent them. Reconcile exact run identities and count only uncovered trials. If exact evidence is irrecoverable, operator must explicitly attest a defensible conservative bound and its derivation; do not derive it from rounded cumulative labels. Required declaration form, not runnable until N/actor/note are approved:

```text
node apps/worker/dist/src/research/campaign-cli.js declare-legacy-trials --count <APPROVED_UNCOVERED_N> --by <OPERATOR> --note "TITANIUM reconciled historical inventory <HASH>; uncovered configurations <N>; registry snapshot <HASH>; uncertainty and conservative rationale <REFERENCE>"
```

This command appends irreversibly and is not idempotent by note; record declaration ID and verify the new total before any retry. Nothing declared here.

## Dataset availability matrix

| Interval | Existing repository evidence | Adapter capability | Current coverage/hash |
| --- | --- | --- | --- |
| 1m | no confirmed acquired dataset | OANDA M1 mapping exists | UNVERIFIED |
| 5m | no confirmed acquired dataset | OANDA M5 mapping exists | UNVERIFIED |
| 15m | no confirmed acquired dataset | OANDA M15 mapping exists | UNVERIFIED |
| 1h | documented 11,904 XAU bars in earlier acquisition | OANDA H1 | current hash, gaps and last refresh UNVERIFIED |
| 4h | no confirmed acquired dataset | OANDA H4 | UNVERIFIED |
| 1d | documented UTC 3,112 bars and replacement NY17 2,602 bars | oanda_practice_ny17 only for daily | current hash, gaps and refresh UNVERIFIED |

Counts are historical documentation, not a live availability promise. `OandaCandlesSource` requests MBA: mid OHLC in HistoricalBar and bid/ask OHLC in extra; tick volume is labelled separately and traded volume remains null. Bid/ask completeness must be checked per dataset before spread research. UTC and NY17 daily sources have distinct identities and must not be spliced. Historical bar schema is Decimal(38,18), distinct from execution-price proposal Decimal(24,8).

## Bounded resumable refresh mechanism

Existing `apps/worker/src/history/backfill-cli.ts`, `ensureBackfillJob`, `runBackfill` and `PrismaBackfillStore` already implement checkpointed append-only acquisition, revision/rejection recording, request budgets and dataset hashes. Reuse these rather than create a second importer. Approval proposal: one XAU_USD interval per process, maximum 20 requests per invocation, provider limiter 30 requests/minute, explicit closed start/end bounds and stop between pages. Intraday uses oanda_practice; daily uses oanda_practice_ny17. Existing requested arguments resume an open job. First acquire a small approved pre-holdout interval and verify complete bars, event availability, rejected rows and revision counts before expanding.

Not executed: provider account history depth/entitlement, network timeouts and cost must be confirmed, resource budget approved and immutable research snapshot/holdout boundaries registered first. Refresh must never change a campaign's pinned content identity. New provider revisions are evidence, never overwritten history. It must not execute a campaign or evaluate a holdout. Any future gap report should use closed-session calendar expectations and bounded windows, not assume 24/7 bars.
