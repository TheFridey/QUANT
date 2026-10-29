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
| Migrations | 13 SQL dirs through `20261029160000_gate_a_context_protection_scope` |
| Docker | Not installed in this VM (`docker: command not found`) |
| CI | `.github/workflows/ci.yml` — test + build-packages; installs bubblewrap |

### Baseline checks (this agent)

| Command | Result | Notes |
| --- | --- | --- |
| `git fetch/pull origin main` | PASS | Fast-forward to `4adca80` |
| `pnpm install --frozen-lockfile` | PASS | Prisma generate via postinstall |
| `pnpm test` | PENDING | Recorded after first suite run |
| `pnpm typecheck` | PENDING | |
| `pnpm lint` | PENDING | |
| Postgres/Redis | BLOCKED locally without Docker | CI provides services |

### Findings matrix carry-forward

See `docs/launch/FINDINGS_MATRIX.md` (D01–D30). Prior agent labelled many items IMPLEMENTED + VERIFIED_UNIT; Gate A worker/DB and Gate 2 external demo remain open. This programme continues from that tip without reclaiming unverified work as E2E.

---

## Programme sections (§5–§42)

| Section | Scope | Status | Evidence |
| --- | --- | --- | --- |
| §5 Concurrent attributed intents | Instance ENTER/EXIT/REDUCE → planning | `NOT_IMPLEMENTED` → in progress | Allowlist-only path still requires runPulse ACT |
| §6 Preserve paused/disabled instances | Init must not force ACTIVE | `NOT_IMPLEMENTED` → in progress | `upsertStrategyInstance` update forces ACTIVE |
| §7 Explicit strategy binding | Stable moduleRef; no name substring | `NOT_IMPLEMENTED` → in progress | `moduleForInstance` uses `name.includes` |
| §8 Instance budgets & ownership | Persist ownership / netting | `IMPLEMENTED_UNVERIFIED` (partial) | Order stamp exists; allocations incomplete |
| §9 Fair allocation & funnel | Deterministic fairness + metrics | `IMPLEMENTED_UNVERIFIED` (partial) | Round-robin present; funnel metrics incomplete |
| §10–13 Promotion / provenance / D28 | Server evidence + lineage | `IMPLEMENTED_UNVERIFIED` (partial) | D13 unit; D28 DESIGN |
| §14–16 Practice broker / gateway | Real adapter + unknown outcomes | `BLOCKED_EXTERNAL` / stub | SANDBOX refuses PAPER masquerade |
| §17–21 Accounting / protection / reconcile | Product accounting | `IMPLEMENTED_UNVERIFIED` (partial) | |
| §22–31 Analytics / UI / onboarding | Desk, drafts, a11y | `IMPLEMENTED_UNVERIFIED` (partial) | |
| §32–33 Auth / backup | Session audit; restore drill | `IMPLEMENTED_UNVERIFIED` / open | |
| §34–39 Harness / E2E / Playwright / soak | Real app proof | `NOT_IMPLEMENTED` | |
| §40 Gates | Gate 1 local paper | in progress | Live disabled |
| §41–42 Docs + final report | Honesty | in progress | This file |

---

## Gate summary (honest)

| Gate | Meaning | Status |
| --- | --- | --- |
| Gate 1 — local paper MVP | Attributed intents, instance init, binding, paper path | **IN PROGRESS** |
| Gate 2 — external practice | Named demo broker lifecycle | **BLOCKED_EXTERNAL** without credentials |
| Gate 3 — live review candidate | Live money | **DISABLED** — do not enable |

---

## Change log (this branch)

| Date | Change |
| --- | --- |
| 2026-10-29 | Phase 0 baseline recorded; branch created |
