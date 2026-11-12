# Deployment plan — `integrity/phase-ii` (prepared, NOT executed)

**Who runs it:** an authorised operator, after the qualification gates in [`RELEASE-READINESS.md`](RELEASE-READINESS.md) pass and the PR is approved and merged.

**Pattern:** the one used for every prior deploy (`docs/horizon/LEDGER.md`): fast-forward, pre-deploy dump, release snapshot, restart, health check.

**What the release contains:**

- no migration;
- no dependency change;
- no protected path;
- no change to the `EXECUTION_MODE`, `LIVE_MONEY_*` or risk-limit defaults.

## 1. Preflight (read-only)

1. **Production SHA.** The VPS checkout must equal `2cc6627`, or `33c6a4a`, which adds docs only.
2. **Release SHA.** Use the merge commit of the Phase II PR on `main`. Its CI must be green: `test`, `typecheck`, `lint`, `build`, `browser-e2e`.
3. **Backup.** Run `quant-backup.service` so it writes `/srv/quant/backups/quant-<stamp>.dump`. Record the file size and confirm `df -h /srv` leaves at least 3× its size free.
4. **Restore drill on the fresh dump, into a scratch database** (`scripts/restore-verify.mjs`, with the F12 fix). It must report `"ok": true`. This is the first drill that can pass on production data.
5. **Health.** `systemctl is-active quant-api quant-worker quant-web postgresql redis` must report active for each, and `/health` must return `ok`.
6. **Research state.** Run `SELECT state, count(*) FROM "ResearchCampaignRunState" GROUP BY 1`. Expect no `RUNNING` run. If there is one, wait, or cancel it with `campaign-cli cancel`. Its units count at their full reservation.
7. **Execution state.** The checks are:
   - open paper positions;
   - `PENDING` orders, especially SELL remainders;
   - BullMQ backlog.

   Phase II changes no execution code, so pending orders need no draining for correctness. Record the counts anyway, so that the post-deploy figures can be compared with them.
8. **Migration state.** In `_prisma_migrations`, the latest entry is `20261110120000_evidence_research_campaigns`, finished and not rolled back.
9. **F08 kinds.** `SELECT DISTINCT "instrumentKind" FROM "HistoricalDataset"` returns only accepted kinds.
10. **F04 models.** List campaign `ModelVersion` rows. Any under `SHADOW_CANDIDATE` was validated under dsr-1. Decide whether to retire it or rerun its campaign. Nothing changes automatically.
11. **PAPER-only.** `grep -E '^(EXECUTION_MODE|LIVE_MONEY_ENABLED|LIVE_MONEY_CONFIRM)=' /srv/quant/shared/.env` must show `EXECUTION_MODE=PAPER`. The two `LIVE_MONEY_*` keys must be absent, or not equal to `true` and the confirmation phrase respectively. Show the key names only, never the values of other keys.

## 2. Sequence

1. Fast-forward `/srv/quant` to the release SHA with the deploy key, then `pnpm install --frozen-lockfile` and `pnpm build` using the env-sourced build.
2. `pnpm db:deploy`. It is expected to report "No pending migrations". Anything else: **stop**.
3. Snapshot the release directory to `/srv/quant/releases/<sha>-<stamp>`.
4. Restart in this order: `quant-worker`, then `quant-api`, then `quant-web`. The worker goes first so that its in-flight research tick is cancelled; through the F10 pipe, the CLI and evaluator stop with it.
5. Smoke tests:
   - `/health` returns `ok`.
   - Log in, then log out. The F02 behaviour must be unchanged: a missing token gives 401, Redis unavailable gives 503.
   - The terminal snapshot response has `analyticsWindows.closedTrades.economicTrades`.
   - The campaign page loads, and its prospective evidence shows `cohort`.
   - `node apps/worker/dist/src/research/campaign-cli.js status <latest runId>` responds.
   - One paper cycle completes, with no `error` lines in the worker log for 10 minutes.
6. Observe for 24 h:
   - Equity snapshots carry `metrics.tradeBasis = "ECONOMIC_EXIT"`.
   - `closedTrades` is at most its pre-deploy value. A drop is expected wherever chunked exits existed.
   - Cash and realised P&L are unchanged by the release.

## 3. Rollback

- **Application rollback.** Check out the previous release snapshot (`2cc6627`), then restart the worker, API and web in the same order. The schema is identical, so **no database action is needed**. Reverting an application commit never reverses a migration, and this release has none.
- **Data written by Phase II code is kept and remains valid under `2cc6627`:**
  - `study-open:` / `study-close:` `LEGACY_DECLARED` ledger rows, which count trials, so this errs conservative;
  - equity-snapshot metrics with `tradeBasis`.
- **Outstanding orders:** unaffected by either version.
- **Restore from the pre-deploy dump** is needed only for database corruption unrelated to this release.
- **Roll back immediately on any of:**
  - the PAPER-only check fails;
  - `/health` is not ok after 5 minutes;
  - a worker crash loop;
  - auth regressions;
  - a cash or realised-P&L discrepancy against the pre-deploy record.
- **Stop and call the operator if:**
  - `db:deploy` reports pending migrations;
  - the restore drill is not ok;
  - a `RUNNING` campaign cannot be cancelled.

## 4. Safeguard verification (post-deploy)

- **Live money disabled.** Use the env key check above. The `packages/shared/src/execution-gate.ts` checksum must be unchanged against `2cc6627`: `git diff 2cc6627 HEAD -- packages/shared/src/execution-gate.ts` is empty.
- **Execution mode and risk limits unchanged.** `git diff 2cc6627 HEAD -- packages/shared/src/strategy.ts packages/risk-engine packages/trading-engine` is empty.
- **No unapproved promotion.** The checks are:
  - `SELECT count(*) FROM "StrategyPromotion" WHERE "createdAt" > '<deploy time>'` returns 0;
  - no `ModelLifecycleEvent` was created by a non-operator actor since the deploy.
- **Accounting.** Sum `REALIZED_PNL` before and after for the same account and window. The sums must be equal, and the trade-lots reconciliation (`PNL_FEES_RECONCILED`) must still pass.
