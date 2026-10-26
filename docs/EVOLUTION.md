# PROJECT EVOLUTION — ODIN // QUANT

Audit date: 2026-10-26. Extends the live paper path; does not rewrite it.

## What already shipped (phases 1–4)

| Area | Status | Location |
| --- | --- | --- |
| Paper engine + ledger + risk | LIVE | `packages/trading-engine`, `packages/risk-engine`, worker stages |
| DexScreener Solana ingest | LIVE | `packages/market-data`, worker ingest |
| Six pipeline agents + optional ORACLE | LIVE | `packages/agent-core` |
| Command centre UI | LIVE | `apps/web` (:4317) |
| Research lab / backtest / gates | LIVE | `packages/backtest`, `/api/lab/*`, Strategy Lab UI |
| Release posture | LOCKED | `NOT_RELEASE_READY`; no real-money venue |

## Gaps this mission closes

1. **Multi-market** — Only Solana pairs today. Need instrument registry, provider abstraction, equity **indices** (non-tradable), market selector, incompatible-mix guards.
2. **Multi-model router** — Single OpenAI-compatible/Hermes/mock path. Need tiers, assignments, budgets, fallback, Zod-validated outputs, usage logs.
3. **Quant research pipeline** — Backtest + ORACLE exist; missing full OBSERVE→…→REVIEW lifecycle with forge sandbox, challenge, signed reports, isolated paper candidates.
4. **Deep trade memory** — Fills/decisions exist; missing searchable before/during/after trade context without post-exit leakage into entry decisions.
5. **Strategy lifecycle** — `StrategyVersion.status` is a free string defaulting to `DRAFT`. Need audited transitions with evidence hashes.
6. **Autonomy 0–4** — Not modelled. Default ≤2; level 4 real-money adapter stays disabled.
7. **ORACLE expansion** — Experiment review only. Need queues, budgets, deterioration, retirement, daily briefings with hard bounds.
8. **Command centre** — Missing Research Centre, Model Ops, Genome, Timeline, Memory, Autonomy, Market Selector sections.

## Non-negotiables

- Never invent prices/fills/returns. `UNKNOWN ≠ PASS`.
- LLM advisory never overrides risk/sizing/accounting.
- No real-money execution. Level 4 adapter remains disabled.
- Index feeds are research/display only — never LIVE paper fills from invented levels.
- Forge sandboxes cannot touch broker creds, live exec, prod DB, host FS, or unrestricted net.

## Dependency-aware slices

| # | Slice | Depends on | Deliverable |
| --- | --- | --- | --- |
| 1 | Instrument registry + market selector | — | Schemas, seed instruments, API toggle, UI selector |
| 2 | Model router + budgets | — | Tiers, adapters, assignments, usage persistence |
| 3 | Hypothesis + lifecycle schema/API | 1 | Falsifiable hypotheses; audited state machine |
| 4 | Typed Strategy + forge sandbox | 3 | Isolated codegen workspace + contract tests |
| 5 | Challenge + VALIDATE signing | 4, backtest | Adversarial review + hashed experiment reports |
| 6 | Deep trade memory | paper ledger | Persist + search; no exit leakage into entry |
| 7 | Autonomy + ORACLE queues | 2, 3, 5 | Levels 0–4; bounded research orchestration |
| 8 | Dashboard sections | 1–7 APIs | Wired UI modules |
| 9 | Adversarial + E2E acceptance | all | Evidence doc; honest PASS/FAIL/SKIP |
| 10 | Commit/push `main` | green checks | SHAs recorded here and in acceptance |

## Vertical-slice acceptance (shipped)

| # | Slice | Status |
| --- | --- | --- |
| 1 | Instrument registry + market selector | SHIPPED |
| 2 | Model router + budgets | SHIPPED |
| 3 | Hypothesis + lifecycle API | SHIPPED |
| 4 | Strategy interface + forge sandbox | SHIPPED |
| 5 | Challenge + VALIDATE signing | SHIPPED |
| 6 | Deep trade memory | SHIPPED |
| 7 | Autonomy + ORACLE queues | SHIPPED |
| 8 | Dashboard sections | SHIPPED |
| 9 | Adversarial + E2E evidence | SHIPPED — see `docs/acceptance/evolution.md` |
| 10 | Commit/push `main` | SHIPPED |

Each slice shipped with unit/integration tests. Live E2E claims only for exercised API steps.

## Architecture addition

```text
MarketSelector ──► InstrumentRegistry ──► providers (Solana live | Index DEMO/DELAYED)
                                              │
Research pipeline (isolated)                  │
  OBSERVE → HYPOTHESISE → FORGE → TEST        │
           → CHALLENGE → VALIDATE → PAPER → REVIEW
                                              │
ModelRouter (FAST / DEEP / ENG) ──► Zod JSON  │
TradeMemory (before/during/after) ────────────┤
AutonomyPolicy (≤2 default; L4 disabled) ─────┤
ORACLE queues (budget/iteration bounds) ──────┘
        │
        ▼
  /api/evolution/*  +  Command centre sections
  (live paper BullMQ path unchanged)
```
