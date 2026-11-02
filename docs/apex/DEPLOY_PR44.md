# Deployment procedure: PR #44 (APEX increment 1)

To be run by the operator, or by a session with authorised VPS access, through the existing process (as for `d2d1526`, `docs/ascend/STATUS.md`). **Not run from the APEX authoring session, which has no VPS access.** PAPER-only throughout: this procedure never sets or edits `EXECUTION_MODE`, `LIVE_MONEY_*` or risk limits.

## Scope

| Item | Value |
| --- | --- |
| Target | the merge commit of PR #44 on `main` (record it as `TARGET`) |
| Expected current | `d2d1526` (last recorded deploy) or a later docs-only commit; record as `CURRENT` |
| Migration | **none**: `git diff CURRENT..TARGET -- packages/shared/prisma` must be empty |
| Lockfile | unchanged: `git diff CURRENT..TARGET -- pnpm-lock.yaml` must be empty |
| Protected paths | none changed (verify with the command in step 1) |
| Restart | **API** (budget/autonomy code runs there) and **web** (one label). The worker needs a rebuild only: it gains an offline CLI and does not import `@odin/evolution` |

Service unit names for the API, worker and web are not recorded in the repository (`NOT_VERIFIED`). Use the names the VPS already uses, and write them into the ledger after this deploy.

## 1. Preflight (read-only; stop on any failure)

```bash
cd /srv/quant/app/repo
git status --porcelain                         # must be empty
CURRENT=$(git rev-parse --short HEAD); echo "$CURRENT"
git fetch origin main && TARGET=$(git rev-parse --short origin/main); echo "$TARGET"
git merge-base --is-ancestor "$CURRENT" "$TARGET" && echo fast-forward-ok
git diff --stat "$CURRENT".."$TARGET" -- packages/shared/prisma pnpm-lock.yaml        # empty
git diff --name-only "$CURRENT".."$TARGET" | grep -E '^(packages/(risk-engine|trading-engine)/|packages/shared/src/(execution-gate|strategy)\.ts|packages/market-data/src/.*(venue|broker|execution-)|packages/evolution/src/promotion\.ts|\.github/workflows/)' ; echo "protected paths changed above (must be none)"
grep -E '^(EXECUTION_MODE|LIVE_MONEY_ENABLED)=' .env                                  # PAPER / false; prints only these two keys
df -h /srv && free -m                                                                  # ≥ 3 GB free for backup + build + drill copy
curl -fsS http://127.0.0.1:4318/api/health                                             # {"status":"ok"}
psql "$DATABASE_URL" -Atc "select count(*) from \"MarketObservation\" where \"receivedAt\" > now() - interval '5 minutes'"   # > 0
psql "$DATABASE_URL" -Atc "select max(\"createdAt\") from \"CycleRun\""               # within the last few minutes
curl -s -o /dev/null -w '%{http_code}\n' https://scalesmiths.co.uk https://veteranfinder.co.uk     # 200 200 (other tenants)
```

## 2. Backup and restore verification (before any change)

```bash
sudo systemctl start quant-backup.service
DUMP=$(ls -t /srv/quant/backups/quant-*.dump | head -1); ls -la "$DUMP"
pg_restore -l "$DUMP" | grep -c 'TABLE DATA'                                           # ≈ 57 or more
# New in this release (run it from the TARGET checkout after step 3, or from a copy of the script):
RESTORE_ADMIN_URL=postgresql://<drill role>:<pass>@127.0.0.1:5432/postgres \
  nice -n 15 node scripts/restore-verify.mjs --dump "$DUMP" --source-url "$DATABASE_URL"   # "ok": true
```

Do not continue without a dump whose restore verifies. Check free disk first: the drill copies the database (~1 GB).

## 3. Build snapshot, checkout, build

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ); SNAP=/srv/quant/releases/$CURRENT-$STAMP
mkdir -p "$SNAP" && cp -a packages/*/dist apps/api/dist apps/worker/dist apps/web/.next "$SNAP"/ 2>/dev/null; ls "$SNAP"
git checkout --detach "$TARGET"
pnpm install --frozen-lockfile
nice -n 15 pnpm build:packages
nice -n 15 pnpm --filter @odin/api build
nice -n 15 pnpm --filter @odin/worker build
nice -n 15 pnpm --filter @odin/web build
```

## 4. Restart (API and web only)

Restart the API unit, then the web unit, using the existing service manager. Do not restart PostgreSQL, Redis or unrelated services. The API reads `degraded` for up to ~1 minute while clients reconnect (known behaviour).

## 5. Smoke tests (all must pass)

| Check | Command or step | Pass |
| --- | --- | --- |
| Deployed SHA | `git rev-parse --short HEAD` | = `TARGET` |
| Health | `curl -fsS http://127.0.0.1:4318/api/health` (retry for up to 2 min) | `{"status":"ok"}` |
| PAPER gate | authenticated `GET /api/health/detail` | `executionGateOk: true`, `liveEnabled: false` |
| Env unchanged | `grep -E '^(EXECUTION_MODE\|LIVE_MONEY_ENABLED)=' .env` | PAPER / false |
| D-01 budget | authenticated `GET /api/evolution/model-ops` | `budget.window = "UTC_DAY"`, `budget.capUsd` = the autonomy cap, `spentUsd` = today's `ModelUsageLog` sum |
| D-03 gate | authenticated `GET /api/evolution/autonomy` | `allowRiskLimitMutation: false` |
| D-03 refusal | authenticated `PUT /api/evolution/autonomy` `{"level":1,"allowRiskLimitMutation":true}` | HTTP 400; row unchanged |
| Market data | observations in the last 5 min (as in preflight) | > 0 |
| Worker | latest `CycleRun` | advancing |
| Web | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4317/` and the public URL | 307 locally, 401 publicly (Basic Auth intact) |
| UI label | Settings → Autonomy | "Research model budget … per UTC day" |
| Other tenants | scalesmiths.co.uk, veteranfinder.co.uk | 200 |
| Engine config untouched | latest `EngineConfigRevision` id and `EngineControl` config hash | unchanged from preflight |

Then, read-only research evidence (writes nothing): `nice -n 15 node apps/worker/dist/src/research/portfolio-cli.js <SOL/USDC 1h datasetId> <GATO 1h datasetId>`. Record the output in the ledger as `VERIFIED_HISTORICAL`, research only.

## 6. Rollback (any smoke test fails, or errors appear in API logs)

```bash
git checkout --detach "$CURRENT"
cp -a "$SNAP"/* <restore each dist/.next to its original location>   # or rebuild at CURRENT
# restart API and web
curl -fsS http://127.0.0.1:4318/api/health
```

No database rollback is needed (no migration). `ModelUsageLog` rows written meanwhile stay valid. If the API rejected `allowRiskLimitMutation`, nothing was stored, so there is nothing to undo.

## 7. Record

In `docs/apex/EXECUTION_LEDGER.md` and `docs/ascend/STATUS.md`: `TARGET`, the time, the backup path, the drill result, the snapshot path, the restarted units (with their names), each smoke result, and the rollback point `CURRENT`.
