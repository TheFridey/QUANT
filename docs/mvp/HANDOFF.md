# QUANT MVP — Handoff

## Branch / PR

- Branch: `cursor/quant-mvp-multimarket-5f64`
- Base: `main`
- PR: https://github.com/TheFridey/QUANT/pull/2
- Baseline reviewed: `05143f1`
- HEAD: `c98f9db`

## What works end-to-end

- Prior Gate A–D offline path preserved (discovery, gateway, session equity, protection, instances, risk hierarchy, attribution, sessions/DST)
- **Ops controls UI (D48):** `opsControls` + `strategyInstances` from terminal snapshot; Strategy/Settings surfaces toggles (pause entries / DEMO / multi-market), unresolved protection, breaker honesty
- **Redis stage leases (D51):** `StageLeaseService` SET NX PX fencing wired into all BullMQ processors (ingest slot + per-stage cycle keys)
- **Product catalog (A09):** seed catalog, JPY quote-conversion flag, refuse unsupported futures multipliers without inventing CL size
- **Offline B12/B13/B16 deepen:** Frankfurter DELAYED without keys; ETF offline_fixture ≠ LIVE; order ack transition modelling in e2e
- **Contract map (D54)** + deeper multi-market e2e (D56 still fixture-shaped)
- LIVE remains gated/refused; C40 remains BLOCKED_EXTERNAL_TEST

## Gate progress (honest)

| Status | Count |
| --- | --- |
| VERIFIED_OFFLINE | 52 |
| PARTIAL | 5 |
| IMPLEMENTED_UNVERIFIED | 0 |
| BLOCKED_EXTERNAL_TEST | 1 |
| VERIFIED_EXTERNAL | 0 |

## Commands

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm db:deploy
node scripts/soak-capacity.mjs
node scripts/verify-external-providers.mjs
```

## Residual PARTIAL (local depth exhausted without keys)

| ID | Why still PARTIAL | Owner action |
| --- | --- | --- |
| B12 | Practice/live FX levels need OANDA (or similar) keys | Supply practice credentials → verify-external-providers |
| B13 | Market-driven ETF levels need Alpaca keys | Supply Alpaca paper keys |
| B16 | Credentialed venue order ACK path | Practice keys + C40 walk |
| D56 | E2E still fixture-shaped; no live SLO | Optional: credentialed multi-market paper walk |
| D57 | Soak is fixture_shaped_soak; not live-feed capacity SLO | Optional: soak with live feeds after keys |

**BLOCKED_EXTERNAL_TEST:** C40 (do not mark VERIFIED_EXTERNAL without practice demo)

## Owner next actions

1. Walk RUNBOOKS on MARKET_DATA_PAPER (no fixture banner)
2. Supply practice credentials → `verify-external-providers`
3. Do not mark VERIFIED_EXTERNAL from fixtures/soak
4. Review PR #2

## PR title / body

**Title:** `feat(mvp): ops controls UI, Redis stage leases, product catalog, contract map`

**Body:**

```markdown
## Summary
Finishes remaining locally implementable PARTIAL depth without credentials: Strategy/Settings ops controls from persisted backend (D48), Redis SET NX PX BullMQ stage leases (D51), product catalog + futures refuse honesty (A09), offline Frankfurter/ETF/order-ack modelling (B12/B13/B16), acceptance contract map (D54), deeper multi-market E2E (D56 still fixture-shaped). No LIVE. No fake external success. C40 stays BLOCKED_EXTERNAL_TEST.

## Matrix
VERIFIED_OFFLINE 52 · PARTIAL 5 · IMPLEMENTED_UNVERIFIED 0 · BLOCKED_EXTERNAL_TEST 1 · VERIFIED_EXTERNAL 0

## Verify
- pnpm test → 279 passed / 1 skipped
- typecheck / lint / build clean
- C40 still exit 2 without credentials

## Residual owner-only / PARTIAL
- B12/B13/B16 + C40: practice credentials for market-driven levels / venue ACK
- D56/D57: fixture-shaped E2E/soak — not live SLO
```

## Docs

`ACCEPTANCE_SCENARIOS.md` · `PROVIDER_CAPABILITIES.md` · `REQUIREMENTS_MATRIX.md` · `EVIDENCE.md` · `HANDOFF.md` · `RUNBOOKS.md` · `DECISIONS.md`
