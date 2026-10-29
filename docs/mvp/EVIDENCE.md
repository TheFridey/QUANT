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
pnpm test             # 239 passed / 1 skipped
pnpm typecheck        # clean
pnpm lint             # clean
pnpm build            # api/worker/web clean
pnpm db:deploy        # 20261029070000 present on odin + odin_test
node scripts/verify-external-providers.mjs  # exit 2 BLOCKED_EXTERNAL_TEST
node scripts/soak-capacity.mjs              # fixture_shaped_soak exit 0 (prior)
```

### Targeted additions this increment

| Area | Command | Result |
| --- | --- | --- |
| Organic discovery | `vitest run packages/market-data/src/dexscreener.test.ts` | pass (boosts optional) |
| Gateway | `vitest run packages/market-data/src/gateway.test.ts` | pass |
| Session equity | `vitest run packages/shared/src/session-equity.test.ts` | pass |
| Operating controls | `vitest run packages/risk-engine/src/operating-controls.test.ts` | pass |
| Hard blocks | `vitest run packages/shared/src/blocks.test.ts` | pass |
| Strategy instances IT | `vitest run packages/agent-core/src/strategy-instances.integration.test.ts` | pass |
| Funnel uniqueness | `vitest run packages/agent-core/src/funnel.test.ts` | pass |
| Reconcile depth | `vitest run packages/trading-engine/src/fault-injection.test.ts` | pass |
| Observability | `vitest run packages/analytics/src/observability.test.ts` | pass |
| Migration smoke | `vitest run packages/shared/src/migration-schema.test.ts` | pass |
| Research honesty | `vitest run packages/evolution/src/research-artifact-honesty.test.ts` | pass |

### Migrations

- `20261029070000_mvp_protection_ack_replay_isolation` verified via `migration-schema.test` column presence.

### Capacity / soak

- `scripts/soak-capacity.mjs` remains fixture-shaped without live feeds; not a live SLO claim.

### Security sandbox

- Bubblewrap-dependent evolution tests may skip — environment skip, not trading regression.
