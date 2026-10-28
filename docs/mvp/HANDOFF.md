# QUANT MVP — Handoff

## Branch / PR

- Branch: `cursor/quant-mvp-multimarket-5f64`
- Base: `main`
- PR: https://github.com/TheFridey/QUANT/pull/2
- Baseline reviewed: `05143f1`
- Update HEAD after push

## What works end-to-end

- Gate A engine fixes preserved
- **Fixture isolation:** defaults no longer inject FX/ETF/commodity fixtures into paper; FIXTURE env + banner + sequenced ticks
- **Named providers:** Alpaca paper + OANDA practice + Frankfurter FX marks; readiness enum; offline contracts
- **Durable PG reservations:** transactional authority, mutation events, 2-worker race, adversarial releasePartial, **`reserveInTx` on worker ENTRY admission**
- **Protection:** long/short OCO; worker arms on BUY fill; evaluates marks; failed exit → ProtectionIntent UNRESOLVED + alert + retry hook
- **Market cost models:** FX/ETF/commodity without DEX impact
- **Strategy instances:** durable records seeded (≥3 crypto/FX/ETF), concurrent evaluate/allocate gating entries in `loadPlan`
- LIVE remains gated/refused

## Gate progress (honest)

See `ACCEPTANCE_SCENARIOS.md` + `REQUIREMENTS_MATRIX.md`.

| Status | Count |
| --- | --- |
| VERIFIED_OFFLINE | 19 |
| PARTIAL | 32 |
| IMPLEMENTED_UNVERIFIED | 6 |
| BLOCKED_EXTERNAL_TEST | 1 |
| VERIFIED_EXTERNAL | 0 |

Do not trust legacy DONE 34.

## Commands

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm db:deploy
```

## Unresolved defects / blockers

1. Credentialed Alpaca/OANDA external verification → **BLOCKED_EXTERNAL_TEST** (setup in PROVIDER_CAPABILITIES / RUNBOOKS)
2. Birdeye security UNKNOWN without API key
3. Full backtest/runtime unify + deterministic shared clock still PARTIAL
4. Production-shaped capacity/soak not claimed (in-process only)
5. Richer multi-worker crash/restart protection harness still depth-PARTIAL
6. D45–D48 terminal redesign depth still PARTIAL (fixture banner + environment fields added)
7. Commodity multipliers/currency product semantics incomplete
8. REPLAY dedicated account isolation not fully wired through all metrics paths

## Owner next actions

1. Walk `docs/mvp/RUNBOOKS.md` first session on **MARKET_DATA_PAPER** (confirm no fixture banner)
2. Optionally enable `marketDataPaperFxIngest` for Frankfurter delayed FX
3. Supply practice credentials and run `scripts/verify-external-providers.ts`
4. Do not enable LIVE or mark external demo complete from fixtures

## Docs

`ACCEPTANCE_SCENARIOS.md` · `PROVIDER_CAPABILITIES.md` · `REQUIREMENTS_MATRIX.md` · `EVIDENCE.md` · `HANDOFF.md` · `RUNBOOKS.md` · `DECISIONS.md`
