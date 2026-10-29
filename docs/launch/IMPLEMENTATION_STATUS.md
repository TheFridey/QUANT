# QUANT — Implementation Status (Paper MVP Gate Programme)

**Starting commit (origin/main):** `4adca801e4592ddb5cdcce107b2751b33bc5ba0c`  
**Working branch:** `cursor/quant-paper-mvp-gate1-7ed8`  
**Runtime:** Node v22.23.4 · pnpm 10.33.4 · packageManager `pnpm@10.33.4`  
**LIVE money:** disabled (`LIVE_MONEY_ENABLED=false`; no live broker route)  
**Last updated:** 2026-10-29

Verification labels (honest):

| Label | Meaning |
| --- | --- |
| `IMPLEMENTED_UNVERIFIED` | Code present; no independent check recorded this run |
| `VERIFIED_UNIT` | Vitest (or equivalent) passed for the named command |
| `VERIFIED_INTEGRATION` | DB/worker/service integration check passed |
| `VERIFIED_E2E` | Full local paper lifecycle / Playwright against real app |
| `BLOCKED_EXTERNAL` | Needs owner credentials / network practice host |
| `DESIGN_ONLY` | Spec / decision only |
| `NOT_IMPLEMENTED` | Missing |

Do **not** treat helper tests as E2E, docs as runtime proof, or stubs as READY.

---

## Phase 0 — Baseline evidence

| Item | Value |
| --- | --- |
| Prior local HEAD (before pull) | `be0923305193cfbf5ccfbf6336663e0b002ca5bf` (behind origin by 8) |
| Current main / start of work | `4adca801e4592ddb5cdcce107b2751b33bc5ba0c` (PR #4 merge tip) |
| AGENTS.md | Not present in repo |
| Migrations | Through `20261029170000_strategy_instance_binding_ownership` |
| Docker | Not installed in this VM (`docker: command not found`) |
| CI | `.github/workflows/ci.yml` — test + build-packages; installs bubblewrap |

### Baseline checks (this agent)

| Command | Result | Notes |
| --- | --- | --- |
| `git fetch/pull origin main` | PASS | Fast-forward to `4adca80` |
| `pnpm install --frozen-lockfile` | PASS | Prisma generate via postinstall |
| `pnpm test` (baseline, pre-change) | 322 passed / 3 failed / 29 skipped | Failures were bubblewrap; bwrap installed mid-run |
| `pnpm test` (final) | **363 passed / 0 failed / 20 skipped** | Integration suites skip without DATABASE_URL |
| `pnpm typecheck` | PASS | packages + api/worker/web |
| `pnpm lint` | PASS | |
| `pnpm build` | PASS | packages + api/worker/web |
| `node scripts/paper-lifecycle-harness.mjs` | PASS | Plan-level attributed ENTER → order (not worker/DB E2E) |
| `node scripts/verify-practice-broker.mjs` | exit 3 BLOCKED_EXTERNAL | Missing ALPACA_* keys |
| `node scripts/soak-capacity.mjs` | BLOCKED | No DATABASE_URL in this VM; **actual soak duration: not run** |
| Postgres/Redis | BLOCKED locally without Docker | CI provides services |

---

## Programme sections (§5–§42)

| Section | Scope | Status | Evidence |
| --- | --- | --- | --- |
| §5 Concurrent attributed intents | Instance ENTER/EXIT → planning | `VERIFIED_UNIT` | `pnpm exec vitest run packages/agent-core/src/attributed-intents.test.ts` (8 pass); harness ok |
| §6 Preserve paused/disabled instances | Init must not force ACTIVE | `VERIFIED_UNIT` (logic) / integration skipped no DB | `ensureDefaultStrategyInstances` create-if-absent; IT skipped |
| §7 Explicit strategy binding | Stable moduleRef | `VERIFIED_UNIT` | `strategy-binding.test.ts` (5 pass) |
| §8 Instance budgets & ownership | Persist ownership / netting | `VERIFIED_UNIT` (helpers) + schema | Order/Fill/Position `strategyInstanceId`; `StrategyAllocation`; alloc helpers |
| §9 Fair allocation & funnel | Deterministic fairness + metrics | `VERIFIED_UNIT` | Round-robin retained; `funnelThroughputMetrics` tested |
| §10–13 Promotion / provenance / D28 | Server evidence + lineage | `VERIFIED_UNIT` | Existing promotion tests + `lineage.test.ts` (4 pass) |
| §14–16 Practice broker / gateway | Real adapter + unknown outcomes | Adapter `VERIFIED_UNIT`; network `BLOCKED_EXTERNAL` | `practice-broker.test.ts`; verify script exit 3 |
| §17–21 Accounting / protection / reconcile | Product valuation | `VERIFIED_UNIT` (valuation) | `account-valuation.test.ts`; prior protection units retained |
| §22–31 Analytics / UI / onboarding | Desk, drafts, a11y | `IMPLEMENTED_UNVERIFIED` (UI) | Operator desk panel; prior Gate C UX retained |
| §32–33 Auth / backup | Session audit; restore drill | Auth prior unit; restore script `IMPLEMENTED_UNVERIFIED` | `backup-restore-nonprod.mjs` (needs pg client + test DB) |
| §34–39 Harness / E2E / Playwright / soak | Real app proof | Harness `VERIFIED_UNIT`-level; E2E/soak **not** claimed | Playwright specs exist; not run vs live app this VM |
| §40 Gates | Gate 1 local paper | **PARTIAL** — core correctness landed; full worker/DB E2E open | Live disabled |
| §41–42 Docs + final report | Honesty | This file + PR | |

---

## Gate summary (honest)

| Gate | Meaning | Status |
| --- | --- | --- |
| Gate 1 — local paper MVP | Attributed intents, instance init, binding, paper path | **PARTIAL** — unit+harness green; worker/DB/browser E2E still open |
| Gate 2 — external practice | Named demo broker lifecycle | **BLOCKED_EXTERNAL** without `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` |
| Gate 3 — live review candidate | Live money | **DISABLED** — do not enable |

---

## Change log (this branch)

| Date | Change |
| --- | --- |
| 2026-10-29 | Phase 0 baseline recorded; branch created |
| 2026-10-29 | §5–§8 attributed intents, binding, ownership schema |
| 2026-10-29 | §9 funnel throughput; §13 lineage; §14–16 practice broker + unknown outcomes; §17 valuation; desk UI; harness/verify/backup scripts |
