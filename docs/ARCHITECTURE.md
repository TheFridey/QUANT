# ODIN // QUANT architecture

Paper-only Solana research terminal. Market prices come from providers. The ledger is the only source of balances and performance. Deterministic code sizes positions, applies fills, and enforces risk. LLM output is advisory only and never overrides risk, sizing, or accounting. No model is asked to do arithmetic.

## System shape

```text
DexScreener ──► ingest job ──► MarketObservation (+ watchlist)
Birdeye (optional, historical / security / holders only)
    │
    ▼
BullMQ: sentinel → pulse → aegis → atlas → executor → archivist
    │
    ▼
PostgreSQL ledger (orders, fills, positions, cash, equity snapshots, research proposals)
    │
    ▼
NestJS API + Socket.IO ──► Next.js terminal
```

Redis is both the BullMQ broker and the ephemeral fanout (`odin:terminal`, `odin:agent-bus`). PostgreSQL is the durable record. A lost pub/sub message does not lose a fill.

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/shared` | Zod contracts, decimal helpers, freshness, agent contracts, Prisma client, foundation seed |
| `packages/market-data` | Provider interface, DexScreener adapter, optional Birdeye adapter |
| `packages/risk-engine` | Portfolio gates, aggregate exposure, HWM drawdown, circuit breaker |
| `packages/trading-engine` | Stop-distance sizing, quote/fill with spread + impact, ledger mutation |
| `packages/agent-core` | Six agents, LLM provider abstraction, offline walk-forward research |
| `packages/analytics` | Mark-to-market and performance (sample sizes, observed vs incomplete) |
| `apps/api` | Auth, controls, snapshot (agent status, watchlist, metrics) |
| `apps/worker` | Scheduled ingest and the agent job chain |
| `apps/web` | Terminal with per-agent status panel |

## Data states

Freshness is a function of provider mode and receipt time. It is never inferred from a missing timestamp.

| State | Meaning |
| --- | --- |
| `LIVE` | `DATA_MODE=live` and the snapshot was received within `liveMaxAgeMs` |
| `DELAYED` | Received after the live window and within `delayedMaxAgeMs` |
| `STALE` | Older than the delayed window, or the clock moved backwards |
| `REPLAY` | Rows copied from stored observations. Not a live quote. |
| `DEMO` | Provider calls are disabled. No prices are synthesized. |

Entries require a `LIVE` quote and a `LIVE` book valuation. Exits may use `DELAYED` quotes only when `allowDelayedExits` is on. `STALE`, `REPLAY`, and `DEMO` cannot open or close risk. A missing mark makes equity `null` and blocks new entries. It is not treated as zero P&L.

## Agents

Each agent is a pure function with a fixed `modelVersion`, a confidence in `[0, 1]`, stable reason codes, `inputSource`, and `durationMs`. BullMQ runs them as separate durable jobs. The payload between jobs is the `cycleId`. Each stage reloads PostgreSQL and upserts its decisions on `(cycleId, agent, pairAddress)`.

| Agent | Role |
| --- | --- |
| SENTINEL | Discovery + quote integrity. Ranks a deduped watchlist from real DexScreener fields (age, liquidity, volume, txns). Missing fields stay null. |
| PULSE | Market intelligence from timestamped `MarketObservation` history (acceleration, imbalance, momentum, manipulation warnings) plus long-only entry/exit rules. Insufficient history returns limitations — never invented indicators. |
| AEGIS | Security. Categories `PASS` \| `REVIEW` \| `BLOCK` \| `UNKNOWN`. `UNKNOWN ≠ PASS`. `BLOCK`/`REVIEW` hard-stop simulated entry. Without `BIRDEYE_API_KEY`, assessment is `UNKNOWN` / unavailable (paper path continues; not treated as PASS). |
| ATLAS | Portfolio risk + sizing. Institutional caps, stop-distance size, aggregate exposure, HWM drawdown, independent circuit breaker. Engine halt checks live here with the risk engine. |
| EXECUTOR | Paper execution realism: observed mid, spread estimate, impact, fees, explicit cost fields, latency/expiry metadata. Fills only at observable prices. Idempotent `clientOrderId`. |
| ARCHIVIST | Immutable cycle record, equity snapshots, research metrics with sample sizes. Optional LLM advisory text only. |

The default strategy is long-only spot. A 5-minute gain at or above `entryM5ChangePct` and at most `maxEntryM5ChangePct`, a non-negative 1-hour change, more 5-minute buys than sells, and a quote mint of wrapped SOL, USDC, or USDT can open a position. A wider 5-minute print is `PRICE_ANOMALY` and does not open risk. Stops, take-profits, and a 5-minute fade still close an open position from the observed mark. If those inputs are absent, the cycle holds.

Operator tickets skip the momentum rule and are labeled `OPERATOR_OVERRIDE`. They still pass SENTINEL, AEGIS, ATLAS, and the locked fill.

### Institutional risk defaults

Older configs merge missing keys from `DEFAULT_STRATEGY`:

| Limit | Default |
| --- | --- |
| `maxRiskPerTradePct` | `0.5` |
| `maxPositionPctEquity` | `5` |
| `maxAggregateExposurePct` | `20` |
| `maxDailyLossPct` | `3` |
| `maxTotalDrawdownPct` | `10` |
| `maxPositions` | `4` |
| `maxPriceImpactBps` | `150` |

## Accounting

- Money is `decimal.js`, quantized to 8 decimal places. Quantity rounds down.
- `priceUsd` from DexScreener is accepted only as a string.
- Buy cash movement is `-(notional + fee)`. Sell cash movement is `+(notional - fee)`.
- Fees enter the cost basis. Realized P&L is informational and does not move cash a second time.
- Cash must equal the sum of cash-affecting ledger rows.
- Fill price is the observed mid adjusted by participation impact and optional half-spread; rejected when impact exceeds `maxSlippageBps` / `maxPriceImpactBps`.
- `clientOrderId` is unique. A retried job cannot double-fill.
- The account row is locked with `FOR UPDATE` before a fill is applied.
- There is no wallet, private key, or external order route. Venue is `PAPER`.

## AI and learning

- `packages/agent-core` model-provider abstraction: hosted OpenAI-compatible APIs, optional Hermes base URL, mock/no-key offline path.
- Advisory JSON is Zod-validated. It may annotate ARCHIVIST/AEGIS review text only.
- Offline walk-forward research produces `ResearchProposal` rows. `promoted` stays false until an operator applies a patch outside the RUNNING path. No unsupervised live mutation.

## Engine

`STOPPED → start → RUNNING → pause → PAUSED → resume → RUNNING`.

`emergency_stop` from `RUNNING`, `PAUSED`, or `STOPPED` enters `EMERGENCY_STOP`. Optional flatten uses the next cycle and only pairs that still have an allowable mark. `resume` leaves the halt. `stop` from `PAUSED` or `EMERGENCY_STOP` returns to `STOPPED`.

Starting balance defaults to `100` USD and can be changed only while the engine is `STOPPED` and no orders exist.

## Auth and operations

JWT bearer tokens. Administrative mutations require role `ADMIN`. `/api/health` and `/api/auth/login` are public. Production boot refuses the sample JWT secret and sample password. Health reports Postgres, Redis, the latest observation, and whether the worker's last cycle is current.

## Acceptance

- A DexScreener snapshot is stored with `source=dexscreener`, pair id, and `receivedAt`. Optional `pairCreatedAt` / `fdv` / `marketCap` are null when absent.
- The terminal badge shows `LIVE`, `DELAYED`, `STALE`, `REPLAY`, or `DEMO` from that receipt. It does not show a price that was not stored.
- Each agent panel row shows latest decision, input source, duration, and outcome.
- With the engine `RUNNING` and a quote that passes the gates, one paper fill, ledger rows, and a position are persisted. A second delivery of the same cycle does not add another fill.
- Portfolio cash, quantity, and P&L on screen match the API, and the API matches the ledger.
- A missing price, missing liquidity, stale quote, halted engine, security BLOCK/REVIEW, or breached loss/drawdown limit produces an audit row and no fill.
- Birdeye without `BIRDEYE_API_KEY` returns `UNAVAILABLE` / security `UNKNOWN` and no candles.
- LLM without a key uses the mock provider; advisory never sizes or fills.
- Engine start, pause, resume, and emergency stop follow the state machine and reject illegal transitions.
- `GET /api/health` fails readiness when Postgres or Redis is down.
- Tests cover fill quantization, risk rejection, freshness, the DexScreener parser, pulse insufficient history, security UNKNOWN/BLOCK, circuit breaker, walk-forward proposals, and one database-backed cycle.
