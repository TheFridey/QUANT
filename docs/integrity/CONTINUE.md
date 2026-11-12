# OPERATION INTEGRITY — continuation

Ledger: [`STATUS.md`](STATUS.md). Instructions: `AGENTS.md`, `CLAUDE.md` (protected paths are hook-guarded; never create the unlock marker or work around the guard).

## Where things stand (12 Nov 2026)

Base: `origin/main` = `6eaac8e`. Branches are **stacked**, each on the previous, so the ledger stays linear:

| Branch | Findings | Head |
| --- | --- | --- |
| `integrity/f02-redis-revocation` | F02 (+F12 auth claim) | `e2a3490` |
| `integrity/f05-restore-target` | F05, F12 restore drill | `0f065a8` |
| `integrity/f03-research-holdouts` | F03, F06 (partial) | `1c9a9e5` |
| `integrity/f07-f08-dataset-identity` | F07, F08 | see `git log` |

Nothing is pushed, merged or deployed unless the PR links in STATUS.md say otherwise.

## Exact next action

1. If not yet done: `git push -u origin` each branch above and open draft PRs, bottom-up (`f02` → `main`, `f05` → `f02`, …). Do not merge.
2. F03 remainder: reserve legacy-CLI trials durably before computation (reuse `reserveTrials`/`declareLegacyTrials` from `@odin/evolution/campaign`), or retire `research-cli`/`intelligence-cli --record` in favour of campaigns. Then the legacy "3,000" trial reconciliation procedure (needs operator input on what the number represents; do not add it to any total).
3. F11 analytics: group `REALIZED_PNL` by economic exit (root of the remainder chain) before `performance.ts` counts trades; preserve cash/ledger/P&L totals.
4. F09: keyset pagination over `(decisionTime, id)` in `packages/evolution/src/campaign/bridge.ts`, bounded per page, fixed cohort.
5. F04: get an independent statistical review of the proposed degenerate-dispersion policy before changing `metrics.ts`; version the protocol.
6. F01 / F11 execution: blocked on explicit operator approval for protected paths.

## Local verification environment

- Windows, `core.autocrlf=true`. `.mjs` scripts with a shebang and CRLF fail to import under Vitest; rewritten scripts are LF.
- Docker is not running. A disposable PostgreSQL 18.3 cluster can be started from `C:\Program Files\PostgreSQL\18\bin` with `initdb -U odin_drill -A trust` into the session scratchpad and `pg_ctl -o "-p 55432 -c listen_addresses=127.0.0.1"`; databases `odin_test_integrity` (tests) and `odin_drill_source` (restore drill). Migrate with `DATABASE_URL=… pnpm db:deploy`. Run integration tests with `DATABASE_URL_TEST=postgresql://odin_drill@127.0.0.1:55432/odin_test_integrity` and `--no-file-parallelism`.
- No Redis locally; F02 cross-process tests use an in-process RESP stub over real TCP.
- Worker typecheck reads package `dist`: run `pnpm build:packages` after changing `packages/*`.
