# APEX execution ledger

Durable checkpoint for Operation APEX. **On resume, reconstruct state from Git, CI and this file, in that order. Do not trust a chat summary.** Repository rules (`AGENTS.md`, `CLAUDE.md`) override everything here. Increment report: [`REPORT.md`](REPORT.md).

## Checkpoint 3 Nov 2026, ~09:00 UTC

The session was idle overnight: worker restarts plus agent rate limits. On resume, the state was rebuilt from Git and GitHub; local Postgres and Redis were restarted. `main` is still `4331e99`, and nothing is deployed.

| PR | Head | CI | Independent review | Status |
| --- | --- | --- | --- | --- |
| [#45](https://github.com/TheFridey/QUANT/pull/45) PCR-1 v3 | `6e2bfb6` | 947 passed, 1 by-design failure (booking stamp, which needs the protected patch) | Reviews 1–3: APPROVE WITH NOTES; all findings dispositioned | **Awaiting operator protected-edit approval.** Patch not applied; unlock not created |
| [#46](https://github.com/TheFridey/QUANT/pull/46) ledger | this commit | green on `885a21b` (run 41604989510) | — | docs only |
| [#47](https://github.com/TheFridey/QUANT/pull/47) ASCEND-08 | `1daaa5d` | **green on `1daaa5d`** (run 41604846691: test, build-packages, browser-e2e) | Review: APPROVE WITH NOTES (M1 tick throw / unbounded retries; M2 approvals not bound to a subject). Fixed in `a6b7bd5`. Re-review: **APPROVE WITH NOTES**, M1 and M2 resolved; its one LOW regression (500 instead of 400) fixed in `1daaa5d` | Local: 917 passed, 25 skipped. Draft; off by default |
| [#48](https://github.com/TheFridey/QUANT/pull/48) ASCEND-09 | `ef95b7f` | **green on `ef95b7f`** (run 41604903036: test, build-packages, browser-e2e) | Review: APPROVE WITH NOTES (M1 backfill stall; M2 post-fill decision leakage). Fixed in `eaf2e4b`. Re-review: **APPROVE WITH NOTES**; remaining LOWs documented | Local: 927 passed, 25 skipped. Draft. New migration `20261103090000`: run with `lock_timeout`, migrate first |

All three migrations are additive and must be applied **before** their code ships: `20261102100000` (ASCEND-08), `20261102120000` (PCR-1) and `20261102150000` plus `20261103090000` (ASCEND-09).

## Earlier state (2 Nov 2026, ~16:10 UTC)

| Item | State | Evidence |
| --- | --- | --- |
| PR [#44](https://github.com/TheFridey/QUANT/pull/44) (increment 1) | **Merged** to `main` as **`4331e99`** (merge commit; head `bff5000`) under operator approval, 2 Nov 2026 | CI run [41435827772](https://github.com/TheFridey/QUANT/actions/runs/41435827772) on `bff5000`: `test`, `browser-e2e`, `build-packages` all success; mergeable `clean`; 0 review threads; reviewer findings unchanged since the `2288780` verification (later commits docs-only) |
| Deployment of `4331e99` | **Not performed** (`BLOCKED_EXTERNAL`: no VPS access from this session; the operator's approval excludes deploying from here) | Procedure: [`DEPLOY_PR44.md`](DEPLOY_PR44.md). Last recorded production deploy is still `d2d1526` (`NOT_VERIFIED`) |
| PR [#45](https://github.com/TheFridey/QUANT/pull/45) PCR-1 (draft) | **v3 complete; protected-edit approval requested.** Non-protected half implemented; protected patch (`store.ts`, `strategy-allocations.ts`) prepared and **not applied**; unlock not created | Head `6e2bfb6`. Local: PCR-1 tests 43/44 (the 1 is the by-design booking stamp); full suite 922 passed, 1 expected failure, 25 skipped. CI on `a550c23`: 937 passed, 1 expected failure. Migration-first verified both ways (old code on the v3 schema: 822 passed; new code on the old schema: every PCR-1 test fails). Independent reviews 1, 2 and 3: APPROVE WITH NOTES (`docs/apex/pcr-1/RISK_REVIEW.md`) |
| PR [#47](https://github.com/TheFridey/QUANT/pull/47) ASCEND-08 (draft) | Bounded research loop, **off by default** (kill switch). Durable states, lease plus version claims, approval enforcement, persistent budget. Migration `20261102100000` adds 4 tables | Head `1de9fdf` (main merged in; schema reformat reverted so the diff is additive). Local: 908 passed, 25 skipped; typecheck and lint clean; 4 mutants caught. Independent review running |
| PR [#48](https://github.com/TheFridey/QUANT/pull/48) ASCEND-09 (draft) | Lot histories, point-in-time `TradeLotSnapshot` (append-only, written after commit), reconciled attribution, read-only API. Migration `20261102150000` adds 1 table | Head `237dbae`. Local: 914 passed, 25 skipped; typecheck and lint clean; 4 mutants caught. Independent review running |

Migration names across the open PRs: `20261102100000` (ASCEND-08), `20261102120000` (PCR-1), `20261102150000` (ASCEND-09). All are additive and independent of each other. `prisma migrate deploy` applies whichever are pending, in name order, whichever PR merges first.
| Designated branch | `ccr-e2adef27-cgrrwj` restarted from `main` `4331e99` for follow-up work (PR #44 is merged; no new commits stacked on merged history) | — |

Operator approvals recorded, 2 Nov 2026:
1. Merge PR #44 after green CI (done). Not approval to deploy from an environment without VPS access.
2. Push `apex/pcr-1-lifecycle-fence` and open a draft PR (done, #45). Do not apply the protected patch or create the unlock.
3. Separate focused PRs for ASCEND-08 and ASCEND-09, with independent reviewers. Not to be merged or deployed automatically.

## Commits

| Commit | Scope | Tests run | Result |
| --- | --- | --- | --- |
| `238399d` | ORACLE budget/autonomy fixes D-01, D-02, D-03 | `budget-store.test.ts`, `autonomy.test.ts`, `research-budget.integration.test.ts` (local Postgres); 19 of the 22 fail on the pre-fix code | pass |
| `2b5baae` | ASCEND-07 portfolio library and read-only CLI | `portfolio.test.ts`; look-ahead mutant killed; CLI smoke run on labelled fixtures | pass |
| `ae70f8e` | Restore verification drill + RUNBOOKS | `restore-drill.test.ts`; local drill; fail-closed controls | pass |
| docs commit | BASELINE, ledger, protected change requests | — | — |
| `621a789` | Fixes for reviewers A, B+C (H-1 BLOCK, M-1) and D+E | `pnpm test`: 883 passed, 25 skipped; typecheck and lint clean; drill re-run ok; `?dbname=` bypass refused | pass |
| `b3ebddc` | Increment report, ledger, drill runbook | docs only | — |
| `2288780` | B+C re-review LOW notes (inherited `PG*` env, bad encoding, IPv6) | `restore-drill.test.ts` (6); local drill ok | pass |

## Final verification of the code head `2288780`

| Check | Where | Result |
| --- | --- | --- |
| Unit + integration (vitest) | CI run [41432643380](https://github.com/TheFridey/QUANT/actions/runs/41432643380), job `test` | 163 files passed; **908 passed, 1 skipped** (CI has bubblewrap, so the sandbox tests run there) |
| Typecheck, lint, production build | same job | pass |
| Build packages | same run, job `build-packages` | pass |
| Browser e2e (Playwright, incl. axe a11y spec) | same run, job `browser-e2e` | **11 passed** on the first attempt |
| Unit + integration (local, Postgres 16 / Redis 7) | this session, at `621a789` (later commits: docs and the drill script only, whose test passes) | 159 files; 883 passed, 25 skipped (no bubblewrap locally) |
| Reviewer fix checklist | grep of every A, B+C and D+E finding against `2288780` | all 33 items present |

Outstanding warnings (none from this PR's code):
- GitHub Actions: Node.js 20 actions (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`) are being forced onto Node 24. The fix is a pinned-SHA bump in the CI workflow (protected path; PCR-5 candidate).
- CI Redis service container: `vm.overcommit_memory` is not enabled (runner sysctl; CI only).
- The Postgres `ERROR` lines in the CI log are the immutability tests deliberately hitting append-only triggers.

## Reviews

A: APPROVE WITH NOTES. B+C: BLOCK on H-1; fixed in `621a789`; **re-review APPROVE WITH NOTES** (it attacked the drill with `?dbname=`, `?options=`, encoded and conninfo variants, all refused, with `odin`, `odin_test` and `postgres` snapshotted unchanged). Its three LOW re-review notes (inherited `PG*` variables, malformed percent-encoding, IPv6 brackets) are fixed in the following commit. D+E: APPROVE WITH NOTES. Details in [`REPORT.md`](REPORT.md) §4.

## Blockers

| Blocker | Type | What unblocks it |
| --- | --- | --- |
| VPS inspection, deploy, production smoke tests, production restore drill | `BLOCKED_EXTERNAL` | A session with VPS access (SSH or an attached computer); none is configured |
| Merging to `main` and deploying | `BLOCKED_APPROVAL` | Operator approval (standing rule in `docs/ascend/singularity/README.md`) |
| PCR-1 to PCR-5 (protected paths) | `BLOCKED_APPROVAL` | Operator-created unlock; see [`PROTECTED_CHANGE_REQUESTS.md`](PROTECTED_CHANGE_REQUESTS.md) |
| New historical data (FX, longer histories, liquidity history) | `BLOCKED_EXTERNAL` | Provider network access; an operator purchase decision for paid tiers |
| Real-data portfolio study | `BLOCKED_EXTERNAL` here | Run `portfolio-cli` on the VPS warehouse (read-only) |

## Known, accepted residuals

- Research-budget serialisation is in-process only: valid while a single API process runs pipelines (M-2).
- A calendar-day budget allows up to about 2× the cap across UTC midnight.
- `requiresApproval` from the autonomy gate is not yet consumed by the pipeline (pre-existing).

## Prepared outside this PR

| Workstream | State | Where |
| --- | --- | --- |
| **PCR-1** pending-exit lot fence | Defect **reproduced** on `c3b23e9`: a stale protective NET_CLOSE sold a newly opened lot (−$0.69 on $100). The non-protected half (nullable `Order.positionLifecycleId`, migration `20261102120000`, reason `EXIT_LIFECYCLE_MISMATCH`, settle fence) is implemented. The protected stamping in the trading-engine store is a patch only (`git apply --check` clean, **not applied**). Branch tests: 828 passed, 1 expected failure (stamping). Independent risk review: APPROVE WITH NOTES for both halves; findings dispositioned | Local branch `apex/pcr-1-lifecycle-fence` at `f185b3d` (based on `c3b23e9`; **not pushed**: pushing a second branch needs operator permission). Docs: `docs/apex/pcr-1/{ANALYSIS,RISK_REVIEW}.md`, `store-stamping.patch` |
| PCR-1 follow-ups | **F-PCR1-a**: protection retry reads the lot fence outside the account lock and fills immediately (`apps/worker/src/executor/protect.ts`). **F-PCR1-b**: a lot reduced then re-increased keeps its id, so it is not fenced (needs a lot version) | Not started |
| ASCEND-08 | `runBoundedResearchCycle` has **no production caller**, so no autonomous ORACLE loop runs today. The pipeline is reached only through an `ADMIN` API request, which is itself the human initiation. Next: when an autonomous scheduler is added, it must consult `assertActionAllowed` and refuse `requiresApproval` actions without a recorded approval row; plus a programme-wide experiment counter feeding DSR | Plan only |
| ASCEND-09 | `TradeMemory` is written per fill (`apps/worker/src/stage-runner.ts`), with an `AFTER` row stamped at fill time and no exit rationale, MAE/MFE or regime link. Next: a lot-keyed forensic timeline (entry fills, exits, decisions, costs, MAE/MFE) built read-only from the ledger and `trade-autopsy`, with the temporal boundary enforced (entry view uses only rows captured at or before the entry fill) | Plan only |
| Production hardening | Blocked on VPS access: backup schedule, retention and encryption check; production restore drill; health and readiness probes; soak. Unblocked: research-budget lock for multiple API processes (M-2) if a replica is added; GitHub Actions Node 24 SHA bump (protected workflow, PCR-5) | Plan only |

## Next actions (in order)

1. CI on PR #44 is green (above). The PCR-1 defect is reproduced by an integration test and analysed in `docs/apex/pcr-1/ANALYSIS.md` on the separate branch `apex/pcr-1-lifecycle-fence` (kept out of this PR).
2. **Operator approval, 2 Nov 2026: merge PR #44 once the latest commit passes all required CI and the review findings remain resolved. This is not approval to deploy from an environment without VPS access.** Deployment procedure: [`DEPLOY_PR44.md`](DEPLOY_PR44.md). Then, through the authorised process: deploy (packages, worker, API restart; no migration); run the restore drill on the latest production dump and `portfolio-cli` on SOL/USDC 1h + GATO 1h; record both here and in `docs/ascend/STATUS.md`.
3. With the unlock: PCR-1 (lifecycle fencing) first, then PCR-3, PCR-2, PCR-4, PCR-5.
4. Enforce `requiresApproval` in the research pipeline (non-protected; `packages/evolution/src/pipeline.ts`).
5. ASCEND-10 views for regimes, portfolio and the research registry (every number with its source and timestamp).
6. ASCEND-09 structured feedback over `TradeMemory` (pre-entry snapshots only for entry analysis).
