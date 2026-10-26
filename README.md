# ODIN // QUANT

Paper-only Solana research terminal. It records DexScreener snapshots, runs six deterministic agents, and books simulated fills against those observations. Balances and performance come from the ledger. Nothing here signs a transaction or holds a private key.

## What it does

- Polls DexScreener for Solana pairs and stores each observation with source, pair id, and receipt time.
- Labels every quote `LIVE`, `DELAYED`, `STALE`, `REPLAY`, or `DEMO`. Demo mode does not invent prices.
- Runs SENTINEL, PULSE, AEGIS, ATLAS, EXECUTOR, and ARCHIVIST as separate BullMQ jobs.
- Opens a paper account at the configured starting balance (default `$100`) and rejects orders that fail data or risk gates.
- Streams cycle updates to the terminal over Socket.IO. The screen reloads figures from PostgreSQL.

Birdeye candles, token security, and holder stats are optional. Without `BIRDEYE_API_KEY` those routes return `UNAVAILABLE`.

## Local run

PostgreSQL 16 and Redis 7 are required. Docker Compose is the intended setup:

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:deploy
pnpm dev
```

The API listens on [http://127.0.0.1:4318](http://127.0.0.1:4318) and the terminal on [http://127.0.0.1:4317](http://127.0.0.1:4317).

The local seed, until you change `.env`, is `admin@odin.local` / `odin-paper-dev`. Production boot refuses that password and the sample JWT secret.

If Docker is not available, point `DATABASE_URL` and `REDIS_URL` at any reachable Postgres and Redis, then run the same Prisma and `pnpm dev` commands.

## Checks

```bash
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm test` includes a database test when `DATABASE_URL_TEST` points at a database whose name contains `odin_test`. Create that database before running it. Unit tests do not need it.

## Trading rules

The default strategy is long-only. A new position needs a live positive price, liquidity and volume above the floors, a 5-minute move of at least 2%, a non-negative 1-hour move, and more 5-minute buys than sells. Size is capped by cash, a percentage of equity, and a percentage of pool liquidity. The fill price is the observed mid adjusted by `notional / liquidity`. If that slippage exceeds the configured maximum, the order is rejected.

Stops, take-profits, and a 5-minute fade close the whole position. Operator tickets skip the momentum rule, are labeled `OPERATOR_OVERRIDE`, and still pass surveillance, risk, and the locked fill.

Missing marks do not count as zero P&L. Equity is omitted until every open position has a price.
