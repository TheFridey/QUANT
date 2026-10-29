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

## Latest local run

```text
pnpm test             # 279 passed / 1 skipped
pnpm typecheck        # clean
pnpm lint             # clean
pnpm build            # api/worker/web clean
pnpm db:deploy        # no new migration this increment (additive-only)
node scripts/verify-external-providers.mjs  # exit 2 BLOCKED_EXTERNAL_TEST
node scripts/soak-capacity.mjs              # fixture_shaped_soak (not live SLO)
```

### Targeted additions this increment

| Area | Command | Result |
| --- | --- | --- |
| Distributed Redis-shaped leases | `vitest run packages/risk-engine/src/redis-worker-lease.test.ts` | pass |
| BullMQ lease wiring | `vitest run apps/worker/src/stage-lease.wiring.test.ts` | pass |
| Product catalog / futures refuse | `vitest run packages/shared/src/product-semantics.test.ts` | pass |
| Frankfurter/ETF offline honesty | `vitest run packages/market-data/src/fx-feed.test.ts` | pass |
| Contract map D54 | `vitest run packages/agent-core/src/acceptance-contract-map.test.ts` | pass |
| Multi-market E2E deepen | `vitest run packages/agent-core/src/multi-market.e2e.test.ts` | pass |

### Migrations

- No new migration this increment.

### Capacity / soak

- `scripts/soak-capacity.mjs` remains fixture-shaped without live feeds; exit 0 ≠ live SLO / VERIFIED_EXTERNAL.

### Security sandbox

- Bubblewrap-dependent evolution tests may skip — reported as `SKIP_ISOLATION_UNAVAILABLE`, not a trading regression.
