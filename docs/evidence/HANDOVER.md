# OPERATION EVIDENCE: handover (11 Nov 2026)

For a fresh session. Verify the branch and files before relying on anything here.

## Where things are

- Branch `evidence/research-campaigns`, 13 commits on top of `origin/main` `8317aff`. Merged as `eba979f` ([PR #71](https://github.com/TheFridey/QUANT/pull/71)) and deployed on 11 Nov 2026 (record: `docs/horizon/LEDGER.md`, checkpoint 7). The worker job and the shadow service are off. 
- Design: [`ADR-0001-research-campaigns.md`](ADR-0001-research-campaigns.md) (includes the review outcome and what was not fixed). Operations: [`../RUNBOOKS.md`](../RUNBOOKS.md), "Research campaigns". Demonstration: [`demo/README.md`](demo/README.md), observed run in [`demo/RESULTS.md`](demo/RESULTS.md).
- Code: `packages/evolution/src/campaign/` (library), `apps/worker/src/research/campaign-*.ts` and `network-guard.ts` (CLI, runner, evaluator), `apps/worker/src/campaign-job.ts` (worker job, off by default), `apps/api/src/campaigns.controller.ts`, `apps/web/src/components/terminal/sections/research-campaigns.tsx`, migration `20261110120000_evidence_research_campaigns`.
- No protected path was edited. `.claude/protected-edits.unlock` existed before this work; it was not created or used here.

## Verification (run by Claude on this branch, local Windows machine)

| Check | Command | Result |
| --- | --- | --- |
| Unit | `pnpm test` | 1,215 passed, 34 skipped. One suite fails before and after this work: `packages/shared/src/restore-drill.test.ts` (SyntaxError loading an `.mjs` script on Windows). |
| Integration | `DATABASE_URL_TEST=…/odin_test pnpm vitest run --project integration` | 30 files, 140 tests passed (18 are the campaign tests), on a throwaway local PostgreSQL 18 cluster. |
| Typecheck | `pnpm typecheck` | pass |
| Lint | `pnpm exec eslint apps packages` | clean. Plain `pnpm lint` also scans the local, git-excluded `.claude/worktrees/` and reports their errors. |
| Demonstration | `campaign-cli` end to end, real evaluator process | 12 units in 33 s; see `demo/RESULTS.md`. |
| Browser journey | `apps/web/e2e/research-campaigns.spec.ts` | Passed in CI (`browser-e2e`, first run of PR #71). Not run locally: the API needs Redis and Docker would not stay up. |
| Build | `pnpm build` | Packages and web build. `nest build` for API and worker fails locally (`@swc/core` will not load on this machine); both were compiled with `tsc -p … --outDir dist/src` instead. CI's build is not verified for this branch. |
| Migration | `prisma migrate deploy` | Applied cleanly to empty PostgreSQL 16 and 18 databases. Not applied to production. |

Baseline before the work (main `8317aff`): 1,167 unit tests passed with the same one failing suite; integration tests are skipped locally by default because `DATABASE_URL_TEST` is not set in `.env`.

## Requirements

| # | Requirement | State | Note |
| --- | --- | --- | --- |
| 1 | Baseline and implementation map | Done | Baseline above; map in the ADR "Context". |
| 2 | Durable, resumable campaigns | Done | Immutable declaration, run and results; mutable execution state; retry and rerun are distinct. |
| 3 | Trial and holdout accounting | Done, with stated residuals | Reserve-before-run ledger; authorised, once-only holdout with a lost-result state. Open: the deflated-Sharpe variance term (ADR "Not fixed" 1). |
| 4 | Verdict composition | Done | One defect demonstrated and fixed (consumed holdout reported as pending); mixed-result tests. |
| 5 | Bounded execution | Done | CLI and opt-in worker job; limits, leases, cancellation, isolated evaluator. Heartbeat and real child process are exercised by the demonstration, not the test suite. |
| 6 | Bridge to shadow | Partial | Works for ML 2.0 models on 24/7 markets. **Rule-based strategies and session-calendar (gold/FX) models have no prospective route.** No campaign model has resolved an outcome; resolution is covered by the existing GENESIS tests. |
| 7 | Evidence in the product | Done | API tests pass; the browser journey passed in CI. Not looked at by a person. |
| 8 | Verification | Done, with one CI-only item | The browser journey ran in CI only. The first CI `test` run failed on one campaign test that depended on a marginal hypothesis passing deflation; the test was made robust. |
| 9 | Completion | Done | Commits, ADR, runbook, demonstration, this handover. |

## Blocked or waiting on the operator

- **Real campaign on gold/FX**: needs warehouse data, which is only in production. Command shape is in `demo/README.md`. Expect the recorded result (no candidate) to repeat; the campaign makes it reproducible.
- **Declare the unrecorded legacy trials** in production: `campaign-cli declare-legacy-trials --count N --by NAME --note "…"`. N is **not** 3,000: that figure was a cumulative count including ~2,454 registry rows the ledger already counts; the unrecorded part is roughly 550 (answer the questionnaire in [`docs/integrity/F03-F06-RESEARCH-INTEGRITY.md`](../integrity/F03-F06-RESEARCH-INTEGRITY.md) first). Until then the production programme count understates by about that much.
- **Decisions**: the deflated-Sharpe variance floor; whether a lost holdout may be recomputed; the staleness limit and observation length to use when a real model is first registered.
- `quant-safety-reviewer`: CHANGES REQUESTED (small) on `fc8ffd8`; after the fixes in `79b6ffe`, **APPROVE WITH NOTES** on `8de63d6`. Its two low notes are addressed in the commit after that (minimum-sample guard moved off the closing paths; runbook wording on the CLI environment). Carried notes: no test enforces "no writes to trading tables" (the import-boundary test cannot see Prisma capability), and the CLI started by the worker job is not detached, so a ceiling kill can leave an evaluator running until its own runtime limit.

## Next work, in order of value

1. Extend the shadow service to session calendars and volume-less feature sets, so a gold or FX model can be observed.
2. A prospective scorer for rule-based strategies.
3. Decide and, if agreed, apply the deflated-Sharpe variance floor.
4. An integration test that uses the real child-process evaluator and a real heartbeat.

## Local leftovers (safe to remove)

- Docker containers `odin-evidence-test-pg` (port 15432) and `odin-evidence-test-redis` (16379), both stopped.
- A throwaway PostgreSQL 18 cluster under the session scratchpad, stopped (it used port 15432 ; databases `odin_test`, `odin_demo`, `odin_demo2`, `odin_e2e`).
- `apps/api/dist` and `apps/worker/dist` built with `tsc`, and `apps/web/.next` built with `NEXT_PUBLIC_API_URL=http://127.0.0.1:14318`. Rebuild before running the app locally.
- The integration tests assume a test database whose programme trial count is below about a million; the ledger is append-only, so recreate the test database rather than trying to clear it.
