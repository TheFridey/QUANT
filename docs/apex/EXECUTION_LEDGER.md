# APEX execution ledger

Durable checkpoint for Operation APEX. **On resume, reconstruct state from Git, CI and this file, in that order. Do not trust a chat summary.** Repository rules (`AGENTS.md`, `CLAUDE.md`) override everything here. Increment report: [`REPORT.md`](REPORT.md).

## Current state (2 Nov 2026)

- Active phase: **F (release) of increment 1**, waiting on CI and operator approval.
- Branch: `ccr-e2adef27-cgrrwj` (from `main` `c3b23e9`), pushed.
- Deployed: unchanged by APEX. Last recorded production deploy `d2d1526` (`NOT_VERIFIED` from this session).

## Commits

| Commit | Scope | Tests run | Result |
| --- | --- | --- | --- |
| `238399d` | ORACLE budget/autonomy fixes D-01, D-02, D-03 | `budget-store.test.ts`, `autonomy.test.ts`, `research-budget.integration.test.ts` (local Postgres); 19 of the 22 fail on the pre-fix code | pass |
| `2b5baae` | ASCEND-07 portfolio library and read-only CLI | `portfolio.test.ts`; look-ahead mutant killed; CLI smoke run on labelled fixtures | pass |
| `ae70f8e` | Restore verification drill + RUNBOOKS | `restore-drill.test.ts`; local drill; fail-closed controls | pass |
| docs commit | BASELINE, ledger, protected change requests | — | — |
| `621a789` | Fixes for reviewers A, B+C (H-1 BLOCK, M-1) and D+E | `pnpm test`: 883 passed, 25 skipped; typecheck and lint clean; drill re-run ok; `?dbname=` bypass refused | pass |

## Reviews

A: APPROVE WITH NOTES. B+C: BLOCK on H-1, fixed in `621a789`, re-review requested. D+E: APPROVE WITH NOTES. Details in [`REPORT.md`](REPORT.md) §4.

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

## Next actions (in order)

1. Confirm the B+C re-review verdict and record it above; confirm CI on the PR is green (unit, integration, e2e).
2. With operator approval: merge; deploy (packages, worker, API restart; no migration); run the restore drill on the latest production dump and `portfolio-cli` on SOL/USDC 1h + GATO 1h; record both here and in `docs/ascend/STATUS.md`.
3. With the unlock: PCR-1 (lifecycle fencing) first, then PCR-3, PCR-2, PCR-4, PCR-5.
4. Enforce `requiresApproval` in the research pipeline (non-protected; `packages/evolution/src/pipeline.ts`).
5. ASCEND-10 views for regimes, portfolio and the research registry (every number with its source and timestamp).
6. ASCEND-09 structured feedback over `TradeMemory` (pre-entry snapshots only for entry analysis).
