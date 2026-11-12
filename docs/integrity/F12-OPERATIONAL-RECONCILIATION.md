# F12 — documentation and operational truth (Phase II)

## State layers (12 Nov 2026)

| # | Layer | State |
| --- | --- | --- |
| 1 | Historical implementation | `eba979f` and earlier, as audited at `6eaac8e` |
| 2 | Current `main` | `33c6a4a`: Phase I code `2cc6627` plus a deploy record |
| 3 | Remediation branch | `integrity/phase-ii` (this work); see [`STATUS.md`](STATUS.md) |
| 4 | Independently verified | Phase I: F01 (safety review, CI). Phase II: statistical review for F04; safety and regression reviews of the branch ([`RELEASE-READINESS.md`](RELEASE-READINESS.md)). Linux CI on Phase II has not run. |
| 5 | Release candidate | `integrity/phase-ii` head; not yet qualified |
| 6 | Production | `2cc6627`, per `docs/horizon/LEDGER.md` checkpoint 8. Not re-verified by this session: no VPS access was used. |
| 7 | Not deployed | everything in Phase II |
| 8 | Residual risks | [`RELEASE-READINESS.md`](RELEASE-READINESS.md) |

## Corrections made

- **The "3,000 unrecorded trials" claim** in `docs/evidence/ADR-0001-research-campaigns.md`, `docs/evidence/HANDOVER.md` and `docs/horizon/LEDGER.md` is corrected. The 3,000 was a cumulative count that included about 2,454 registry rows.
- **`docs/STATUS.md`** gains an OPERATION INTEGRITY section that separates production, `main` and the branch.
- **`docs/RUNBOOKS.md`** gains three items:
  - `REVALIDATION_REQUIRED` recovery;
  - how to list unclosed exploratory studies;
  - accurate heap/RSS wording and the isolation flag.
- **`docs/integrity/STATUS.md`** is rewritten for Phase II. It records that the brief's premise (open PRs #73–#77) was stale: they were merged and deployed.

## Defect found in Phase I remediation

`scripts/restore-verify.mjs` (Phase I F12 drill probes) probed a DELETE on every listed append-only table that has rows. `CyclePlan`'s trigger is `BEFORE UPDATE` only; deletes are allowed by design (migration `20261031120000`). So **every drill of a database where `CyclePlan` has rows, which means every production drill, would report `ok: false`**. This fails closed, but the drill could not be used as release evidence.

- **How it was found:** the first Phase II drill on a disposable database populated by the integration suite.
- **Fix:** probe UPDATE-only tables with a no-op UPDATE (`c767d50`).
- **Tests:** three regression tests, including the inert-trigger case.
- **Re-drill:** `ok: true`, 75 tables, 26 tables probed (25 with rows), no drift, scratch database dropped.
- **Coverage check:** a catalogue query (`pg_trigger`, no DELETE bit) confirmed that `CyclePlan` is the only UPDATE-only table in the list.

## Migration reconciliation

| Item | State |
| --- | --- |
| Migrations on the branch | 31, the same set as `main`. Phase II adds **none**. |
| Fresh database | `pnpm db:deploy` applies all 31 in name order. PASS on PostgreSQL 18.3. |
| Upgrade from deployed schema | N/A for Phase II: no schema change. |
| PCR-1 migration | `20261102120000_order_position_lifecycle` keeps its original name. Phase I's continuation note says the local DB `odin_test_integrity` once recorded a briefly renamed `20261112120000_…`. That DB was not reused for Phase II verification (a fresh `odin_test_phase2` was used). |
| `_prisma_migrations` in production | must show `20261110120000_evidence_research_campaigns` as the latest applied, with `finished_at` set and `rolled_back_at` null. Operator, read-only. |
| Rollback | forward-only Prisma migrations. Phase II needs no database rollback; an application rollback to `2cc6627` is schema-compatible. |

## Read-only production verification checklist (operator; nothing here was run)

```sql
-- Migration state
SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;
-- F08 compatibility: kinds the warehouse identity check accepts are SOLANA_POOL, EQUITY_ETF, COMMODITY, FX_PAIR
SELECT DISTINCT "instrumentKind" FROM "HistoricalDataset";
-- F03 history: registry rows the 3,000 figure overlapped
SELECT count(*) FROM "ResearchTrial" WHERE "window" IN ('TRAIN','FULL_GRID');
-- F04: campaign models that were registered under dsr-1 (must be revalidated before any further observation)
SELECT id, family, "createdAt" FROM "ModelVersion" WHERE family IN ('campaign-ml2','campaign-ml2-synthetic');
-- Active research and execution state before a deploy
SELECT "state", count(*) FROM "ResearchCampaignRunState" GROUP BY 1;
SELECT side, status, count(*) FROM "Order" WHERE status = 'PENDING' GROUP BY 1, 2;
```
