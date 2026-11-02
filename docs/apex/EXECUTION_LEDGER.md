# APEX execution ledger

Durable checkpoint for Operation APEX. **On resume, reconstruct state from Git, CI and this file, in that order. Do not trust a chat summary.** Repository rules (`AGENTS.md`, `CLAUDE.md`) override everything here. Increment report: [`REPORT.md`](REPORT.md).

## Current state (2 Nov 2026)

- Active phase: **F (release) of increment 1**. PR [#44](https://github.com/TheFridey/QUANT/pull/44) is **ready for merge pending operator approval**: CI green on code head `2288780`, mergeable (`clean`), every reviewer finding fixed or documented, no open review threads.
- Branch: `ccr-e2adef27-cgrrwj` (from `main` `c3b23e9`), pushed. Draft PR #44.
- Deployed: unchanged by APEX. Last recorded production deploy `d2d1526` (`NOT_VERIFIED` from this session).

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
- `requiresApproval` from the autonomy gate is not yet consumed by the operator-initiated pipeline (pre-existing). The ASCEND-08 loop does enforce it.

## Prepared outside this PR

| Workstream | State | Where |
| --- | --- | --- |
| **PCR-1** pending-exit lot fence | Defect **reproduced** on `c3b23e9`: a stale protective NET_CLOSE sold a newly opened lot (−$0.69 on $100). The non-protected half (nullable `Order.positionLifecycleId`, migration `20261102120000`, reason `EXIT_LIFECYCLE_MISMATCH`, settle fence) is implemented. The protected stamping in the trading-engine store is a patch only (`git apply --check` clean, **not applied**). Branch tests: 828 passed, 1 expected failure (stamping). Independent risk review: APPROVE WITH NOTES for both halves; findings dispositioned | Local branch `apex/pcr-1-lifecycle-fence` at `f185b3d` (based on `c3b23e9`; **not pushed**: pushing a second branch needs operator permission). Docs: `docs/apex/pcr-1/{ANALYSIS,RISK_REVIEW}.md`, `store-stamping.patch` |
| PCR-1 follow-ups | **F-PCR1-a**: protection retry reads the lot fence outside the account lock and fills immediately (`apps/worker/src/executor/protect.ts`). **F-PCR1-b**: a lot reduced then re-increased keeps its id, so it is not fenced (needs a lot version) | Not started |
| ASCEND-08 | **Bounded autonomous research loop implemented** (off by default: `ResearchLoopControl.enabled` false, autonomy ≥ 2 required). Durable experiments, append-only events and approvals, leases with version CAS, approval enforcement (`BLOCKED_APPROVAL`), persistent UTC-day budget, daily/concurrency caps, retry ceiling, separated reviewer, programme-wide experiment counts; worker job `odin.research-loop`, ADMIN API. Migration `20261102100000_ascend08_research_loop` (additive). `pnpm test` 163 files / 908 passed / 25 skipped; typecheck and lint clean; mutants M1–M4 killed. Not pushed; needs operator review, CI and a production migration approval | Local branch `apex/ascend-08-research-loop` at `6dd6686` (from `bff5000`). Docs: [`ASCEND-08.md`](ASCEND-08.md) |
| ASCEND-09 | `TradeMemory` is written per fill (`apps/worker/src/stage-runner.ts`), with an `AFTER` row stamped at fill time and no exit rationale, MAE/MFE or regime link. Next: a lot-keyed forensic timeline (entry fills, exits, decisions, costs, MAE/MFE) built read-only from the ledger and `trade-autopsy`, with the temporal boundary enforced (entry view uses only rows captured at or before the entry fill) | Plan only |
| Production hardening | Blocked on VPS access: backup schedule, retention and encryption check; production restore drill; health and readiness probes; soak. Unblocked: research-budget lock for multiple API processes (M-2) if a replica is added; GitHub Actions Node 24 SHA bump (protected workflow, PCR-5) | Plan only |

## Next actions (in order)

1. CI on PR #44 is green (above). The PCR-1 defect is reproduced by an integration test and analysed in `docs/apex/pcr-1/ANALYSIS.md` on the separate branch `apex/pcr-1-lifecycle-fence` (kept out of this PR).
2. **Operator approval, 2 Nov 2026: merge PR #44 once the latest commit passes all required CI and the review findings remain resolved. This is not approval to deploy from an environment without VPS access.** Deployment procedure: [`DEPLOY_PR44.md`](DEPLOY_PR44.md). Then, through the authorised process: deploy (packages, worker, API restart; no migration); run the restore drill on the latest production dump and `portfolio-cli` on SOL/USDC 1h + GATO 1h; record both here and in `docs/ascend/STATUS.md`.
3. With the unlock: PCR-1 (lifecycle fencing) first, then PCR-3, PCR-2, PCR-4, PCR-5.
4. Enforce `requiresApproval` in the research pipeline (non-protected; `packages/evolution/src/pipeline.ts`).
5. ASCEND-10 views for regimes, portfolio and the research registry (every number with its source and timestamp).
6. ASCEND-09 structured feedback over `TradeMemory` (pre-entry snapshots only for entry analysis).
