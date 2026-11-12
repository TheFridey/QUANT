# OPERATION INTEGRITY — finding ledger

Audit baseline: `main` at `6eaac8e` (docs-only merge over production code `eba979f`). Remediation started 12 Nov 2026 from `origin/main` = `6eaac8e` (unchanged since the audit).

PAPER only. Nothing here enables live money, changes `EXECUTION_MODE`, loosens risk limits, consumes production holdouts or deploys.

Classifications: `FIXED` · `ALREADY_FIXED` · `PARTIAL` · `BLOCKED` · `NOT_A_DEFECT` · `OPEN` (not yet worked).

## Baseline (this session, Windows 11, Node 22.19.0, pnpm 10.33.4)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build:packages` | pass |
| `pnpm vitest run` (pre-change, run concurrently with install/build) | 1,195 passed, 196 skipped, 5 files failed. One confirmed environmental: `packages/shared/src/restore-drill.test.ts` imports `scripts/restore-verify.mjs`, which this Windows `core.autocrlf=true` checkout has with CRLF after the shebang (`SyntaxError: Invalid or unexpected token`); CI (Linux, LF) is unaffected. The other four were not captured (output truncated) and did **not** recur: the next full run (F02+F05 tree, no concurrent build) was 1,258 passed, 174 skipped, 0 failed. Treat them as unexplained load-related failures, not as proven baseline. |
| Skips | DB integration tests skip without `DATABASE_URL_TEST` naming an `odin_test` database. Docker is not running; a disposable PostgreSQL **18.3** cluster was started from the local install in the session scratchpad (port 55432, 127.0.0.1 only, trust auth, databases `odin_test_integrity` and `odin_drill_source`). The repo targets PostgreSQL 16, so this is close to but not identical with CI. No Redis is available. |
| DB integration (`DATABASE_URL_TEST=…/odin_test_integrity`, all 33 `DATABASE_URL_TEST` files, `--no-file-parallelism`) | 151 passed, 0 failed |

## Findings

| ID | Sev | Verified problem / current status | Branch · commit | Tests executed | Review | Remaining blocker |
| --- | --- | --- | --- | --- | --- | --- |
| F02 | HIGH | **Confirmed** at `6eaac8e`: `isTokenRevoked` returned `false` in backoff and on Redis errors; a scratch test showed `AuthService.verify` accepting a signed token on connect failure and during backoff. `docs/STATUS.md` L2 claimed 503. Logout sat behind the global guard, so a fail-closed guard alone would have blocked recording the local revocation. **FIXED**: unknown status throws `RevocationStatusUnavailableError` → HTTP 503 / socket `AUTH_UNAVAILABLE` / revalidation disconnect; local revocations stay 401; unconfigured mode unchanged; queued writes flushed before reads and kept on flush failure; logout `@Public` (own signature check) and reports durability. | `integrity/f02-redis-revocation` · see git log | `token-revocation.failclosed.test.ts` (11), `auth-hardening.test.ts` (8, fail-open assertions inverted), `terminal-gateway.test.ts` (9), `token-revocation.test.ts` (4): 32 passed | Self-review; not a protected path | Real-Redis run not possible locally (Docker down); cross-process tests use a RESP stub over real TCP with real ioredis. CI e2e runs against real Redis. |
| F05 | HIGH | **Confirmed** by reading `scripts/backup-restore-nonprod.mjs` at `6eaac8e`: only `new URL(url).pathname` was checked, then the full URI (password included) went to `psql`/`pg_dump` on argv and restore ran `DROP SCHEMA public CASCADE`; `?dbname=`/`?host=`/`?service=` could redirect it. No destructive SQL was run to show this. **FIXED**: the helper is retired to a stub that imports nothing able to spawn a process and exits 2; `restore-verify.mjs` (already strict: libpq env only, generated scratch DB, `current_database()` check) is the replacement; `main` now takes an injectable spawn so ordering is tested. | `integrity/f05-restore-target` (stacked on F02) | `restore-drill.f05.test.ts` (25, all process calls mocked; legacy stub run as a real child), `restore-drill.test.ts` (6). **Real drill** on the disposable cluster: `pg_dump -Fc` of a migrated fixture DB → `restore-verify.mjs` → `"ok": true`, 75 tables, 0 drift, scratch DB dropped | Self-review; not a protected path | None for the repair. A production-dump drill remains `NOT_VERIFIED` (needs VPS access and operator approval). |
| F01 | HIGH | OPEN (protected; PR #45 draft) | | | | |
| F03 | HIGH | OPEN | | | | |
| F06 | MED | OPEN | | | | |
| F07 | MED | OPEN | | | | |
| F08 | MED | OPEN | | | | |
| F04 | HIGH | OPEN | | | | |
| F09 | MED | OPEN | | | | |
| F10 | MED | OPEN | | | | |
| F11 | MED | OPEN | | | | |
| F12 | LOW | PARTIAL. Done: STATUS L2 auth claim corrected (F02); RUNBOOKS no longer calls the legacy helper fit for test resets (F05); restore drill extended to the 11 campaign/GENESIS append-only tables and the 2 guarded mutable-state tables, with behaviour probes (DELETE when rows exist; `TRUNCATE … CASCADE` that must be rejected naming that table). The first real drill exposed that a plain TRUNCATE fails on FKs before triggers fire (false "not rejected"); fixed and re-run green. Not done: STATUS/HANDOVER/LEDGER current-vs-historical split; deployed-vs-not-deployed migration reconciliation; CI/build claim reconciliation. | F02/F05 branches | as F02/F05 | — | — |
