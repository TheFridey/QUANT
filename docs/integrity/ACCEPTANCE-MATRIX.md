# Acceptance matrix — `integrity/phase-ii`

**Local environment:** Windows 11 on ARM, x64 Node 22.19.0, pnpm 10.33.4, `core.autocrlf=true`. PostgreSQL 18.3 runs as a disposable local cluster (port 55432, trust auth). Docker is not running, and there is no Redis.

**Not the target environment.** The repository targets Linux, PostgreSQL 16 and Redis 7. Linux CI is the qualifying run, and it has **not yet run** on this branch, because no PR has been opened.

| Check | Command | Result | Notes |
| --- | --- | --- | --- |
| Frozen install | `pnpm install --frozen-lockfile` | not rerun | no dependency or lockfile change in Phase II |
| Package compilation | `pnpm build:packages` | **PASS** | seccomp sandbox not built (x86_64 Linux only), as before |
| Full application build | `pnpm build` | **NOT VERIFIED** | `nest build` fails locally (SWC native binding, x64 Node on ARM; environmental, pre-existing). CI `build` job required. |
| TypeScript | `pnpm typecheck` | **PASS** | api, worker, web |
| Lint | `eslint` on every changed directory | **PASS** | repo-wide `pnpm lint` not rerun (Phase I: nested agent worktrees make it noisy locally) |
| Unit tests | `pnpm vitest run` (no DB) | at head `a6fa778`: **1,359 passed, 34 skipped, 0 failed** (LF scripts). The earlier run had **1,321 passed, 3 failed**, dispositioned as follows: | (1) `restore-drill*.test.ts` ×2: CRLF shebang import (environmental; with LF scripts **34/34 pass**). (2) `process-isolation.test.ts` ×3 under full-suite load: low-priority children starved past fixed test ceilings. Root-caused as a test-timing assumption, not a product defect. Fixed with an abort-driven test (`fa8b084`); **416/416** pass under concurrent load. |
| PostgreSQL integration | 38 `DATABASE_URL_TEST` files, `--no-file-parallelism`, fresh DB `odin_test_phase2` | **38/38 files, 216/216 tests** at `a6fa778` (212 before the review fixes) | 177 s; PostgreSQL 18.3, not 16 |
| Real Redis | — | **NOT VERIFIED** | no Redis locally; CI e2e uses real Redis |
| Fresh migration | `pnpm db:deploy` on an empty database | **PASS** | 31 migrations |
| Upgrade migration | — | **N/A** | Phase II adds no migration and no schema change |
| Browser e2e | — | **NOT VERIFIED** | CI `browser-e2e` required. API response shapes changed additively (F11 `economicTrades`, F09 `cohort`). |
| Research campaign regression | `campaign*.test.ts`, `campaign*.integration.test.ts` | **PASS** | included in the two runs above |
| Lifecycle fencing regression | `lifecycle-fence.integration.test.ts` and others | **PASS** | in the DB suite |
| Execution safety regression | trading-engine, risk-engine, worker executor suites | **PASS** | in the unit and DB runs; no execution code changed |
| Restore drill | `pg_dump -Fc` of the migrated, populated DB → `scripts/restore-verify.mjs` | **PASS** after the F12 fix | before the fix: `ok: false` (CyclePlan probe). After: `ok: true`, 75 tables, 26 probed, 0 drift, scratch database dropped |
| Statistical reference tests | `dsr.test.ts` | **PASS** 24/24 | independent reference implementation |
| Mutation tests | targeted, by hand | **9 of 9 killed** where applicable | F03 ×1, F09 ×2, F04 ×3, F10 ×1, F12 (inert-trigger case is a standing test). The F10 liveness mutation kills only 1 test on Windows (libuv job objects); the Linux CI run is needed. |

## Required before qualification

1. Draft [PR #79](https://github.com/TheFridey/QUANT/pull/79) is open, so CI runs: Linux, Node 22, PostgreSQL 16, Redis, `browser-e2e`, `build`. The result is pending.
2. Record the CI run URL and the counts here.
3. Any failure there blocks.

## Intermittent failures investigated

The process-isolation timing failures are recorded above. The Phase I API auth hook timeouts did not recur in these runs.
