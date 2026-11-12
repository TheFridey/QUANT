# OPERATION INTEGRITY — finding ledger

Audit baseline: `main` at `6eaac8e` (docs-only merge over production code `eba979f`). Remediation started 12 Nov 2026 from `origin/main` = `6eaac8e` (unchanged since the audit).

PAPER only. Nothing here enables live money, changes `EXECUTION_MODE`, loosens risk limits, consumes production holdouts or deploys.

Classifications: `FIXED` · `ALREADY_FIXED` · `PARTIAL` · `BLOCKED` · `NOT_A_DEFECT` · `OPEN` (not yet worked).

## Baseline (this session, Windows 11, Node 22.19.0, pnpm 10.33.4)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build:packages` | pass |
| `pnpm vitest run` (pre-change) | 1,195 passed, 196 skipped, 5 files failed to collect. One confirmed environmental: `packages/shared/src/restore-drill.test.ts` imports `scripts/restore-verify.mjs`, which this Windows `core.autocrlf=true` checkout has with CRLF after the shebang (`SyntaxError: Invalid or unexpected token`); CI (Linux, LF) is unaffected. The other four are listed below once identified. |
| Skips | DB integration tests skip without `DATABASE_URL_TEST` naming an `odin_test` database; Docker is not running here, so no Postgres/Redis is available locally. Skips are not passes. |

## Findings

| ID | Sev | Verified problem / current status | Branch · commit | Tests executed | Review | Remaining blocker |
| --- | --- | --- | --- | --- | --- | --- |
| F02 | HIGH | **Confirmed** at `6eaac8e`: `isTokenRevoked` returned `false` in backoff and on Redis errors; a scratch test showed `AuthService.verify` accepting a signed token on connect failure and during backoff. `docs/STATUS.md` L2 claimed 503. Logout sat behind the global guard, so a fail-closed guard alone would have blocked recording the local revocation. **FIXED**: unknown status throws `RevocationStatusUnavailableError` → HTTP 503 / socket `AUTH_UNAVAILABLE` / revalidation disconnect; local revocations stay 401; unconfigured mode unchanged; queued writes flushed before reads and kept on flush failure; logout `@Public` (own signature check) and reports durability. | `integrity/f02-redis-revocation` · see git log | `token-revocation.failclosed.test.ts` (11), `auth-hardening.test.ts` (8, fail-open assertions inverted), `terminal-gateway.test.ts` (9), `token-revocation.test.ts` (4): 32 passed | Self-review; not a protected path | Real-Redis run not possible locally (Docker down); cross-process tests use a RESP stub over real TCP with real ioredis. CI e2e runs against real Redis. |
| F05 | HIGH | OPEN | | | | |
| F01 | HIGH | OPEN (protected; PR #45 draft) | | | | |
| F03 | HIGH | OPEN | | | | |
| F06 | MED | OPEN | | | | |
| F07 | MED | OPEN | | | | |
| F08 | MED | OPEN | | | | |
| F04 | HIGH | OPEN | | | | |
| F09 | MED | OPEN | | | | |
| F10 | MED | OPEN | | | | |
| F11 | MED | OPEN | | | | |
| F12 | LOW | IN PROGRESS: STATUS L2 auth claim corrected (F02) | | | | |
