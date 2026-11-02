# APEX engineering report: increment 1

**Status: Operation APEX is not complete.** This report covers the first increment (2 Nov 2026), on branch `ccr-e2adef27-cgrrwj`. Most of the programme is blocked on operator approval (protected paths, merge, deploy) or on access this session does not have (the VPS, provider networks). Nothing here is deployed. QUANT has no validated trading edge; nothing in this increment changes that.

## 1. Original state

See [`BASELINE.md`](BASELINE.md): `main` at `c3b23e9`, CI green, 822 tests passing locally. ASCEND-00 to 06 were implemented to the extent recorded in [`../ascend/STATUS.md`](../ascend/STATUS.md). ASCEND-07 was missing. ASCEND-08 existed with three control defects. ASCEND-09 to 11 were partial.

## 2. Changes implemented

| Commit | Change | Evidence |
| --- | --- | --- |
| `238399d` | D-01: research model budget is cumulative per UTC day from `ModelUsageLog` (was per request). D-02: an unreadable spend file fails closed and writes are atomic. D-03: the autonomy gate is an explicit deny-by-default matrix, and risk-limit mutation is hard-disabled and refused at the API | `VERIFIED_UNIT`, `VERIFIED_INTEGRATION` (local Postgres); 19 of the 22 new tests fail on the pre-fix code |
| `2b5baae`, `621a789` | ASCEND-07 portfolio research library (`portfolio-1.1.0`) and read-only `portfolio-cli` | `VERIFIED_UNIT` (31 tests incl. numpy reference, look-ahead mutant killed); CLI smoke-run on labelled fixtures only |
| `ae70f8e`, `621a789` | Isolated restore verification drill; RUNBOOKS restore section | `VERIFIED_UNIT` (5 guard tests); local drill ok; three fail-closed controls |
| `621a789` | Review fixes: drill target hijack via `?dbname=` (H-1), per-call spend persistence (M-1), portfolio statistical fixes, strict CLI arguments, per-day budget label in the UI | as above |
| docs | `BASELINE.md`, `EXECUTION_LEDGER.md`, `PROTECTED_CHANGE_REQUESTS.md`, this report; ASCEND status rows | — |

Files changed: `packages/evolution/src/{budget-store,router,autonomy}.ts` (+ tests), `apps/api/src/evolution.service.ts` (+ `research-budget.integration.test.ts`), `packages/backtest/src/research/portfolio.ts` (+ test, index export), `apps/worker/src/research/{portfolio-cli,portfolio-args}.ts` (+ test), `scripts/restore-verify.mjs` (+ `packages/shared/src/restore-drill.test.ts`), `apps/web/src/components/terminal/sections/evolution-sections.tsx` (one label), docs. **No protected path was modified.** No `EXECUTION_MODE`, live-money, risk-default or promotion change was made.

## 3. Test results (executed)

| Run | Result |
| --- | --- |
| `pnpm test` (local Postgres 16, Redis 7) at `621a789` | 159 files passed, 4 skipped; **883 passed, 25 skipped** (the skips are sandbox tests that need bubblewrap, `VERIFIED_CI` elsewhere) |
| `pnpm typecheck`, `pnpm lint` | exit 0 |
| `pnpm audit --prod` (baseline) | no known vulnerabilities |
| CI on the branch | pending: see the PR |
| Playwright e2e / a11y | not run locally; CI runs them |

## 4. Independent review

Three reviewers ran in separate contexts on the actual diff, each running code where it could:

| Reviewer | Verdict | Material findings | Outcome |
| --- | --- | --- | --- |
| A, quantitative validity | APPROVE WITH NOTES | HIGH: shrinkage gave a frozen (zero-variance) feed the largest inverse-vol weight. MEDIUM: shrunk volatilities were distorted ~20× for low-vol assets; an all-skipped backtest looked valid; scenario keys did not match warehouse cohorts. LOW: VaR rounding, missing drift/cost tests, input validation | All fixed in `621a789`, with tests |
| B+C, safety and security | **BLOCK** (H-1 only) | HIGH H-1: `?dbname=` let the restore drill write into an application database. MEDIUM: spend persisted only after a run (M-1); serialisation is single-process (M-2). LOW: drill completeness checks, password on argv | H-1, M-1 and the LOW drill items fixed in `621a789`; M-2 documented. Re-review: see the ledger |
| D+E, architecture and product | APPROVE WITH NOTES | Drill pass criteria not fully enforced; ExperimentReport missing; single-process assumption undocumented; ASCEND STATUS stale; budget label; CLI defaults | Fixed or documented |

Not fixed, recorded: per-day budget spend can reach about 2× the cap across UTC midnight (by design of a calendar window); the router can overshoot the cap by a couple of retried calls (pre-existing, about $0.02 to $0.04); a provider call that times out is not aborted and may be billed but under-counted (pre-existing); the level-2 "approval required" for forging is described by the gate but no caller enforces `requiresApproval` (pre-existing; tracked).

## 5. Research results

No new research result. A real-data portfolio study was not possible from this session: GeckoTerminal was refused by the session's network policy, and the warehouse lives on the VPS. All portfolio numbers produced in this session come from seeded fixtures and are not evidence. Statistical limitations of the module are listed in its report output (in-sample allocations, unstable covariances, hypothetical shocks).

## 6. Infrastructure, deployment and production

- Deployment: **not performed** (`BLOCKED_APPROVAL` and `BLOCKED_EXTERNAL`: no VPS access, and the standing rule requires operator approval).
- Deployed commit: unchanged. Last recorded `d2d1526`, `NOT_VERIFIED` from here.
- Migrations: none added.
- Production smoke tests, soak, the backup schedule and the production restore drill: `NOT_VERIFIED`.

## 7. Required approvals

1. Merge the PR for this branch after green CI.
2. Deploy: rebuild packages, worker and API; restart the API (the D-01/D-03 code runs in the API). No migration.
3. Run on the VPS: the restore drill on the latest dump, and `portfolio-cli` on SOL/USDC 1h + GATO 1h (read-only).
4. Unlock for PCR-1 to PCR-5 ([`PROTECTED_CHANGE_REQUESTS.md`](PROTECTED_CHANGE_REQUESTS.md)), PCR-1 first.

## 8. Remaining workstreams (not started in this increment)

ASCEND-00 protection amendments, lifecycle fencing and chunked-exit bias (protected); property-based financial invariant tests (protected package); ASCEND-01 FX history, corporate actions, inactive-token cohort (external data); ASCEND-02 new families (cross-sectional needs a cross-section); ASCEND-04 holiday calendars and persisted regimes; ASCEND-05 model registry table; ASCEND-09 feedback loop; ASCEND-10 views for regimes, portfolio and the research registry; ASCEND-11 consolidated release gate (PCR-5); multi-user foundations, licensing review and the commercial pack (§17); performance profiling (§18).

## 9. Maturity

Unchanged in kind: a well-guarded single-operator paper research platform with strong research-integrity controls and no validated edge. This increment closed three control defects in the research-autonomy layer, added portfolio research tooling, and gave the backup process its first restore verification tool.
