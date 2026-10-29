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
pnpm test             # 267 passed / 1 skipped
pnpm typecheck        # clean
pnpm lint             # clean
pnpm build            # api/worker/web clean
pnpm db:deploy        # prior migrations; additive only this increment (no new migration)
node scripts/verify-external-providers.mjs  # exit 2 BLOCKED_EXTERNAL_TEST
node scripts/soak-capacity.mjs              # fixture_shaped_soak (not live SLO)
```

### Targeted additions this increment

| Area | Command | Result |
| --- | --- | --- |
| Sessions holidays/DST/FX weekend | `vitest run packages/shared/src/sessions.test.ts` | pass |
| Held multi-market marks | `vitest run packages/shared/src/held-marks.test.ts` | pass |
| Product semantics labels/pip | `vitest run packages/shared/src/product-semantics.test.ts` | pass |
| Risk hierarchy / breakers | `vitest run packages/risk-engine/src/risk-hierarchy.test.ts` | pass |
| Worker leases | `vitest run packages/risk-engine/src/worker-lease.test.ts` | pass |
| Desired vs ACK / order ack | `vitest run packages/trading-engine/src/venue-protection.test.ts` | pass |
| Data integrity windows | `vitest run packages/evolution/src/data-integrity.test.ts` | pass |
| Instance attribution | `vitest run packages/analytics/src/attribution.test.ts` | pass |
| Alerts ops depth | `vitest run packages/agent-core/src/alerts.test.ts` | pass |
| Multi-market held+session E2E | `vitest run packages/agent-core/src/multi-market.e2e.test.ts` | pass |
| Sandbox skip/pass honesty | `vitest run packages/evolution/src/research-artifact-honesty.test.ts` | pass |

### Migrations

- No new migration this increment (additive-only rule respected; prior `20261029070000` unchanged).

### Capacity / soak

- `scripts/soak-capacity.mjs` remains fixture-shaped without live feeds; exit 0 ≠ live SLO / VERIFIED_EXTERNAL.

### Security sandbox

- Bubblewrap-dependent evolution tests may skip — environment skip reported honestly as `SKIP_ISOLATION_UNAVAILABLE`, not a trading regression.
