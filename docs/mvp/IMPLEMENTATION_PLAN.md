# QUANT MVP — Implementation Plan

## Goal

Working, observable, restart-safe multi-market trading MVP: internal paper across asset classes + external demo/sandbox adapter boundary. Live money disabled and gated. Preserve existing Nest/Next/Prisma/BullMQ stack.

## Branch

`cursor/quant-mvp-multimarket-5f64` off `main` @ `0689e33`.

## Gate map

| Gate | Stages | Focus | Status |
| --- | --- | --- | --- |
| A | 01–10 | Baseline, contracts, registry/FX accounting, sizing deadlock, held-position monitoring, observation history, eligibility/time, sessions | **IN PROGRESS** |
| B | 11–29 | Broad markets, durable order lifecycle, costs, reservations, protection/OCO/trailing, risk hierarchy, presets | NOT_STARTED |
| C | 30–43 | Strategy interface, backtest/runtime unify, promotion, external adapter, reconciliation, secure ops | NOT_STARTED |
| D | 44–58 | Funnel/UX, observability, regression suite 1–28, E2E/load, runbooks | NOT_STARTED |

## Shared contracts (freeze early)

Owned in `packages/shared`:

- Instrument identity: asset class, venue, session, execution capability, provider ids
- Order identity: account, execution mode, venue, canonical instrument, strategy version through lifecycle
- Money: decimal USD + FX conversion helpers (no float)
- Data provenance: LIVE / DELAYED / STALE / REPLAY / DEMO / FIXTURE / SANDBOX — never fake live
- Risk hierarchy: hard blocks vs advisories; models cannot bypass

## Parallel ownership (single owner per shared file)

1. Core execution / ledger — `packages/trading-engine`, worker executor path
2. Market registry / adapters — `packages/shared/instruments*`, `packages/market-data`
3. Risk / sizing / protection — `packages/risk-engine`, sizing in trading-engine
4. Strategies / backtest parity — `packages/agent-core`, `packages/backtest`, evolution promotion
5. API / terminal UX — `apps/api`, `apps/web`
6. Integration / docs / fault tests — `docs/mvp`, E2E, infra

Coordinator owns Prisma migrations and cross-package types.

## Gate A work items

1. Docs + evidence of defects (this folder)
2. Raise activity headroom defaults + schema guard against min-order > max-position budget
3. Never round up through risk cap (explicit assert + test)
4. Include open holdings in cycle pairs for exit/flatten evaluation independent of discovery
5. Clear flatten only when no open qty remains (or record incomplete flatten)
6. Observation history: latest window (`desc` take N, reverse)
7. Honour `eligibleAt`/`expiresAt` on commit (PENDING until eligible; expire honestly)
8. Subtract in-cycle sell exposure when releasing capacity
9. Instrument registry: FX pairs + executable ETF proxies; indices stay research-only
10. Session / freshness helpers for non-24x7 markets

## Non-negotiable invariants

See mission brief. Enforced in code + regression scenarios 1–28.

## External policy

Missing credentials → `BLOCKED_EXTERNAL` with setup steps. Internal paper continues. Never mark an adapter DONE from fixtures alone.
