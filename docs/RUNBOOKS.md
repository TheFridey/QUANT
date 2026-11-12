# QUANT Launch — Owner Runbooks (stub)

Stub command sheet for Gate A/D handoff. Current status and evidence are in `STATUS.md`.

## Scope (D25)

**Single-operator paper/local deployment.** One trusted operator on a private host or VPN.
JWT roles, socket fanout, and in-memory login rate limits are **not** a multi-user authorization product.
Do not expose the stack as a shared multi-tenant service without completing multi-user ownership, proxy-aware shared rate limits, and account-scoped socket rooms.

## Environment

```bash
# Branch / SHA
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD

# Baseline compare
git merge-base HEAD be0923305193cfbf5ccfbf6336663e0b002ca5bf
```

## Local bring-up

```bash
cp .env.example .env   # secrets only; never EXECUTION_MODE=LIVE for fills
pnpm install
pnpm infra:up          # Postgres/Redis on 127.0.0.1 only (see docker-compose.yml)
pnpm db:deploy
pnpm build:packages
pnpm --filter @odin/api dev
pnpm --filter @odin/worker dev
pnpm --filter @odin/web dev
```

Local paper login (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`) is unchanged: `POST /api/auth/login`.
Logout: `POST /api/auth/logout` with `Authorization: Bearer <token>` revokes the JWT server-side (memory + Redis when available). Clearing browser storage alone is insufficient after logout.

### Auth rate limiting (proxy note)

Login attempt limiting is **per-process in-memory** keyed by Express `request.ip`.
It is **not** a shared Redis limiter and is only proxy-aware if the process is configured to trust forwarded headers (not enabled by default). For single-operator loopback use this is acceptable; do not treat it as production multi-replica abuse protection.

Socket origins are restricted to `WEB_ORIGIN` plus local paper defaults (`127.0.0.1:4317` / `localhost:4317`) — not any origin.

## Production bind / network (D26)

- **Compose (this repo):** publish Postgres `5432` and Redis `6379` on `127.0.0.1` only — never `0.0.0.0`.
- **Shared/production host:** prefer **no host port publish**; attach Postgres/Redis to a private Docker/K8s network reachable only by api/worker. Terminate TLS at a reverse proxy; do not expose DB/cache.
- **API and web listen:** both bind `127.0.0.1` by default (`API_HOST`, `WEB_HOST` override). In a container set `API_HOST=0.0.0.0` / `WEB_HOST=0.0.0.0` only behind a private network + reverse proxy. Do not publish raw API/DB ports to the public internet.
- **Secrets off loopback:** when `WEB_ORIGIN` is not a loopback origin the API refuses to start with a `JWT_SECRET` under 32 characters, any published sample secret, or the sample `ADMIN_PASSWORD`, regardless of `NODE_ENV`.
- **Login rate limit behind a proxy:** the limiter keys on `request.ip` and Express `trust proxy` is off, so behind a reverse proxy all clients share the proxy IP (one attacker can lock the operator out for 10 minutes). Enable `trust proxy` only for the exact proxy hop you control; never `true` on an internet-facing listener.
- Development compose credentials (`odin`/`odin`) are for local paper only — replace before any shared deployment.

### ADMIN_PASSWORD rotation limitation

`ensureFoundation` **creates** the admin user when missing; it does **not** update `passwordHash` when `ADMIN_PASSWORD` in env changes.
Changing `.env` alone does **not** rotate an existing seeded admin. Rotation requires an explicit password-update path (DB/hash rewrite or future admin API) — document this before claiming credential rotation is enforced.

## Gate A regression placeholders

```bash
pnpm exec vitest run packages/shared/src/execution-context.test.ts
pnpm exec vitest run packages/shared/src/position-key.test.ts
pnpm exec vitest run packages/shared/src/protection-coverage.test.ts
pnpm exec vitest run packages/shared/src/safety-state.test.ts
pnpm exec vitest run packages/shared/src/observation-origin.test.ts
pnpm exec vitest run packages/trading-engine/src/eligible-observation.test.ts
pnpm exec vitest run packages/risk-engine/src/reservations.test.ts
pnpm exec vitest run apps/api/src/token-revocation.test.ts
```

**Session revocation and Redis (F02).** With `REDIS_URL` set, Redis is the shared revocation store and the API fails closed: while Redis is unreachable every authenticated request returns 503 ("Session check unavailable") and terminal sockets are refused (`AUTH_UNAVAILABLE`) or disconnected at the next 60 s revalidation. Logout still works: it revokes in this process, queues the Redis write, and returns 503 so the web shows its "not confirmed" notice; queued writes are flushed before the next Redis read is answered. Restore Redis to restore access. Leave `REDIS_URL` unset only for a deliberate single-process run, where in-memory revocation is the store and does not survive a restart.

```bash
pnpm exec vitest run apps/api/src/token-revocation.failclosed.test.ts apps/api/src/auth-hardening.test.ts apps/api/src/terminal-gateway.test.ts
```

## Safety / recovery (owner)

```bash
# Inject reconcile fault in lab only — suspends entries; exits remain
# ODIN_RECONCILE_FAULT=1

# Alert ACK does NOT clear ACTIVE safety — clean reconcile required
# POST /terminal/alerts/:id/ack
```

## External demo (blocked without credentials)

```bash
pnpm build:packages
node scripts/verify-external-providers.mjs --provider alpaca_paper
node scripts/verify-external-providers.mjs --provider oanda_practice
```

## OANDA daily candles: re-backfill on the 17:00 New York roll (HORIZON)

Daily FX/metals datasets stored under source `oanda_practice` were requested with UTC daily alignment. They include a Sunday 00:00 UTC stub bar, and the FX_24_5 research calendar refuses them (`MISALIGNED`). Leave those rows untouched. Back-fill a new dataset under source `oanda_practice_ny17` instead. It requests `dailyAlignment=17` and `alignmentTimezone=America/New_York`: each bar opens at 17:00 New York (21:00Z in US summer, 22:00Z in winter) and becomes available at its true close, 24 h later. The warehouse keys datasets by (source, instrument, interval), so the new dataset is distinct and identifiable by its `sourceId`. `oanda_practice` now refuses `1d`, so the two alignments cannot mix. Intraday intervals stay on `oanda_practice`.

```bash
# On the worker host, from apps/worker; read-only against OANDA; resumable by re-running.
for i in EUR_USD GBP_USD USD_JPY XAU_USD; do
  node dist/src/history/backfill-cli.js oanda_practice_ny17 "$i" 1d MAJOR_FX 2016-11-01T00:00:00Z 2026-11-01T00:00:00Z 50
done
# Then point horizon-cli at the new datasetId (sourceId = oanda_practice_ny17).
```

Use a cohort that fits the instrument (for example XAU_USD is stored as `COMMODITY`). The old `oanda_practice` 1d datasets can be deleted later, by explicit operator decision only.

## Restore / backup

Do not delete ambiguous paper history. Production backups are custom-format dumps written by the VPS
`quant-backup.service` to `/srv/quant/backups/quant-<UTC stamp>.dump` before each deploy (see
`docs/ascend/STATUS.md` for recorded ones). Backup scheduling, retention and encryption live on the VPS,
not in this repository, and have not been inspected from a session with VPS access (APEX `NOT_VERIFIED`).

### Isolated restore verification (APEX §15.3)

Restores a dump into a **new** scratch database (`odin_restore_drill_<stamp>`), verifies it and drops it.
It never writes to an existing database; the admin URL must name `postgres` or `template1`.

```bash
RESTORE_ADMIN_URL=postgresql://<drill role>:<pass>@127.0.0.1:5432/postgres \
  nice -n 15 node scripts/restore-verify.mjs \
    --dump /srv/quant/backups/quant-<stamp>.dump \
    --source-url postgresql://<user>:<pass>@127.0.0.1:5432/<app db>   # required; opened read-only
```

URLs are split into host, port, user, password and database and passed to `psql`/`pg_restore` only as
libpq environment variables, so no password appears in `ps`. Any query parameter except `sslmode`
(for example `?dbname=`, which libpq would otherwise let override the path) is refused, and the scratch
connection must report `current_database()` = the generated name before `pg_restore` runs. Prefer a
drill role with `CREATEDB` but not superuser: a tampered dump runs SQL as the restoring role.

Pass criteria (`"ok": true`, exit 0): `pg_restore` exits 0; a non-empty latest Prisma migration; every
user trigger in the source exists in the restore; each listed append-only table keeps its named
`*_append_only` / `*_immutable` trigger, and a table with rows still rejects `DELETE` with the trigger's
own error (probed inside a rolled-back transaction; empty tables report `null`); no table is missing or
extra; no restored count exceeds the live source (lower counts are reported as drift, since a live
database keeps growing). Check free disk first: the scratch copy needs about the size of the live
database (~1 GB on 1 Nov 2026).

Evidence: local drill on 2 Nov 2026 (57 tables, 2,128 rows, exact match, no missing triggers, restore
under 1 s) and fail-closed controls (truncated dump → exit 1; application DB or `?dbname=` in the admin
URL → refused). A production-dump drill is still `NOT_VERIFIED` (needs VPS access).
`scripts/backup-restore-nonprod.mjs` is **retired** (OPERATION INTEGRITY F05, 12 Nov 2026) and now refuses
every invocation without connecting: it checked only the URL path, then passed the whole URI (with its
password) to `psql` on argv and ran `DROP SCHEMA public CASCADE`, so a query parameter such as `?dbname=`
or `?host=` could aim the reset at a different database. Its earlier "non-prod only" wording was not a
guarantee. To reset a test database, create a fresh `odin_test` database and run `pnpm db:deploy`
against it; to prove a dump restores, use `restore-verify.mjs` above.

The drill also probes behaviour (F12): the research campaign and GENESIS append-only tables and the
guarded `ResearchCampaignRunState`/`ResearchCampaignUnit` tables must keep their named triggers, reject
`DELETE` when they have rows, and reject `TRUNCATE` where a `_no_truncate` trigger exists (statement-level,
so empty tables are checked too). A backup file that exists or lists cleanly is not evidence; only a run
ending `"ok": true` is. A real drill against a disposable Postgres has not been run in this remediation
(no local Docker); the 2 Nov evidence above predates the F12 probes.

### Recovery objectives (proposed, not yet agreed with the operator)

- RPO: the latest pre-deploy dump; there is no scheduled dump or WAL archiving verified in-repo, so
  RPO between deploys is unbounded until the VPS schedule is confirmed.
- RTO: restore time measured by the drill plus rebuild; record the production figure when the drill runs there.
- Migration rollback: Prisma migrations here are forward-only. Roll back by restoring the pre-deploy
  dump into a new database and repointing `DATABASE_URL`, never by dropping tables in place.

## Pipeline stall (`/api/health` degraded, `pipeline: stalled`)

`/api/health` reports `degraded` when a RUNNING engine has completed no cycle for 5 minutes (detail: authenticated `/api/health/detail`).

Ingest, sentinel, pulse, aegis, atlas and archivist fail after 60 s (`STAGE_TIMEOUT`, metric `odin_stage_timeout`) and the next cycle starts clean; a timed-out scheduled ingest leaves its cycle for the 120 s `STALE_CYCLE` sweep. **The executor is never timed out**, because abandoning order settlement could process it twice: an overrun only raises `odin_stage_overrun`. If the executor hangs, its queue blocks and each later cycle ends `STALE_CYCLE`.

Recovery: check open positions and pending orders, then `systemctl restart quant-worker` (the stuck job is retried; backlogged jobs for dead cycles exit at once). Do not restart PostgreSQL or Redis for this.

## Research campaigns (OPERATION EVIDENCE)

Design and rationale: [`docs/evidence/ADR-0001-research-campaigns.md`](evidence/ADR-0001-research-campaigns.md). Research only: no command below creates an order or changes engine configuration, risk limits or strategy instances.

Run from `apps/worker` after `pnpm build` (CLI: `node dist/src/research/campaign-cli.js <command>`). The checkout must be clean, or `GIT_COMMIT` set: a run is pinned to one commit.

| Step | Command | Writes |
| --- | --- | --- |
| Dry run | `plan <spec.json>` (add `--preflight` to load and check the data) | nothing |
| Declare | `create <spec.json> --by NAME` | one immutable campaign (same declaration = same campaign) |
| Start | `start <campaignId> --by NAME` | run 1 and its units; repeating it returns the same run |
| Execute | `work <runId> [--max-units N]` | results, trial ledger, events |
| Inspect | `status <runId>`, or Research campaigns in the terminal (Radar) | nothing |
| Cancel | `cancel <runId> --by NAME` | cancellation (cannot be withdrawn) |
| Rerun on purpose | `start <campaignId> --by NAME --rerun --reason "…"` | a new run number; earlier runs untouched |
| Authorise a holdout | `authorize-holdout <unitId> --operator NAME [--ttl-hours 24]`, or the button in the terminal (ADMIN) | one `AUTHORIZED` ledger row |
| Read the holdout once | `evaluate-holdout <unitId>` | consume intent, then the result or `RESULT_LOST` |
| Observe prospectively | `register-model <unitId> --by NAME --instrument-key KEY --max-staleness-days N --observe-signals N`, then `observe <modelVersionId> --operator NAME --reason "…"` | model registry rows; scored only when `GENESIS_SHADOW_ENABLED=true` |
| Trial count | `trials`; `declare-legacy-trials --count N --by NAME --note "…"` | (second form) one ledger row |

Recovery:

- **Process died mid-run:** run `work <runId>` again. Units whose executor stopped are reclaimed 60 s after the last heartbeat; finished units are skipped; trial reservations and the frozen prior count are reused.
- **Unit FAILED or ABANDONED:** terminal for that run. Read the error with `status`, fix the cause, then `start --rerun --reason`. Its trials stay counted at the full reservation. This is intended.
- **`CODE_VERSION_MISMATCH`:** check out the run's commit (shown by `status`), or rerun on the new commit.
- **`DATASET_CHANGED`:** the data no longer matches what the run pinned. Rerun; do not edit the pin.
- **Holdout `RESULT_LOST`:** the period is spent for that hypothesis family. Do not try to re-evaluate: collect bars after the period, or use prospective observation.
- **`REVALIDATION_REQUIRED` on `register-model`:** the unit was validated under an older DSR protocol (before `dsr-2.0.0`, OPERATION INTEGRITY F04). Start a new run (`start --rerun --reason`); its trials are counted again. Old results are kept as they were.
- **Unclosed exploratory studies:** a legacy CLI (`horizon-cli`, `ml-cli`, `research-cli`, `intelligence-cli`) that crashed leaves a `study-open:` row in `ResearchTrialLedger` with no matching `study-close:` row. Nothing was printed, so nothing was selected on; rerunning the same command reuses the open study. List them read-only: `SELECT note, actor, "createdAt" FROM "ResearchTrialLedger" o WHERE note LIKE 'study-open:%' AND NOT EXISTS (SELECT 1 FROM "ResearchTrialLedger" c WHERE c.note LIKE 'study-close:' || substr(o.note, 12, 64) || ' %')`.
- **Never** delete or update rows in `ResearchTrialLedger`, `ResearchHoldoutLedger`, `ResearchCampaignResult` or `ResearchCampaignEvent` (the database refuses it).

Worker job: off unless `RESEARCH_CAMPAIGN_WORKER_ENABLED=true` (then `RESEARCH_CAMPAIGN_TICK_MS`, default 60 s, and `RESEARCH_CAMPAIGN_MAX_UNITS`, 1 to 5). It starts the CLI as a separate, low-priority process and passes it only the database URL and commit (the CLI still reads the host `.env` itself, as every research CLI does); evaluation never runs in the trading worker. It only works runs pinned to the deployed commit, and does not evaluate holdouts. Each process holds a stdin pipe to its child, and a child exits when that pipe closes, so a killed worker or CLI leaves no evaluator behind (F10). `limits.maxMemoryMbPerUnit` is a V8 **heap** limit; total memory is only watched (sampled RSS) unless research runs under a cgroup. `RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION=true` makes `work-next` refuse to run without a cgroup v2 `memory.max`. The supported isolated deployment (a systemd service with `MemoryMax`, worker tick off) is in [`integrity/F10-INVESTIGATION.md`](integrity/F10-INVESTIGATION.md).

**Deploy order: run `pnpm db:deploy` before restarting the API or worker.** The research CLIs read the trial ledger and fail without it. The Market Scanner keeps working and shows research evidence as unavailable until the tables exist.

Migration `20261110120000_evidence_research_campaigns` adds eight tables and changes none. Rollback: the tables are unused by trading, so a forward fix is preferred; if they must go, restore from the pre-deploy dump as for any migration.

Synthetic demonstration: [`docs/evidence/demo/README.md`](evidence/demo/README.md).
