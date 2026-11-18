# D8: read-only production inspection, 18 November 2026

Operator approval: "Approve D8" (18 Nov 2026), for the read-only production inspection SQL/metadata in `TITANIUM-APPROVAL-PACKAGE.md` D8. Nothing was written, restarted, deployed or declared.

## How it ran

- Preflight over `ssh scalesmiths` (read-only): production checkout `aec2a80cbc6ca34ef4a32f267d04adbf938e128d`, clean (0 changed files). PostgreSQL active. `/` 146 GB, 102 GB used, **44 GB free (70%)**.
- SQL: [`evidence/d8-production-readonly-20261118.sql`](evidence/d8-production-readonly-20261118.sql), piped to `sudo -u postgres psql -d quant -X -f -`, with `ON_ERROR_STOP`.
  - One `REPEATABLE READ READ ONLY` transaction, `statement_timeout 30s`, `lock_timeout 2s`.
  - The server reported `transaction_read_only = on`, and the transaction committed at 09:56:57 UTC.
- Raw output: [`evidence/d8-production-readonly-20261118.txt`](evidence/d8-production-readonly-20261118.txt). It holds identifiers, hashes and aggregates only, and no credentials. A scan for secret patterns found only the strategy name `token_age_exhaustion`.

**Differences from the TITANIUM-TRIALS-AND-DATA.md query set:**
- `ResearchCampaignUnit` has no `status` column. The schema column is `state`, so the query used `state`. As written, the query would have aborted the transaction.
- Three catalogue-only storage reads were added:
  - `pg_database_size`;
  - the eight largest tables by `pg_total_relation_size`, with `reltuples`;
  - `df` in the preflight.
- The retention dry-run CLI (STORAGE-PLAN §5) was **not** run. Its correlated NOT EXISTS scans over 8.5 M rows go beyond this package's bounded metadata scope.

## Trial registry (VERIFIED_PRODUCTION)

| Quantity | Value |
| --- | --- |
| `ResearchTrial` raw rows | **2,454** |
| Rows with `window` TRAIN or FULL_GRID (`programmeTrials` basis) | **2,170** (TRAIN 1,736 + FULL_GRID 434) |
| Rows with `window` TEST | 284 |
| `ResearchRun` rows | 174, all created 1 Nov 2026, 18:29–20:58 UTC; 103 have no trial rows |
| Runs by `codeVersion` | d78c21d 90, f56151f 60, 0e970a9 18, d2d1526 6 |
| Distinct datasets referenced | 7 |
| `ResearchTrialLedger` | **empty** (no LEGACY_DECLARED, no study open/close, no reservations) |
| `ResearchCampaign` / `ResearchCampaignRun` / `ResearchCampaignUnit` | 0 / 0 / 0 |

**The 2,454 vs 2,170 discrepancy is resolved.** The difference is exactly the 284 TEST-window rows, which `programmeTrials` excludes by design. No trials are missing or deleted. The per-run totals sum to the same 2,454 and 2,170. With an empty ledger and no campaigns, the current programme count is the 2,170 registry rows alone.

**This does not settle the historical declaration.**
- Every registry row comes from one day, 1 Nov 2026.
- The 4 Nov GENESIS CSV experiments (`docs/genesis/EXECUTION_LEDGER.md`) are not in the registry, and nor are the HORIZON gold studies (`docs/horizon/LEDGER.md`), including the reported warehouse-mode daily gold study.
- Those runs are **uncovered**, and the database cannot count them.
- A defensible declaration still needs your inventory of those runs: grid sizes, learners, folds and reruns. Alternatively, you can attest a conservative bound and its derivation (D7).
- Nothing was declared. The command form stays as in TITANIUM-TRIALS-AND-DATA.md, not runnable until N, actor and note are approved.

## Gold datasets (VERIFIED_PRODUCTION)

| Source | Interval | Bars | First | Last | versionHash |
| --- | --- | --- | --- | --- | --- |
| oanda_practice | 1d (UTC) | 3,112 | 2016-11-01 | 2026-11-05 | d4d3857d2f9e8aa8733487d128bb6a48 |
| oanda_practice | 1h | 11,904 | 2024-11-01 00:00 | 2026-11-06 09:00 | dce5bb74702eaf5354ac2e9c32317b9b |
| oanda_practice_ny17 | 1d (NY 17:00) | 2,602 | 2016-11-01 21:00 | 2026-11-04 22:00 | ade7acf6c7754828dc42ab37bbb6d76b |

- The bar counts match the documented figures.
- All three were last updated on 6 Nov and are about 12 days stale.
- No 1m, 5m, 15m or 4h XAU dataset exists.
- Gaps and bid/ask completeness were not checked; that needs bar reads, which are outside D8.

## Storage (VERIFIED_PRODUCTION, catalogue estimates for rows)

| Table | Size | Est. rows |
| --- | --- | --- |
| AgentDecision | 8,081 MB | 8.50 M |
| MarketObservation | 3,985 MB | 1.67 M |
| CyclePlan | 1,188 MB | 72.8 k |
| OpportunityFunnelEvent | 728 MB | 1.87 M |
| TradeIntent | 300 MB | 210 k |
| CycleRun | 70 MB | 73.9 k |
| ObservabilityEvent | 57 MB | 145 k |
| EquitySnapshot | 56 MB | 70.3 k |
| **Database** | **14 GB (15.27 GB decimal)** | |

- **Recorded figures on 17 Nov:** 13 GB database and 48–49 GB free, with AgentDecision at 7.6 GB and MarketObservation at 3.8 GB.
- **Change in about 21 hours:** AgentDecision +0.48 GB, MarketObservation +0.19 GB, and 4–5 GB less free disk.
- **Possible causes:** the 1.95 GB pre-deploy dump (12:37 UTC on 17 Nov) and the nightly dump probably account for part of the disk drop. This is UNVERIFIED: the backup directory was not listed.
- **Days to full:** a linear estimate is not reliable from one interval. At the recorded +0.75 GB/day database growth alone, 44 GB is about 58 days. Counting dumps as well, it is shorter.

## Still blocked

- Archive and delete: blocked on the durable-audit protocol (TITANIUM-STORAGE-REVIEW.md) and on D1.
- Historical trial declaration: blocked on the operator's uncovered-run inventory or attestation (D7).
- Gold dataset refresh: needs its own approval (bounded backfill proposal in TITANIUM-TRIALS-AND-DATA.md).
