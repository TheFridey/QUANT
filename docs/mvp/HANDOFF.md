# QUANT MVP — Handoff

## Branch / PR

- Branch: `cursor/quant-mvp-multimarket-5f64`
- Base: `main`
- PR: https://github.com/TheFridey/QUANT/pull/2
- Baseline reviewed: `05143f1`
- HEAD: `fe818e3183ff609dc657c9b1173a75970282a572`

## What works end-to-end

- Gate A engine fixes preserved
- **Fixture isolation:** defaults no longer inject FX/ETF/commodity fixtures into paper; FIXTURE env + banner + sequenced ticks
- **Named providers:** Alpaca paper + OANDA practice + Frankfurter FX marks; readiness enum; offline contracts; bracket/protective desired→ACK helpers (no fake external success)
- **Durable PG reservations:** transactional authority, mutation events, 2-worker race, adversarial releasePartial, **`reserveInTx` on worker ENTRY admission**
- **Protection:** long/short OCO; worker arms on BUY fill; evaluates marks; failed exit → ProtectionIntent UNRESOLVED + alert + retry; **crash/restart recovery**; **amendment failure keeps last confirmed**; **2-worker OCO claim race**
- **Shared exit rules + deterministic clock** for backtest/runtime parity (stop/target/trailing/time/fees/gaps/pending)
- **Commodity product semantics:** currency/multiplier/costs for paper proxies; unknown commodity refuses invented futures economics
- **REPLAY isolation:** funnel + equity snapshots + terminal metrics scoped by `metricsAccountIdFor`
- **Market cost models:** FX/ETF/commodity without DEX impact
- **Strategy instances:** durable records seeded (≥3 crypto/FX/ETF), concurrent evaluate/allocate gating entries in `loadPlan`
- **Soak:** `scripts/soak-capacity.mjs` on real PG reservation/protection path (fixture-shaped when no live feeds)
- LIVE remains gated/refused

## Gate progress (honest)

See `ACCEPTANCE_SCENARIOS.md` + `REQUIREMENTS_MATRIX.md`.

| Status | Count |
| --- | --- |
| VERIFIED_OFFLINE | 25 |
| PARTIAL | 29 |
| IMPLEMENTED_UNVERIFIED | 3 |
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
node scripts/soak-capacity.mjs          # after build:packages; fixture-shaped without live feeds
node scripts/verify-external-providers.mjs
```

## Unresolved defects / blockers

1. Credentialed Alpaca/OANDA external verification → **BLOCKED_EXTERNAL_TEST** (setup in PROVIDER_CAPABILITIES / RUNBOOKS)
2. Birdeye security UNKNOWN without API key
3. Venue-native protection ACK only offline-contracted — no credentialed bracket smoke
4. Concurrent strategy instance multi-worker soak still depth-PARTIAL (C32/C33 IMPLEMENTED_UNVERIFIED)
5. D45–D48 terminal depth improved (confirmed vs helper, unresolved, readiness) but not a redesign
6. CL futures contract multiplier intentionally unsupported — paper proxy only
7. Production soak is queue/DB-shaped for reservations/protection; not a live-feed SLO claim

## Owner next actions

1. Walk `docs/mvp/RUNBOOKS.md` first session on **MARKET_DATA_PAPER** (confirm no fixture banner)
2. Optionally enable `marketDataPaperFxIngest` for Frankfurter delayed FX
3. Supply practice credentials and run `scripts/verify-external-providers.ts`
4. Do not enable LIVE or mark external demo complete from fixtures
5. Review PR #2 — if ManagePullRequest unavailable, use title/body below

## PR title / body (coordinator — ManagePullRequest unavailable in this agent)

**Title:** `feat(mvp): crash-safe protection, replay isolation, exit parity, commodity semantics`

**Body:**

```markdown
## Summary
Continues QUANT multi-market MVP on durable protection, backtest/runtime parity, commodity product honesty, REPLAY metrics isolation, venue-native desired→ACK paths, and production-shaped PG soak.

## Landed
- Multi-worker OCO claim race + crash/restart recovery; amendment failure keeps last confirmed protection
- Shared deterministic clock + exit rules; parity tests (stop/target/trailing/time/fees/gaps/pending)
- Commodity paper-proxy semantics (currency/multiplier/costs); unknown commodity unsupported
- REPLAY account scoping on funnel/equity/terminal metrics
- Alpaca bracket + OANDA protective order desired→ACK helpers (no fake external success)
- `scripts/soak-capacity.mjs` fixture-shaped PG soak (50 slots / 3 workers / 20 OCO races)
- Terminal UX: confirmed vs helper protection, unresolved actions, provider readiness, REPLAY banner

## Matrix
VERIFIED_OFFLINE 25 · PARTIAL 29 · IMPLEMENTED_UNVERIFIED 3 · BLOCKED_EXTERNAL_TEST 1 · VERIFIED_EXTERNAL 0

## Verify
- `pnpm test` → 223 passed / 1 skipped
- `pnpm typecheck` / `pnpm lint` / `pnpm build` clean
- `pnpm db:deploy` → `20261029070000_mvp_protection_ack_replay_isolation`
- `node scripts/soak-capacity.mjs` → metSlotTarget + ocoExactlyOnePerGroup
- `node scripts/verify-external-providers.mjs` → exit 2 without keys

## Residual PARTIAL highlights
B11–B14, B16, B20, B22, B24–B26, B29, C31/C36–C39/C41, D45–D52, D54–D57; C32/C33 still IMPLEMENTED_UNVERIFIED; C40 BLOCKED_EXTERNAL_TEST.
```

## Docs

`ACCEPTANCE_SCENARIOS.md` · `PROVIDER_CAPABILITIES.md` · `REQUIREMENTS_MATRIX.md` · `EVIDENCE.md` · `HANDOFF.md` · `RUNBOOKS.md` · `DECISIONS.md`
