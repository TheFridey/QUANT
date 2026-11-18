# D3: legacy crypto retirement — deploy and activation plan

Prepared 18 Nov 2026. **Not executed.** Each step marked ⛔ needs your explicit go-ahead at the time: push, merge, deploy, `.env` edit and restart. Nothing here deletes data, changes the stored strategy config or touches risk limits.

## Why now

D14 measured about **2.5 GB of disk a day**: about 0.85 GB of database growth and about 1.7 GB of growth in the 14-day backup window. With 44 GB free, the disk is full in about **17–18 days (around 5–6 December 2026)**. All observation growth, and about 99% of decision growth, comes from Solana discovery. Retirement is the only change that stops it. See [D14-PRODUCTION-STORAGE.md](D14-PRODUCTION-STORAGE.md).

## What is deployed

- **Branch `aurum/catalyst-retirement`, commit `b227d15`, built on `main` `dc24992`.** `main` is production `aec2a80` plus docs.
- **Diff:** 10 files, worker only, plus `.env.example`:
  - `legacy-retirement.ts`, its unit and integration tests;
  - `stage-runner.ts`, `executor/host.ts`, `executor/settle.ts`, `sandbox-execution.ts` and its test;
  - `worker.module.ts`.
- **What it leaves out:** no migration, no dependency or lockfile change, no protected path, and no API or web change.
- **Taken unchanged from `b54a275`** on `aurum/05-titanium-integration`, which had already been reviewed. The 70-file TITANIUM integration (Next upgrade, build changes, readiness API) is deliberately not part of this deploy.

**Default behaviour after deploy is unchanged (ACTIVE).** Deploying and activating are separate steps.

## Evidence on this branch (local; disposable PostgreSQL 16 on tmpfs)

| Check | Result |
| --- | --- |
| `pnpm build:packages`, worker typecheck, eslint on changed files | pass |
| Full integration project | **35 files / 181 tests pass** (main's 34 / 177 plus the 4 retirement tests) |
| Full unit project | **1,457 pass, 34 skipped, 1 failed**. The failure is `process-isolation.test.ts`, a Windows CRLF regex mismatch that also fails on untouched `main` on this host; `apps/worker/src/research` is identical to `main`. It passes on Linux CI |
| Preflight SQL | executed against the disposable database: parses, stays read-only (`read_only = on`), and reports non-zero obligations from the leftover fixtures, so the checks do detect them |
| Retirement integration (4) | ACTIVE unchanged; RETIRED on a flat book; RETIRED cancels a queued entry with cash unchanged, and reversal to ACTIVE; RETIRED with an open position keeps its held mark without discovery and fills its exit |
| Review | `quant-safety-reviewer` gave APPROVE WITH NOTES. Findings 1 (SANDBOX outbox), 2 (typo not reported), 4 (retired cycles logged as errors) and 5 (exit test) are fixed. Finding 3 (dashboard shows the stored config) is documented below |
| Linux CI | **not yet run**; it runs on the PR |

## Known behaviour to accept before activation

- **The dashboard still says new entries are allowed.** The API reads the stored config, which is not changed.
  - An operator BUY gets an accepted receipt, then the worker rejects it with `PAUSE_NEW_ENTRIES`. Nothing is placed.
  - The worker log line at start is the authoritative signal.
- **Retirement is read once at worker start.** Changing it needs a worker restart.
- **Production runs PostgreSQL 14.24; CI uses 16.** The change uses no SQL.

## Steps

### A. Code path to production

1. ⛔ **Push the branch and open a PR to `main`.** Linux CI must be green: install, db:deploy, test, typecheck, lint, build, browser e2e.
2. ⛔ **Merge to `main`.**
3. ⛔ **Deploy the merge commit,** following the existing procedure (vps-ssh notes and recent deploy ledgers):
   - **Preflight, read-only:** `git rev-parse HEAD` is `aec2a80` and the checkout is clean; services are active; `/api/health` is ok.
   - **Backup:** `sudo systemctl start quant-backup.service`.
     - About 2 GB. The disk has room, but keep it well clear of a full disk.
     - If free space is under 10 GB at this point, stop and fix backups first (D15).
   - **Update:** fast-forward as `quant` with the deploy key; `pnpm install --frozen-lockfile`; then `pnpm build` with `.env` sourced.
   - `db:deploy` must report "No pending migrations".
   - **Snapshot:** `/srv/quant/releases/<old-sha>-<stamp>`.
   - **Restart the worker only.** The API and web code are unchanged, so restarting them is optional and not recommended.
   - **Smoke:**
     - the worker logs `legacy crypto active` once;
     - cycles reach `COMPLETE`;
     - Solana observations are still arriving (ACTIVE);
     - 0 worker error lines;
     - cash, HWM and config md5 are unchanged ([preflight SQL](evidence/d3-preflight-readonly.sql)).

The code can stay deployed in ACTIVE for as long as wanted. **Rollback of the code:** check out the old SHA, rebuild and restart the worker. No database action is needed.

### B. Activation

4. **Fresh zero-obligation check, read-only, immediately before activation.** Run [`evidence/d3-preflight-readonly.sql`](evidence/d3-preflight-readonly.sql):

   ```bash
   ssh scalesmiths 'sudo -u postgres psql -d quant -X -A -F " | " -f -' < docs/aurum/evidence/d3-preflight-readonly.sql
   ```

   **Stop the activation unless:**
   - every "must be 0" row is 0, for every account: open positions, non-terminal orders, unresolved protection intents, live protection legs, open recovery cases, held reservations, in-flight trade intents and running campaign units;
   - the status listings contain no unfamiliar non-terminal value.

   Record cash, HWM, session equity and the config md5 from the output.
5. **Research dependency.** Confirm that no research job or dataset needs new Solana observations:
   - campaigns are 0 (D8);
   - the GENESIS shadow and research campaign jobs are disabled, according to the deploy logs;
   - no Solana warehouse back-fill is scheduled.

   Operator confirmation needed.
6. ⛔ **Set the flag:** in `/srv/quant/app/repo/.env`, the file the worker loads (`apps/worker/src/load-env.ts`).

   ```bash
   ssh scalesmiths 'cd /srv/quant/app/repo && sudo -u quant cp -p .env .env.bak-$(date -u +%Y%m%dT%H%M%SZ) && grep -c "^LEGACY_CRYPTO_MODE=" .env || true'
   ```

   - If the count is 0, append `LEGACY_CRYPTO_MODE=RETIRED`. If a line exists, replace only that line.
   - Edit only that key. Do not print or read other values.
   - **Stop and ask if the worker's systemd unit sets the same key**: `systemctl cat quant-worker` shows `Environment=` lines without values from `.env`.
7. ⛔ **Restart the worker only:** `sudo systemctl restart quant-worker`.
8. **Verify, within 10 minutes:**
   - **Worker log:** `legacy crypto retired: discovery off, new entries paused`, and no "not recognised" warning.
   - **Cycles:** `COMPLETE` every ~20 s, and `CycleRun.error` is null for retired cycles.
   - **Re-run the preflight SQL:**
     - `solana_observations_10m` falls to 0 once 10 minutes have passed since the restart;
     - `buys_10m` is 0;
     - every "must be 0" row is still 0;
     - cash, HWM, session equity and config md5 are **identical** to step 4.
   - `/api/health` is ok. The API is not restarted.
9. **Measure after 24 hours.** Re-run the D14 SQL ([`evidence/d14-production-readonly-20261118.sql`](evidence/d14-production-readonly-20261118.sql)) and `df -h /`. Expected (derived, not yet measured):
   - MarketObservation about 0 rows a day;
   - AgentDecision about 4,300 a day, down from about 526,000;
   - the next nightly dump no larger than the 18 Nov dump.

### Reversal

Set `LEGACY_CRYPTO_MODE=ACTIVE`, or restore the `.env.bak-*` copy, and restart the worker. Discovery resumes on the next cycle. No row was deleted or rewritten; capital, HWM, daily loss and drawdown were never touched. The integration test covers reversal.

## Not part of D3

These stay separate decisions:
- shortening the backup window or moving dumps off-host (D15/D16);
- the AgentDecision retention policy (D1);
- any archive or delete;
- the TITANIUM integration branch.
