# QUANT MVP — Evidence Log

## Baseline

- Review baseline: `05143f1d8f1941a0377737490f3ad40285532e57`
- Continuation commits: see `git log 05143f1..HEAD`

## Credential inventory (names only)

| Variable | Present locally | Notes |
| --- | --- | --- |
| `DATABASE_URL` / `DATABASE_URL_TEST` | yes | local Postgres |
| `REDIS_URL` | yes | local Redis |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | empty | BLOCKED_EXTERNAL_TEST |
| `OANDA_API_TOKEN` / `OANDA_ACCOUNT_ID` | empty | BLOCKED_EXTERNAL_TEST |
| `EXTERNAL_DEMO_API_KEY` | empty | **insufficient alone** |
| `BIRDEYE_API_KEY` | empty | security UNKNOWN |
| `OPENAI_API_KEY` | empty | mock LLM |

## Defect verification vs baseline `05143f1`

| # | Finding | Verdict after continuation |
| --- | --- | --- |
| 1 | `external-demo` placeholder; key cannot unblock | **FIXED** — Alpaca+OANDA named adapters; generic key still insufficient (offline test) |
| 2 | `paper-multimarket` fixed levels + synthetic momentum into paper | **FIXED** — default off; FIXTURE sequences isolated; no DEX txns for FX/ETF |
| 3 | `protection.ts` long-only helper, not durable worker | **PARTIAL→IMPROVED** — long/short + worker arm/evaluate + ProtectionIntent on failure |
| 4 | `reservations.ts` in-process only; releasePartial adversarial | **FIXED** — adversarial releasePartial + `PostgresReservationAuthority` race test |
| 5 | Concurrent strategies partial | **IMPROVED** — durable StrategyInstance + evaluate/allocate |
| 6 | 50 in-process slots ≠ prod capacity | **DOCUMENTED** — report labels `productionShaped: false` |
| 7 | Matrix DONE inflation | **FIXED** — ACCEPTANCE_SCENARIOS per-stage statuses |

## Commands / results (record after each push)

```text
pnpm build:packages   # must be clean
pnpm typecheck        # must be clean
pnpm lint             # must be clean
pnpm test             # see count below
pnpm db:deploy        # includes 20261028240000_mvp_durable_authority_isolation
pnpm build            # api/worker/web production builds
```

### Latest local run

```text
pnpm test             # 192 passed / 1 skipped (sandbox-dependent skips reported accurately elsewhere)
pnpm build:packages   # clean
```

### Targeted verification suite mapping

| # | Scenario | Command | Result |
| --- | --- | --- | --- |
| 1 | Engine regressions | `vitest run packages/agent-core/src/gate-a.regression.test.ts` | pass |
| 2 | Fixture isolation | `vitest run packages/market-data/src/paper-multimarket.test.ts packages/shared/src/environments.test.ts` | pass |
| 3 | Named provider contracts | `vitest run packages/market-data/src/fx-feed.test.ts` | pass |
| 4 | Credentialed providers | `node scripts/verify-external-providers.mjs` | exit 2 BLOCKED_EXTERNAL_TEST (no keys) |
| 5 | PG concurrent admission | `vitest run packages/risk-engine/src/pg-reservations.test.ts` | pass (2-worker race admits exact 2) |
| 6 | Reservation adversarial | `vitest run packages/risk-engine/src/reservations.test.ts` | pass |
| 7–11 | Protection lifecycle | `vitest run packages/trading-engine/src/protection*.test.ts` | pass |
| 12–13 | Pause/ACK | `vitest run packages/trading-engine/src/alerts-ack.test.ts` + reconcile tests | pass |
| 14 | Concurrent instances | `vitest run packages/agent-core/src/strategy-instances.test.ts` | pass |
| 15 | FX sessions | `vitest run packages/shared/src/sessions.test.ts` | pass |
| 16 | Replay isolation | DATA_MODE=replay path (PARTIAL — REPLAY account isolation helpers present) | PARTIAL |
| 17 | External manual position | policy: refuse fake LIVE; named adapters only | documented |
| 18 | Normal paper ≠ fixtures | default config + isolation tests | pass |

### Migrations

- Applied: `20261028240000_mvp_durable_authority_isolation` on `odin` and `odin_test` without record loss (additive ALTER/CREATE).

### Capacity / soak

- In-process 50 protected slots: measured, **not** production-shaped.
- Target 200 instruments / 50 protected / 20 simultaneous across 3 classes: harness partial — use FIXTURE capital explicitly when claiming fixture soak.
- Longer owner soak: run worker against FIXTURE env with stepped sequences; label results as fixture soak.

### Security sandbox

- Bubblewrap-dependent evolution tests may skip or fail without `bwrap` — report as environment skip, not trading regression.
