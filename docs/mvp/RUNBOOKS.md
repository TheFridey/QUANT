# QUANT MVP — Operator Runbooks

## First session (MARKET_DATA_PAPER — no fixtures)

```bash
cp .env.example .env   # edit secrets; do NOT set LIVE flags
# start Postgres + Redis, then:
pnpm install && pnpm db:deploy && pnpm build:packages
pnpm --filter @odin/api dev &
pnpm --filter @odin/worker dev &
pnpm --filter @odin/web dev &
```

1. Open `/terminal`. Confirm **Execution = PAPER**, trading environment `MARKET_DATA_PAPER`, venue PAPER.
2. Defaults: `multiMarketPaperIngest=false`, `tradingEnvironment=MARKET_DATA_PAPER` — Solana DexScreener only. **No FX/ETF fixtures are injected.**
3. Optional delayed FX marks: set engine config `marketDataPaperFxIngest=true` (Frankfurter ECB reference — DELAYED, not LIVE).
4. Start engine. Wait for a cycle with LIVE Solana pairs (if DexScreener reachable).
5. Risk panel: mode, environment, funnel, unresolved protection, why-blocked, alerts.
6. Promote a reviewed strategy via `/evolution/promote` (OPERATOR). Fills stamp `id@version+src:…+art:…`.
7. Never set `EXECUTION_MODE=LIVE` expecting fills — MVP refuses live broker submission.

## Explicit FIXTURE launch (isolated)

Fixtures use a **separate** environment and must not touch the primary market-data paper account metrics.

1. Set engine config: `tradingEnvironment=FIXTURE` (and optionally `multiMarketPaperIngest` ignored unless FIXTURE).
2. Terminal shows a permanent **FIXTURE MODE** banner on Overview.
3. Sequences include warmup / no-signal / wins / losses / gap-through-stop / wide-spread failure. FX/ETF have **no fake DEX txn counts**.
4. Account id convention: `primary:fixture` for ledger isolation helpers (`accountIdForEnvironment`).

## EXTERNAL_DEMO (named providers)

`EXTERNAL_DEMO_API_KEY` alone does **nothing**. Configure named practice credentials:

```bash
# Alpaca paper (ETF/equity)
export ALPACA_API_KEY_ID=...
export ALPACA_API_SECRET_KEY=...

# OANDA fxTrade Practice (FX)
export OANDA_API_TOKEN=...
export OANDA_ACCOUNT_ID=...

# Offline contracts (always):
pnpm exec vitest run packages/market-data/src/fx-feed.test.ts

# Credentialed smoke (exit 2 = BLOCKED_EXTERNAL_TEST):
pnpm build:packages
node scripts/verify-external-providers.mjs --provider alpaca_paper
node scripts/verify-external-providers.mjs --provider oanda_practice
```

See `docs/mvp/PROVIDER_CAPABILITIES.md`.

## Reconcile / entry suspension

- Worker executor runs paper self-truth reconcile each cycle.
- `ODIN_RECONCILE_FAULT=1` (tests/labs) injects unknown exposure → durable `ENTRIES_SUSPENDED` → new entries blocked; **exits remain active**.
- **ACK ≠ resolve:** `POST /terminal/alerts/:id/ack` acknowledges the alert UI only. Safety suspension clears only on a **clean reconcile** report (`suspendEntries=false`).
- Protective exits that fail create `ProtectionIntent` UNRESOLVED + `PROTECTION_EXIT_FAILED` alert; retries do not permanently suppress because a helper said TRIGGERED.

## LIVE gate

- Default PAPER. LIVE requires `LIVE_MONEY_ENABLED=true` and `LIVE_MONEY_CONFIRM=I_UNDERSTAND_LIVE_RISK` **and** still refuses because no live money broker route exists.

## Durable reservations / protection

```bash
# Adversarial in-memory + PG race (≥2 workers):
pnpm exec vitest run packages/risk-engine/src/reservations.test.ts packages/risk-engine/src/pg-reservations.test.ts

# Long/short OCO + failed exit lifecycle:
pnpm exec vitest run packages/trading-engine/src/protection.test.ts packages/trading-engine/src/protection-lifecycle.test.ts
```

## Capacity note

In-process `ReservationLedger` admitting 50 slots is **not** a production queue/worker/DB capacity claim. Production-shaped soak requires BullMQ workers + Postgres under load (see EVIDENCE.md).
