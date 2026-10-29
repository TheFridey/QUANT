# QUANT MVP — Handoff

## Branch / PR

- Branch: `cursor/quant-mvp-multimarket-5f64`
- Base: `main`
- PR: https://github.com/TheFridey/QUANT/pull/2
- Baseline reviewed: `05143f1`
- HEAD: `61bddb3`

## What works end-to-end

- Gate A engine fixes preserved
- **Organic DexScreener discovery:** token-profiles + search primary; paid boosts optional supplement only
- **MarketDataGateway:** routes FX/ETF to named providers; worker FX paper ingest uses gateway; no invented levels
- **Session equity / HWM:** `rollSessionEquity` wired into worker `loadPlan` with UTC midnight roll + daily PnL reset
- **Sessions depth:** US equity holidays, DST boundary checks, FX Fri 17:00–Sun 17:00 ET weekend closure; `planCycle` rejects BUY with `SESSION_CLOSED`
- **Held multi-market marks:** FX/ETF/commodity outside discovery merged without inventing prices (`held-marks` + loadPlan)
- **Product semantics:** FX pip/session labels, ETF/commodity paper families; CL futures still unsupported
- **Risk hierarchy:** ranked hard controls; circuit breaker composition; ACK≠clear ranks; terminal `riskDiagnostics`
- **Desired vs ACK protection:** offline compare + synthetic≠venue-confirmed; positions panel surfaces helper vs venue ACK
- **Instance attribution:** net PnL/fees by strategyVersion stamp; terminal panel
- **Research integrity:** look-ahead/leakage/duplicate checks; sandbox skip vs pass honesty
- **Worker leases:** exclusive cycle lease race tests (BullMQ multi-process lock still PARTIAL)
- **Operating controls / hard blocks / funnel / observability / reconcile / trailing / instances** (prior)
- LIVE remains gated/refused

## Gate progress (honest)

| Status | Count |
| --- | --- |
| VERIFIED_OFFLINE | 48 |
| PARTIAL | 9 |
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

## Residual PARTIAL

A09 · B12–B13, B16 · D48, D51, D54, D56, D57

**BLOCKED_EXTERNAL_TEST:** C40

## Owner next actions

1. Walk RUNBOOKS on MARKET_DATA_PAPER (no fixture banner)
2. Supply practice credentials → `verify-external-providers`
3. Do not mark VERIFIED_EXTERNAL from fixtures/soak
4. Optional: wire WorkerLeaseManager into BullMQ job locks for D51 promotion
5. Review PR #2

## PR title / body (if ManagePullRequest unavailable)

**Title:** `feat(mvp): sessions/DST, held marks, risk hierarchy, attribution, UX diagnostics`

**Body:**

```markdown
## Summary
Closes local PARTIAL gaps without credentials: FX/equity session holidays+DST+weekend closure, held multi-market mark/eval outside discovery, product semantics labels, risk hierarchy/breakers, desired-vs-ACK protection modelling, research integrity + sandbox skip honesty, instance attribution, command-centre/positions/risk diagnostics from persisted backend, alert ops depth, worker lease races, deeper multi-market E2E. No LIVE. No fake external success. No MARKET_DATA_PAPER fixture contamination. Additive migrations only (none this increment).

## Matrix
VERIFIED_OFFLINE 48 · PARTIAL 9 · IMPLEMENTED_UNVERIFIED 0 · BLOCKED_EXTERNAL_TEST 1 · VERIFIED_EXTERNAL 0

## Verify
- pnpm test → 267 passed / 1 skipped
- typecheck / lint / build clean
- C40 still exit 2 without credentials
- soak remains fixture_shaped_soak (not live SLO)

## Still owner-only / PARTIAL
- A09/B12/B13 credentialed market-driven levels
- B16/C40 venue ACK with practice keys
- D48 deeper ops controls UI
- D51 BullMQ multi-process lease wiring
- D54/D56/D57 contract map / fixture-shaped E2E / capacity SLO honesty
```

## Docs

`ACCEPTANCE_SCENARIOS.md` · `PROVIDER_CAPABILITIES.md` · `REQUIREMENTS_MATRIX.md` · `EVIDENCE.md` · `HANDOFF.md` · `RUNBOOKS.md` · `DECISIONS.md`
