# AURUM Workstream Zero: storage plan

> TITANIUM supersedes executor readiness claims: independent review found high-severity lock, audit, dependency and archive replacement defects. Deletion remains disabled even after any future hash approval; real allowlist empty. Restore is local-disposable only. See TITANIUM-STORAGE-REVIEW.md for evidence, quarantine and additive audit approval scope. Same-disk archives do not establish off-host recovery or immediate OS capacity reclamation. No production deletion or restoration authorised.

**Status:** policy and dry-run tooling are implemented and unit-tested. The archive/delete executor is **not built**. It needs a disposable-database proof, which is BLOCKED on this host because it has no Docker or PostgreSQL. It also needs operator approval of the policy. No production data has been touched.

## 1. Problem (recorded 17 Nov 2026, not re-read)

| Table | Size | Rows |
| --- | --- | --- |
| AgentDecision | 7.6 GB | 8.5 M |
| MarketObservation | 3.8 GB | 1.7 M |
| CyclePlan | 1.1 GB | — |
| OpportunityFunnelEvent | 0.7 GB | — |

- The database is 13 GB and grows about 0.75 GB a day.
- Nightly dumps are 1.91 GB and grow about 120 MB a night.
- The disk has 49 GB free.
- ~~About 8,640 `NO_INTENT` decisions are written every 2 hours.~~ **Corrected 18 Nov (D14):** production has no NO_INTENT rows (HOLD 76.6%, REJECT 18.4%, PASS 5.0%, ACT 0.02%), so the AgentDecision rule below would archive almost nothing. See [D14-PRODUCTION-STORAGE.md](D14-PRODUCTION-STORAGE.md).

## 2. Proposed policy (`apps/worker/src/ops/retention-policy.ts`, pending approval)

| Table | Hot window | Age column | Preserved regardless of age |
| --- | --- | --- | --- |
| AgentDecision | 30 d | `GREATEST(createdAt, updatedAt)` (upserts keep `createdAt`) | the cycle has an Order, TradeIntent or EquitySnapshot; **or** `decision` ≠ `NO_INTENT` |
| MarketObservation | 30 d | `receivedAt` | referenced by `Order.observationId` / `decisionObservationId` / `fillObservationId`, `Fill`, `TradeIntent`, `WatchlistEntry` or `BacktestTrade` |
| CyclePlan | 30 d | `plannedAt` | the cycle has an Order, TradeIntent or EquitySnapshot |
| OpportunityFunnelEvent | 90 d | `createdAt` | same as CyclePlan |

- **MarketObservation is executor-blocked** (`executorBlocked: RESEARCH_DATASET_WINDOWS_UNMAPPED`). `packages/evolution/src/pipeline.ts` hashes observation windows (`id:receivedAt:priceUsd`) as research dataset identity, and those windows are not yet mapped to a preservation rule. The dry run still estimates the table, but `executablePolicies` excludes it until the windows are mapped.
- **Never retention candidates** (`validatePolicy` refuses them): Order, Fill, Position, LedgerEntry, EquitySnapshot, PaperAccount, AccountSafetyState, TradeIntent, ResearchTrial, ResearchTrialLedger, HistoricalDataset.
- Research datasets are separate warehouse tables and are unaffected.
- **Minimum hot window:** 7 days.
- **Batch:** at most 10,000 rows, keyset-paginated on the primary key, so a run is restart-safe.

**Replay fidelity.** GENESIS opportunity-history export (`opportunity-loader.ts`) and trade-lot memory read AgentDecision and CyclePlan.
- Trade-lot memory only reads cycles that have orders, and those are preserved.
- A history export over a window older than 30 days would need restoring from the archive first. Run any such export before the first archival pass. **Operator decision D2.**

**Aggregation of `NO_INTENT`.** A later step could write one daily count per (agent, pair, reason code) and stop writing individual `NO_INTENT` rows. That changes what the worker writes and loses per-cycle replay. It is proposed for after archival works, not now.

## 3. Executor design (to build in `aurum/01-storage`)

1. **Lock.** `pg_try_advisory_lock(0x41555255)`. If another runner holds it, exit.
2. **Pre-flight.**
   - `diskPressure` must not be CRITICAL. Free space must exceed twice the estimated archive size plus the WAL headroom.
   - A recent verified backup must exist.
3. **Per batch, in one transaction:**
   - `SELECT` keys (`batchSelectSql`);
   - `COPY (SELECT … WHERE key = ANY($keys)) TO STDOUT` → gzip JSONL;
   - write the file, `fsync`, and compute its SHA-256;
   - append the batch to the manifest;
   - `DELETE … WHERE key = ANY($keys)` **after** the file is verified;
   - record an audit row (`RetentionRun`, additive migration).
4. Throttle between batches and stop on any error. The manifest records the last completed key, so a rerun resumes from there.
5. **Space reclaim.** A plain DELETE frees pages for reuse inside the table; it does not shrink the files on disk. Returning space to the OS needs `pg_repack` (online) or `VACUUM FULL` (exclusive lock). Plan:
   - routine `VACUUM (ANALYZE)` after each run, so space is reused and growth stops;
   - a one-off `pg_repack` in a maintenance window, which needs about the table's size in free space.
6. **Restore** (`retention-restore`):
   - verify the manifest (`verifyManifest`);
   - `COPY FROM` into a staging table;
   - `INSERT … ON CONFLICT DO NOTHING` into the target;
   - compare row counts and hashes.
7. **Partitioning** (MarketObservation by month, AgentDecision by month). This is the long-term fix: dropping a partition is O(1) and reclaims space. It is a large migration on hot tables, so the plan is to evaluate it after archival has bounded growth. It is not proposed now.

## 4. Disposable-database proof (required before any approval request)

1. Start a fresh PostgreSQL 16 on a disposable host or CI.
2. Run `pnpm db:deploy` and seed with a synthetic fixture: cycles with and without orders, observations referenced by each FK, and `NO_INTENT` versus other decisions.
3. Run the dry run, then archive, then verify the manifest.
4. Assert that preserved rows are untouched and candidate rows are gone.
5. Restore and assert a byte-identical row set.
6. Repeat with a kill mid-batch and resume.
7. Run two concurrent runners and assert one is locked out.

This proof cannot run on the current host. It can run in CI, which has PostgreSQL, as an `odin_test` integration test.

## 5. Production dry run (read-only; needs operator approval to ssh)

```bash
ssh scalesmiths 'cd /srv/quant/current/apps/worker && node dist/src/ops/retention-dry-run-cli.js'
```

- This needs this branch deployed. The release path on the VPS is `UNVERIFIED`; earlier deploy notes use `/srv/quant/releases/<sha>`.
- The CLI runs in a `READ ONLY` transaction with a 300 s statement timeout and prints per-table totals, aged rows, candidate rows, bytes and the oldest row.
- The correlated NOT EXISTS queries over 8.5 M AgentDecision rows may be slow, so run it off-peak.

## 6. Disk-pressure thresholds (`diskPressure`)

- **CRITICAL:** less than 10% free, or fewer than 14 days to full. The executor refuses to run.
- **WARN:** less than 20% free, or fewer than 45 days to full.

On the recorded figures (49 GB free, +0.75 GB/day) there are about 65 days to full, assuming linear growth. XAU ingest would add to that, so retention lands before ingest (dependency graph).
