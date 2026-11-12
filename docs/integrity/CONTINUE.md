# OPERATION INTEGRITY — continuation

**Ledger:** [`STATUS.md`](STATUS.md).
**Instructions:** `AGENTS.md`, `CLAUDE.md`. Protected paths are hook-guarded: never create the unlock marker or work around the guard.

## Where things stand (12 Nov 2026, end of Phase II session)

- **Production:** `2cc6627` (Phase I).
- **`main`:** `33c6a4a`.
- **Phase II:** everything is on **`integrity/phase-ii`**, pushed to origin, off `33c6a4a`, one linear branch, not merged and not deployed.

| Commit | Finding |
| --- | --- |
| `aceb735` | F03/F06: open/close study accounting; legacy holdout identity retired |
| `56612f6` | F09: complete keyset cohort |
| `bab301b` | F04: DSR `dsr-2.0.0` |
| `e6daa04` | F11: economic-trade analytics |
| `f41438f`, `fa8b084` | F10: process guarantees |
| `c767d50` | F12: restore-drill CyclePlan probe |
| `a6fa778` | safety-review fixes (H1 CLI hang, M1/M2 trial undercounts, L2, L5) |
| (docs commits) | F12 reconciliation, matrix, deployment plan, release readiness |

## Exact next action

1. Done: [PR #79](https://github.com/TheFridey/QUANT/pull/79) was merged (`bed2f36`) with CI green and deployed 12 Nov 2026 (LEDGER checkpoint 9). Still open: the production restore drill on `quant-20261112T170409Z.dump` (operator credentials). Historical note on the earlier step: read its CI on Linux, PostgreSQL 16 and Redis, including `browser-e2e` and `build`. Record the results in `ACCEPTANCE-MATRIX.md`. Pay particular attention to the two F10 SIGKILL descendant tests, which prove the guard only on Linux.
2. Operator decisions, listed in `RELEASE-READINESS.md`:
   - legacy trial declaration (answer the questionnaire in `F03-F06-RESEARCH-INTEGRITY.md`);
   - F11 protected execution increment (approval package in `F11-ECONOMIC-TRADE-IDENTITY.md`);
   - OS isolation on the VPS (recipe in `F10-INVESTIGATION.md`);
   - campaign models registered under dsr-1.
3. After CI is green and the PR is approved, merge, then deploy per `DEPLOYMENT-PLAN.md`. Both steps need the operator.

## Local verification environment

- Windows ARM with x64 Node 22.19; `core.autocrlf=true`.
  - `.mjs` scripts with a shebang need LF to import under Vitest: run `sed -i 's/\r$//' scripts/*.mjs`, then `git checkout --` afterwards.
  - `nest build` fails locally (SWC binding).
- **Disposable PostgreSQL 18.3:**
  - Start: `C:\Program Files\PostgreSQL\18\bin\pg_ctl -D <scratchpad>/pg -o "-p 55432 -c listen_addresses=127.0.0.1" start`.
  - Databases: `odin_test_phase2` (fresh, used for Phase II verification); `odin_test_integrity` (older, holds a stale PCR-1 migration record; do not use).
  - Run integration tests with `DATABASE_URL` and `DATABASE_URL_TEST` set to `postgresql://odin_drill@127.0.0.1:55432/odin_test_phase2` and `--no-file-parallelism`.
- No Redis and no Docker.
- Worker typecheck reads package `dist`: run `pnpm build:packages` after changing `packages/*`.
