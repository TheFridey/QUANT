# QUANT — Implementation Status (Release runtime connection)

**Starting commit (origin/main):** `e08a5a1778c6555e324a2a62ab085352002f3bc0` (PR #5 merge)  
**Working branch:** `cursor/runtime-correctness-practice-a5bc` (PR #7)  
**Runtime:** Node v22.23.4 · pnpm 10.33.4  
**DB:** Postgres 16 (apt) · Redis 7 · migrations through `20261030140000_promotion_provenance`  
**LIVE money:** disabled  
**Last updated:** 2026-10-29 (Europe/London)

Verification labels (honest):

| Label | Meaning |
| --- | --- |
| `NOT_IMPLEMENTED` | Missing |
| `DESIGN_ONLY` | Spec / decision only |
| `IMPLEMENTED_UNVERIFIED` | Code present; no independent check this run |
| `VERIFIED_UNIT` | Vitest unit passed |
| `VERIFIED_INTEGRATION` | DB/worker/service integration passed |
| `VERIFIED_E2E` | Full browser or full-stack path verified |
| `BLOCKED_EXTERNAL` | Needs owner credentials / network practice host |

Do **not** treat helper tests as E2E, docs as runtime proof, or stubs as READY.

---

## Phase 0 — Baseline evidence

| Item | Value |
| --- | --- |
| Start of work | `e08a5a1778c6555e324a2a62ab085352002f3bc0` |
| Prior CI failure | `actions/runs/40905548596` — `promote-paper.integration.test.ts:141` shared-DB race |
| Fix | Shared advisory lock `641099` for all DB integration suites; vitest `integration` project `singleFork` + `fileParallelism: false`; unit stays parallel |
| Local DB URLs | `postgresql://odin:odin@127.0.0.1:5432/odin` and `odin_test` |

### Verification checks (this run)

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm db:deploy` | PASS | odin + odin_test incl. `runtimeState` migration |
| `pnpm exec vitest run` | **392 passed, 1 skipped, 0 failed** | unit parallel + integration serial |
| `pnpm typecheck` | PASS | packages + api/worker/web |
| `pnpm lint` | PASS | |
| promote-paper / stage-runner / paper-lifecycle / protection ITs | PASS | `VERIFIED_INTEGRATION` |
| `SOAK_SECONDS=10` engine-soak IT | PASS | **wallClockMs=10038** (~10.038s); 71 cycles; 1 fill; 0 errors — `engine_worker_db_soak` |
| `scripts/soak-capacity.mjs` | PASS | helper soak `elapsedMs=324` — helper≠full engine |
| `node scripts/verify-practice-broker.mjs` | exit 3 | `ok:false` + `BLOCKED_EXTERNAL` (no Alpaca keys) — honest |
| Playwright vs running app | **PASS 8/8** | Live api+worker+web + `odin_e2e`; `e2e/paper-mvp.spec.ts` + smokes → **`VERIFIED_E2E`** (local paper UI paths; see PLAYWRIGHT.md) |

---

## Programme sections (§5–§39) — evidence matrix

| Section | Scope | Status | Evidence |
| --- | --- | --- | --- |
| §5 CI race | Serialize integration group | `VERIFIED_INTEGRATION` | vitest projects + lock 641099; promote-paper green |
| §6 Preserve pause | Init must not force ACTIVE | `VERIFIED_INTEGRATION` | strategy-instances.integration |
| §7 Canonical intents | ENTER/EXIT/REDUCE attributed path | `VERIFIED_UNIT` + IT | pulse/plan/stage-runner; strategies never submit broker orders |
| §8 No same-symbol collapse | attributed maps + order identity | `VERIFIED_UNIT` | attributed-intents; clientOrderId + strategyInstanceId |
| §9 Allocation settlement | `applyAllocationFill` in store fill paths | `VERIFIED_INTEGRATION` | trading-engine store + paper-lifecycle IT |
| §10 Instance budgets | filterSignalsByInstanceBudget on admission | `VERIFIED_UNIT` | stage-runner loadPlan wired |
| §11 Ownership exit sizing | allocationQtyByKey in plan sizeOrder | `VERIFIED_UNIT` | plan.ts ALLOCATION_EXIT |
| §12 Allocation IDs | `newId("alloc")` — no truncated collision ids | `VERIFIED_UNIT` | strategy-allocations.ts |
| §13 Reconcile allocations | drift detect + audited UNATTRIBUTED repair | `VERIFIED_UNIT` | allocationVenueDrift / repairAllocationDrift |
| §14 Cross-market filter | solana universe ≠ EURUSD | `VERIFIED_INTEGRATION` | instanceMatchesInstrument + IT |
| §15 Fair scheduling | persisted fairnessCursor RR | `VERIFIED_UNIT` + IT | allocateOpportunities + EngineControl.runtimeState |
| §16 Failure diagnostics | runtimeState.instanceDiagnostics | `IMPLEMENTED_UNVERIFIED` | stage-runner persists; no alert flood |
| §17 Module binding | moduleRef at runtime | `VERIFIED_UNIT` | strategy-binding + ensureDefault |
| §18–§20 Promotion/lineage/hashes | server reportId+artifactId; validatePromotion; provenance COMPLETE required | `VERIFIED_UNIT` + `VERIFIED_INTEGRATION` | promotion.test + promote-paper IT |
| §21 Practice HTTP transport | AlpacaPracticeVenue + HTTP transport + offline VERIFIED book | `VERIFIED_UNIT` | market-data 43 tests; network `BLOCKED_EXTERNAL` |
| §22 Gateway wire | SANDBOX → practice; never local PAPER | `VERIFIED_UNIT` | execution-gateway.ts |
| §23 LocalPaper lookups | NOT_FOUND until submit; book required for positions | `VERIFIED_UNIT` | execution-gateway.test |
| §24 Unknown outcome | TIMEOUT → UNKNOWN_OUTCOME + reconcile class | `VERIFIED_UNIT` | practice-broker http + classifyAmbiguousSubmit |
| §25 Practice protection | capabilities.protection=false (synthetic disclosed) | `VERIFIED_UNIT` | SandboxExecutionGateway |
| §26 verify script | ok reflects outcome; exit 3 missing creds | `VERIFIED_UNIT` (script behaviour) | exit 3 observed |
| §27 Valuation | existing valuePortfolio in loadPlan | `VERIFIED_INTEGRATION` | stage-runner (prior + retained) |
| §28 Support matrix | honest CAPABILITIES.md | docs | docs/launch/CAPABILITIES.md |
| §29 Paper lifecycle IT | worker+DB no mocks | `VERIFIED_INTEGRATION` | paper-lifecycle.integration.test.ts |
| §30 Protection crash | prior protection-crash + reopen IT | `VERIFIED_INTEGRATION` | existing ITs green |
| §31 Playwright | browser vs live stack + CI job | `VERIFIED_E2E` (local) + CI job added | 8/8 local; Actions `browser-e2e` with deterministic PAPER feed |
| §32 Operator feedback | capacity UI, ACK button, why-no-trades families | `VERIFIED_UNIT` + `VERIFIED_INTEGRATION` | operator-capacity IT; Risk ACK; Capacity section |
| §33 Engine soak | StageRunner+DB | `VERIFIED_INTEGRATION` | wall **10038ms**; 71 cycles |
| §34 Snapshot perf | e2e latency not claimed | `VERIFIED_UNIT` helpers only | snapshot-cost unit; no SLO claim |
| §35 Migrations / unattributed | runtimeState migration; UNATTRIBUTED repair | `VERIFIED_INTEGRATION` | migrate deploy + repair helper |
| §36 CI connected product | integration project + build + browser-e2e job | `VERIFIED_INTEGRATION` + `VERIFIED_E2E` (Actions) | `59c35e0` — all 6 checks green incl. `browser-e2e` |
| §37 This matrix | honest statuses | this file | |
| §38 Release gates | see below | | |
| §39 PR | reviewable; do not merge | open PR #7 |

---

## Gate summary (honest)

| Gate | Meaning | Status |
| --- | --- | --- |
| Gate 1 — LOCAL PAPER MVP | Attributed intents, ownership, paper path, worker/DB + browser | **PASSING** — local unit/IT/soak + Actions `test`/`browser-e2e` green on `59c35e0`. |
| Gate 2 — EXTERNAL PRACTICE | Named Alpaca demo | **BLOCKED_EXTERNAL** (HTTP transport + offline venue VERIFIED_UNIT; no owner creds) |
| Gate 3 — LIVE | Live money | **DISABLED** |

---

## Shared contracts

- `docs/launch/RUNTIME_CONTRACTS.md`
- `packages/shared/src/runtime-contracts.ts`

---

## Change log (this branch)

| Date | Change |
| --- | --- |
| 2026-10-29 | CI race fix; shared contracts; allocation settlement in store; market scoping; fairness cursor; budgets; ownership exits; practice HTTP+gateway; lineage promotion gate; paper-lifecycle IT; engine soak; operator whyNoTrades families; CAPABILITIES honesty |
| 2026-10-29 | Playwright Gate 1 browser E2E against live stack + isolated `odin_e2e` — 8/8 pass; `VERIFIED_E2E` for listed paper UI paths; docs/PLAYWRIGHT.md |
| 2026-10-29 | Runtime correctness: multi-intent planner, instance capacity, ownership settlement, honest recon, SANDBOX outbox, Alpaca practice venue, validated promotion provenance, operator capacity/ACK UI, deterministic feed + Actions browser-e2e job |
| 2026-10-29 | CI green on `59c35e0` (lint/worker start path fix); all 6 Actions checks pass including browser-e2e |
