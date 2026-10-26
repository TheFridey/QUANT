# ODIN // QUANT

Paper-only Solana research terminal. It records DexScreener snapshots, runs six deterministic agents, and books simulated fills against those observations. Balances and performance come from the ledger. Nothing here signs a transaction or holds a private key. LLM text is advisory only.

## What it does

- Polls DexScreener for Solana pairs and stores each observation with source, pair id, receipt time, and optional age/valuation fields when the provider supplies them.
- Labels every quote `LIVE`, `DELAYED`, `STALE`, `REPLAY`, or `DEMO`. Demo mode does not invent prices.
- Runs SENTINEL (discovery), PULSE (history + momentum), AEGIS (security), ATLAS (portfolio risk), EXECUTOR (paper fills), and ARCHIVIST (metrics) as separate BullMQ jobs.
- Persists watchlist ranks, security assessments (when Birdeye is configured), equity snapshots, and offline research proposals.
- Opens a paper account at the configured starting balance (default `$100`) and rejects orders that fail data or risk gates.
- Streams cycle updates to the terminal over Socket.IO. The screen reloads figures from PostgreSQL and shows per-agent status, input source, duration, and outcome.

Birdeye candles, token security, and holder stats are optional. Without `BIRDEYE_API_KEY` those routes return `UNAVAILABLE` and AEGIS records `UNKNOWN` (not PASS). Without an LLM key the mock provider serves offline advisory text only.

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

The default strategy is long-only with institutional paper limits: **0.5% risk per trade**, **5% max position**, **20% aggregate exposure**, **3% daily drawdown**, **10% total drawdown from HWM**, **4 concurrent positions**. Older configs merge missing keys from these defaults.

A new position needs a live positive price, liquidity and volume above the floors, a SOL, USDC, or USDT quote mint, a 5-minute move of at least 2% and at most 25%, a non-negative 1-hour move, and more 5-minute buys than sells. A larger 5-minute print is treated as an anomaly and does not open risk. Size uses stop distance, estimated costs, and the caps above. The fill price is the observed mid adjusted by participation impact and a configured half-spread. If impact exceeds the configured maximum, the order is rejected.

Stops, take-profits, and a 5-minute fade close the whole position. Operator tickets skip the momentum rule, are labeled `OPERATOR_OVERRIDE`, and still pass surveillance, risk, and the locked fill.

Missing marks do not count as zero P&L. Equity is omitted until every open position has a price. Research proposals from the walk-forward loop are never auto-applied to a RUNNING engine.

## Strategy Laboratory & backtesting

The live paper path (SENTINEL→ARCHIVIST) is unchanged. The research lab adds:

- Versioned strategies (`StrategyVersion`) and event-driven historical replay (`packages/backtest`) over persisted `MarketObservation` rows.
- Train / validation / untouched test splits, Monte Carlo resampling (seeded), baselines, cost-aware fills, and release gates that **never** auto-graduate to real money (there is no real-money venue).
- ORACLE advisory reviews with human approval — suggestions only; mock LLM when no key.
- HTML research report export: `GET /api/lab/backtests/:id/report` (auth required).

Workflow:

1. Pause the engine if changing live paper config; or snapshot a version in **Strategy Laboratory**.
2. Ensure observations exist (live ingest or `DATA_MODE=replay` fixtures).
3. Open **Backtesting**, select a strategy version, run historical replay.
4. Compare runs, request ORACLE review, export the HTML report.
5. Treat release gate `NOT_RELEASE_READY` as authoritative until forward paper evaluation completes.

### Limitations

- Survivorship: delisted / disappeared pairs are **reported**, not repaired.
- Data gaps and missing liquidity produce rejected orders, not invented fills.
- Paper accounting ≠ live venue microstructure.
- Optimisation that only maximises in-sample returns is rejected when sample gates fail.
- Docker Compose is the intended infra launcher; if Docker is unavailable, point `DATABASE_URL` / `REDIS_URL` at local Postgres/Redis (see acceptance notes under `docs/acceptance/research-lab.md`).
