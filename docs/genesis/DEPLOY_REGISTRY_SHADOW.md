# GENESIS Phases 5–6: model registry and shadow predictions — deployment

Status: **implemented; not deployed; off by default.** Stacked on GENESIS Phase 4 (ML Engine 2.0, PR #52), which must merge first.

> **Applying this migration to production needs separate, explicit operator approval.** Nothing in this document authorises a production deploy, and merging the PR does not apply anything.

## What ships

| Piece | Location |
| --- | --- |
| Migration (additive: five new tables, triggers, CHECKs; no existing table touched) | `packages/shared/prisma/migrations/20261104100000_genesis_model_registry_shadow` |
| Schema models | `ModelVersion`, `ModelPaperApproval`, `ModelLifecycleEvent`, `ShadowPrediction`, `ShadowOutcome` in `packages/shared/prisma/schema.prisma` |
| Registry, lifecycle, shadow service, leaderboard | `packages/evolution/src/genesis/*` (imported as `@odin/evolution/genesis`) |
| Pure ML 2.0 inference entry (no backtest engine) | `packages/backtest/src/ml2-runtime.ts` (imported as `@odin/backtest/ml2`) |
| Worker job | `apps/worker/src/genesis-shadow.ts` (queue `odin.genesis-shadow`) |

Lifecycle states (`EXPERIMENTAL` … `PAPER_APPROVED`, `RETIRED`, `FAILED`, `REJECTED`) are **evidence labels only**. None grants trading authority; nothing here writes `EngineControl`, risk configuration, strategy instances, promotions or execution permissions, or creates orders/trade intents. The operator promotion process (`packages/evolution/src/promotion.ts`, unchanged) stays the only route to a paper strategy. Shadow outcomes have `source = HYPOTHETICAL_SHADOW` and never enter the ledger or paper metrics.

## Flag

| Variable | Default | Effect |
| --- | --- | --- |
| `GENESIS_SHADOW_ENABLED` | unset (**disabled**) | Only the exact string `true` enables it. Disabled: no repeat job is scheduled (stale ones are removed at boot) and the processor returns without touching the database. |
| `GENESIS_SHADOW_TICK_MS` | 300 000 | Repeat interval; values under 60 000 fall back to the default. |
| `GENESIS_SHADOW_MAX_MODELS` / `_MAX_PREDICTIONS` / `_MAX_RESOLUTIONS` / `_MAX_MS` | 5 / 200 / 500 / 20 000 | Per-cycle budget; clamped to 20 / 1 000 / 2 000 / 60 000. |

Even when enabled, a cycle only runs models whose current state is `SHADOW_CANDIDATE` or `SHADOW_VALIDATED`, and only if their `trainingProtocol.shadow` names a bar interval and instruments, they use the default feature set, and their artefact re-verifies against `artefactHash`.

## Procedure (migration first)

1. **Prerequisite: a fresh backup that has been restore-verified.** Take the pre-deploy dump (`quant-backup.service`) and run the isolated restore verification in `docs/RUNBOOKS.md` (*Restore / backup → Isolated restore verification*) against it. Do not continue unless it reports `"ok": true`. Record the dump name and result in `docs/ascend/STATUS.md`.
2. **Operator approval** for the production migration, recorded with the commit SHA being deployed.
3. Apply the migration **before** deploying code: `pnpm db:deploy` (`prisma migrate deploy`) with the production `DATABASE_URL`. It only creates tables, indexes, functions and triggers; it does not lock or rewrite existing tables.
4. Verify (health probes below), then deploy the API/worker build as usual. Leave `GENESIS_SHADOW_ENABLED` unset.
5. Enabling shadow later is a separate operator decision: set `GENESIS_SHADOW_ENABLED=true` for the worker and restart it.

## Health probes (read only)

```sql
-- Migration applied
SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE migration_name = '20261104100000_genesis_model_registry_shadow';
-- Tables and append-only triggers present (expect 5 tables, 15 triggers)
SELECT count(*) FROM information_schema.tables WHERE table_name IN ('ModelVersion','ModelPaperApproval','ModelLifecycleEvent','ShadowPrediction','ShadowOutcome');
SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('"ModelVersion"','"ModelPaperApproval"','"ModelLifecycleEvent"','"ShadowPrediction"','"ShadowOutcome"');
-- Shadow activity (zero rows while disabled)
SELECT count(*), max("createdAt") FROM "ShadowPrediction";
SELECT "toState", count(*) FROM "ModelLifecycleEvent" GROUP BY 1;
-- Shadow never mixes with paper: must always be 0
SELECT count(*) FROM "ShadowOutcome" WHERE "source" <> 'HYPOTHETICAL_SHADOW';
```

Worker log lines: `genesis shadow disabled … nothing scheduled` at boot while off; `genesis shadow cycle` with counts when on.

## Operational prerequisites

- **Clock sync.** Insert triggers date rows by the database clock and refuse a prediction dated more than 5 s ahead of it or more than 5 min behind it. Keep NTP running on the worker host and the database host. Skew fails safe: rows are refused, never accepted wrongly.
- **Database role.** The append-only guarantee holds against the application role only. A table owner or superuser can disable triggers (`ALTER TABLE … DISABLE TRIGGER`, `session_replication_role = replica`). Confirm the role the app connects with does not own the tables or hold superuser. Not verified for production.

## Rollback

- **Stop writes:** unset `GENESIS_SHADOW_ENABLED` (or set anything other than `true`) and restart the worker. The scheduler removes the repeat job; no further rows are written.
- **Code rollback:** redeploy the previous build. The new tables are unused by older code, so the migration can stay in place (it is additive; nothing existing depends on it).
- **Do not drop the tables** to roll back. They are append-only evidence and refuse `DELETE`/`TRUNCATE` by design. There is no down migration. `DROP TABLE` would still work, in the order ShadowOutcome, ShadowPrediction, ModelLifecycleEvent, ModelPaperApproval, ModelVersion, then `DROP FUNCTION odin_genesis_*`. It would destroy the evidence, so it needs its own reviewed migration and operator approval, taken after a backup.

## Tests

- Unit: `pnpm vitest run packages/evolution/src/genesis apps/worker/src/genesis-shadow.test.ts` (lifecycle table incl. parity with the SQL function, hash verification and real-artefact parsing, prediction timing, resolver timing, suspension, leaderboard maths, import boundary, disabled-by-default worker).
- Integration (only when `DATABASE_URL_TEST` names an `*odin_test*` database with the migration applied): `pnpm vitest run packages/evolution/src/genesis/registry-shadow.integration.test.ts` — triggers refuse UPDATE/DELETE/TRUNCATE, lifecycle chain and approval rules in SQL, an end-to-end shadow cycle with real-time timing (prediction before outcome, outcome after horizon, monitor suspension, leaderboard), and unchanged `Order`/`TradeIntent`/`Fill`/`LedgerEntry` counts and `EngineControl`/`StrategyInstance` content.
