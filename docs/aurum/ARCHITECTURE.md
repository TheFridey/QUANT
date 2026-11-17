# ADR-AURUM-0001: AURUM subsystem mapping and dependency graph

- **Status:** Proposed (17 Nov 2026).
- **Deciders:** the operator.
- **Supersedes:** the multi-market execution roadmap of OPERATION HORIZON Phase II / BREAKOUT (`docs/horizon/phase-ii/ROLLOUT-PLAN.md`). The PCR-2 work is kept as reference.

## Context

QUANT is narrowing to one instrument, XAU/USD, traded as a simulated GBP financial spread bet. The existing engine has three limits:

- It is spot, long-only and USD-denominated.
- It isolates by trading environment rather than by account.
- It has no validated gold edge.

AURUM must reuse what works (campaign framework, DSR protocol, GENESIS, PCR-1 fencing, quote admission, breaker, sessions) without building parallel frameworks.

## Decision

1. **The thirteen AURUM names are logical subsystems.** They are not services, and no new microservice is created.
2. **Spread betting is a new position model, beside the spot model, not a mode of it.**
   - Spot `Position.baseQty` / `avgCostUsd` cannot represent a short, a stake per point or reserved margin.
   - Overloading it would make SELL ambiguous and endanger the legacy ledger.
   - The new model gets its own tables (`SpreadBetPosition`, `SpreadBetOrder`, `SpreadBetFill`, `MarginReservation`, GBP ledger lines). Those tables are proposed in PCR-AURUM-01 and are not created yet.
3. **AURUM runs on its own account with its own risk configuration.** It never runs on `primary` or `primary:<env>`. That needs per-account engine state (see "Isolation gap" below).
4. **Pure logic first, wiring later.** Everything on this branch is pure, unwired and inactive. Wiring into planner, risk and settlement is PCR-AURUM-01.

## Subsystem mapping

| Subsystem | Responsibility | Existing code reused | New on this branch | Still needed |
| --- | --- | --- | --- | --- |
| NEXUS | gold-only orchestration and control | `apps/worker/src/stage-runner.ts`, `EngineControl`, BullMQ | `packages/shared/src/aurum-scope.ts` (GOLD_ONLY profile, inactive) | per-account engine control; AURUM job profile that schedules no crypto discovery |
| FEED | gold quotes, history, integrity | `packages/market-data/src/oanda-practice.ts`, `provider-circuit.ts`, `apps/worker/src/history/backfill-cli.ts`, warehouse manifests | breaker review fixes | XAU shadow ingest with honest `dataOrigin`; streaming investigation (DATA-SOURCES, M1) |
| MACRO | contextual, publication-time data | none | — | M4; FRED/BLS/CFTC investigation, no spending |
| ATLAS | causal gold features | `packages/backtest/src/research/*` feature code, `sessions.ts` | — | FEATURE-CATALOGUE, M4 |
| PULSE | hypothesis families A–L | `packages/agent-core` strategy library, `market-config.ts` | — | M4; pre-registration through FORGE |
| ORACLE | ML baselines, calibration | ML 2.0 in `packages/backtest` (logistic, AUC, DSR) | — | M4–M5 |
| FORGE | campaigns, trial ledger, holdouts | `ResearchCampaign`, `ResearchTrialLedger`, `campaign-cli`, DSR `dsr-2.0.0` | — | trial reconciliation (operator questionnaire) before any campaign |
| SENTINEL | quote integrity, execution eligibility | `packages/shared/src/quote-admission.ts`, `quote-quality.ts`, `sessions.ts` | spread cap mandatory (re-review fix) | wiring (PCR-AURUM-01 C2) |
| AEGIS | spread-bet risk | `packages/risk-engine` (latches, daily loss, drawdown) | `sizeStake` in `spread-bet.ts` (pure) | GBP/margin-aware AEGIS states (RISK-MODEL, PCR C9) |
| EXECUTOR | GBP spread-bet simulation | PCR-1 lot fencing pattern, `store.ts` transaction ordering | `spread-bet.ts`, `spread-bet-lifecycle.ts` (pure) | tables, settlement, fills (PCR C3–C8) |
| GENESIS | prospective shadow evaluation | GENESIS shadow tables and runner | — | M5 |
| CHRONICLE | lineage and immutable evidence | intent identity, `TradeIntent`, ledger, manifests | retention manifest hashing (`apps/worker/src/ops/retention-policy.ts`) | lineage ids across spread-bet tables |
| COMMAND | gold terminal UI | `apps/web` | — | M8; must not show proposed positions as executed |

## Isolation gap (blocker for the AURUM account)

Row-level `accountId` partitioning exists on Order, Fill, Position, LedgerEntry, EquitySnapshot, OpportunityFunnelEvent, AccountSafetyState and StrategyInstance. Three things are shared:

- One `EngineControl` row (`primary`), holding the one risk and strategy config and the RUNNING/flatten state.
- Account derivation from the trading environment only (`environments.ts:43`).
- The pinned-context guard, which only accepts `primary*` (`execution-context.ts:105`).

A second account in `MARKET_DATA_PAPER` would therefore share risk limits, the flatten flag and engine status with `primary`. Fixing this means:

1. A per-account `AccountRiskConfig` (or `EngineControl` keyed by account).
2. An explicit account dimension in `ExecutionContext`.
3. The pinned-context guard accepting registered account ids only.

Items 1 and 3 touch risk evaluation inputs, which is protected. They are in PCR-AURUM-01 C10.

## Dependency graph

```
M0 foundation (this branch)
 ├─► 01-storage (retention executor; needs disposable-DB proof + operator policy)   [independent]
 ├─► 02-gold-only (wire aurum-scope; disable crypto scheduling in AURUM profile)     [needs 04 for account]
 ├─► 03-market-data (XAU shadow ingest, honest provenance)                            [needs 01: adds growth]
 │     └─► 09-macro, 08-market-features ─► 10-research ─► 11-oracle ─► 12-genesis
 ├─► 04-account-isolation ──┐                                                          [PROTECTED parts]
 └─► 05-product-semantics ──┴─► 06-spread-execution ─► 07-risk ─► 14-verification    [PROTECTED]
13-command follows 03 and 06 (read-only views first)
10-research is also gated on trial reconciliation (operator questionnaire)
```

Independent now: 01 (tooling), 05 (pure semantics, done here), 08 (pure features), and research documentation. Single-writer files: `packages/trading-engine/**`, `packages/risk-engine/**`, `apps/worker/src/executor/**`. Only one agent may edit them at a time, after unlock.

## Consequences

- The legacy spot engine and `primary` account keep running unchanged until the operator decides otherwise.
- The new tables mean a migration. It is additive only and cannot touch legacy rows.
- Two position models co-exist, and COMMAND must keep their results separate (no combined aggregate).
- Cost: PCR-AURUM-01 is larger than PCR-2. Its benefit is that no spot semantics are reinterpreted.
