# QUANT MVP — Handoff

## Branch / PR

- Branch: `cursor/quant-mvp-multimarket-5f64`
- Base: `main`
- PR: https://github.com/TheFridey/QUANT/pull/2
- Baseline reviewed: `05143f1`
- HEAD: update after push

## What works end-to-end

- Gate A engine fixes preserved
- **Organic DexScreener discovery:** token-profiles + search primary; paid boosts optional supplement only
- **MarketDataGateway:** routes FX/ETF to named providers; worker FX paper ingest uses gateway; no invented levels
- **Session equity / HWM:** `rollSessionEquity` wired into worker `loadPlan` with UTC midnight roll + daily PnL reset
- **Operating controls:** `PAUSE_NEW_ENTRIES` / `ENTRIES_SUSPENDED` distinct hard blocks; exits/flatten survive
- **Hard blocks vs advisories:** `blocks.ts` + terminal why-blocked classification; UNKNOWN≠PASS
- **Funnel uniqueness:** dedupe cycle|pair|stage on persist
- **Observability:** worker flushes ObservabilityEvent; terminal risk panel lists recent
- **Reconcile depth:** position qty vs fills enrich; suspend without inventing fills
- **Trailing peak persist** on armed protection during evaluate
- **Strategy instances:** ≥3 seeded; evaluate/allocate call-site integration test
- Fixture isolation, PG reservations, protection crash/OCO, exit parity, commodity semantics, REPLAY metrics isolation, venue desired→ACK, soak script (prior)
- LIVE remains gated/refused

## Gate progress (honest)

| Status | Count |
| --- | --- |
| VERIFIED_OFFLINE | 36 |
| PARTIAL | 21 |
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

A04, A09, A10 · B12–B14, B16, B22, B26 · C36, C37, C39 · D45, D47–D51, D54, D56, D57

**BLOCKED_EXTERNAL_TEST:** C40

## Owner next actions

1. Walk RUNBOOKS on MARKET_DATA_PAPER (no fixture banner)
2. Supply practice credentials → `verify-external-providers`
3. Do not mark VERIFIED_EXTERNAL from fixtures/soak
4. Review PR #2

## PR title / body (if ManagePullRequest unavailable)

**Title:** `feat(mvp): organic discovery, session equity, controls, gateway, reconcile depth`

**Body:**

```markdown
## Summary
Continues QUANT MVP: organic crypto discovery, MarketDataGateway call sites, UTC session equity/HWM, operating controls hard-blocks, strategy instance integration evidence, funnel uniqueness, observability persist, reconcile position-qty depth, terminal multi-market/observability UX.

## Matrix
VERIFIED_OFFLINE 36 · PARTIAL 21 · IMPLEMENTED_UNVERIFIED 0 · BLOCKED_EXTERNAL_TEST 1 · VERIFIED_EXTERNAL 0

## Verify
- pnpm test → 239 passed / 1 skipped
- typecheck / lint / build clean
- C40 still exit 2 without credentials
```

## Docs

`ACCEPTANCE_SCENARIOS.md` · `PROVIDER_CAPABILITIES.md` · `REQUIREMENTS_MATRIX.md` · `EVIDENCE.md` · `HANDOFF.md` · `RUNBOOKS.md` · `DECISIONS.md`
