# QUANT — Implementation Status (Paper MVP Gate Programme)

**Starting commit (origin/main):** `4adca801e4592ddb5cdcce107b2751b33bc5ba0c`  
**Working branch:** `cursor/quant-paper-mvp-gate1-7ed8`  
**Runtime:** Node v22.23.4 · pnpm 10.33.4 · packageManager `pnpm@10.33.4`  
**LIVE money:** disabled (`LIVE_MONEY_ENABLED=false`; no live broker route)  
**Last updated:** 2026-10-29 (follow-up: apt Postgres/Redis + DB verification)

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
| Start of work | `4adca801e4592ddb5cdcce107b2751b33bc5ba0c` |
| Migrations | Through `20261029180000_d29_snapshot_indexes` |
| Docker | Not installed — **Postgres 16 + Redis 7 installed via apt** instead |
| Local DB URLs | `postgresql://odin:odin@127.0.0.1:5432/odin` and `odin_test` |

### Verification checks (follow-up)

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm db:deploy` | PASS | Both `odin` and `odin_test` |
| `pnpm exec vitest run --pool=forks --poolOptions.forks.singleFork=true` | **385 passed, 1 skipped, 0 failed** | Serial pool avoids shared-DB races |
| Integration (§6 pause, stage-runner, promote, protection, reservations) | **21/21 PASS** (serial) | `VERIFIED_INTEGRATION` |
| `SOAK_SLOTS=20 SOAK_WORKERS=3 node scripts/soak-capacity.mjs` | PASS | script `elapsedMs=331`; **wall-clock `SOAK_WALL_MS=443`** (~0.44s); label `fixture_shaped_soak`; **helper≠full engine** |
| `node scripts/backup-restore-nonprod.mjs backup/restore` | PASS | Against `odin_test` only (schema reset + restore) |
| `node scripts/paper-lifecycle-harness.mjs` | PASS | Plan-level |
| `node scripts/verify-practice-broker.mjs` | exit 3 `BLOCKED_EXTERNAL` | No Alpaca keys |
| Playwright vs running app | **NOT RUN** | Specs + `docs/launch/PLAYWRIGHT.md` document exact commands |
| `pnpm typecheck` / `pnpm build:packages` | PASS | After D29 changes |

---

## Programme sections (§5–§42)

| Section | Scope | Status | Evidence |
| --- | --- | --- | --- |
| §5 Concurrent attributed intents | Instance ENTER/EXIT → planning | `VERIFIED_UNIT` + harness | attributed-intents tests; plan harness |
| §6 Preserve paused/disabled instances | Init must not force ACTIVE | `VERIFIED_INTEGRATION` | strategy-instances.integration §6 |
| §7 Explicit strategy binding | Stable moduleRef | `VERIFIED_UNIT` | strategy-binding.test.ts |
| §8 Instance budgets & ownership | Persist ownership / netting | `VERIFIED_UNIT` + schema | stamps + StrategyAllocation helpers |
| §9 Fair allocation & funnel | Fairness + metrics | `VERIFIED_UNIT` | funnelThroughputMetrics |
| §10–13 Promotion / provenance / D28 | Server evidence + lineage | `VERIFIED_UNIT` + promote IT | lineage + promote-paper.integration |
| §14–16 Practice broker / gateway | Adapter + unknown outcomes | Unit OK; network `BLOCKED_EXTERNAL` | practice-broker tests + verify script |
| §17–21 Accounting / protection | Valuation + protection | `VERIFIED_UNIT` + protection IT | account-valuation; protection-crash IT |
| §22–31 / D29 Analytics / UI | Desk + snapshot cost | D29 `VERIFIED_UNIT` + desk UI | snapshot-cost; whyNoTrades; indexes migration |
| §32–33 Auth / backup | Restore drill | `VERIFIED_INTEGRATION` (nonprod) | backup-restore against odin_test |
| §34–39 Harness / soak / Playwright | Helper soak recorded | Soak helper PASS; browser E2E open | wall 443ms; PLAYWRIGHT.md |
| §40 Gates | Gate 1 | **PARTIAL → stronger** (DB+IT+soak helper) | Still not full worker/browser E2E |
| §41–42 Docs | Honesty | This file | |

---

## Gate summary (honest)

| Gate | Meaning | Status |
| --- | --- | --- |
| Gate 1 — local paper MVP | Attributed intents, init, binding, paper path | **PARTIAL (improved)** — unit + DB integration + helper soak; **not** full engine/browser E2E |
| Gate 2 — external practice | Named demo broker | **BLOCKED_EXTERNAL** |
| Gate 3 — live | Live money | **DISABLED** |

---

## Change log (this branch)

| Date | Change |
| --- | --- |
| 2026-10-29 | Phase 0 baseline; §5–§8 attributed intents / binding / ownership |
| 2026-10-29 | Practice broker, lineage, valuation, desk, harness scripts |
| 2026-10-29 | Follow-up: apt Postgres/Redis; IT green; soak wall 443ms; backup/restore; D29 snapshot cost + indexes; why-no-trades desk |
