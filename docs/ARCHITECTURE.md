# ODIN // QUANT architecture

Paper-only Solana research terminal. Market prices come from providers. The ledger is the only source of balances and performance. Deterministic code sizes positions, applies fills, and enforces risk. LLM output is advisory only and never overrides risk, sizing, or accounting. No model is asked to do arithmetic.

## System shape

```text
DexScreener ──► ingest job ──► MarketObservation (+ watchlist)
Birdeye (optional, historical / security / holders only)
    │
    ▼
BullMQ: sentinel → pulse → aegis → atlas → executor → archivist
    │                              ▲
    │                              │ (unchanged live paper path)
    ▼                              │
PostgreSQL ledger + research lab ──┘
  (orders, fills, StrategyVersion, BacktestRun/Trade,
   ExperimentMetrics, ObservabilityEvent, OracleReview)
    │
    ├── NestJS API + Socket.IO ──► Next.js terminal
    └── packages/backtest event replay (offline) + ORACLE advisory
```

Redis is both the BullMQ broker and the ephemeral fanout (`odin:terminal`, `odin:agent-bus`). PostgreSQL is the durable record. A lost pub/sub message does not lose a fill.

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/shared` | Zod contracts, decimal helpers, freshness, agent contracts, Prisma client, foundation seed |
| `packages/market-data` | Provider interface, DexScreener adapter, optional Birdeye adapter |
| `packages/risk-engine` | Portfolio gates, aggregate exposure, HWM drawdown, circuit breaker |
| `packages/trading-engine` | Stop-distance sizing, quote/fill with spread + impact, ledger mutation |
| `packages/agent-core` | Six pipeline agents + optional ORACLE supervisor, LLM abstraction, walk-forward research |
| `packages/analytics` | Mark-to-market, performance, in-process observability counters |
| `packages/backtest` | Event-driven historical replay, data-quality reports, validation, baselines, HTML reports |
| `apps/api` | Auth, controls, snapshot, Strategy Lab / backtest / ORACLE endpoints |
| `apps/worker` | Scheduled ingest and the agent job chain (live paper path unchanged) |
| `apps/web` | Terminal with per-agent status, Strategy Laboratory, Backtesting |

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
- **ORACLE** is a seventh optional supervisory module. It does not execute trades, does not size, and does not mutate a RUNNING engine. Human approval is required for suggested paper follow-ups. There is **no real-money venue** and no auto-graduation path.

## Quantitative research laboratory

- `packages/backtest` replays `MarketObservation` / fixture series in `receivedAt` order. Fills use only prices available at event time plus configured latency (no look-ahead).
- Costs: fee bps, spread estimate, participation impact, liquidity caps, missed/rejected orders, stop/take/trailing/max-hold exits, force liquidation at end.
- Data quality reports missing prices/liquidity, gaps, disappeared pairs, and inactive tokens — they are **not** silently dropped from the universe.
- Validation: chronological train/validation/test splits, sample gates, Monte Carlo trade-sequence resampling (seeded), baselines (cash, buy-and-hold when endpoints exist, simple momentum rule), release gates that always require forward paper evaluation.
- Insufficient evidence is returned as `null` metrics with `INSUFFICIENT_EVIDENCE` labels — never fabricated confidence.
- HTML research reports: `GET /api/lab/backtests/:id/report`.
- Limitations: survivorship bias is disclosed not corrected; data gaps block fills; paper ≠ live; one profitable night is never “validated.”

## PROJECT EVOLUTION (extension layer)

See `docs/EVOLUTION.md`. Live paper BullMQ path is unchanged.

| Piece | Location |
| --- | --- |
| Instrument registry + market selector | `packages/shared` instruments, `packages/market-data` registry + index feed, `/api/evolution/markets` |
| Multi-model router (tiers, budgets, fallback) | `packages/evolution` router; usage in `ModelUsageLog` |
| Research pipeline OBSERVE→REVIEW | `packages/evolution` pipeline + forge sandbox + challenge + signed reports |
| Deep trade memory | `TradeMemory` + `/api/evolution/memory` (post-exit excluded from entry reconstruction) |
| Autonomy 0–3 (4 disabled) | `AutonomyControl` + `/api/evolution/autonomy` |
| ORACLE queues / briefings | `ResearchQueueItem` + research centre endpoints |
| Command centre modules | Market Selector, AI Research Centre, Model Ops, Genome, Memory, Autonomy |

### Forge sandbox contract (`packages/evolution/src/sandbox-runner.ts`)

- **Isolation boundary** is bubblewrap (user, net, pid, ipc, uts namespaces; read-only root; uid 65534) plus the x86_64 seccomp preload. The static source check is a **lint** for honest mistakes, not a security control.
- **Streaming protocol.** The host writes a header (contract version, metadata, history limit, artifact hash, per-run nonce), waits for `ready`, then writes exactly one bar and waits for exactly one frame before the next. The sandbox never holds a bar the strategy has not been shown, so scanning `/proc/self/mem` cannot reveal future bars. Per-bar and overall timeouts both apply; either yields `SANDBOX_TIMEOUT`.
- **Results** travel only on fd 3, a pipe opened by the host. stdout/stderr are diagnostics and are never parsed. Each frame must echo the run nonce, the expected sequence number and a fresh per-bar token sent with that bar, so a frame written before its bar was sent is rejected, never buffered for later. Any extra frame (a second answer for a bar) fails the run. The host re-validates every signal with `strategySignalSchema`, checks it names the delivered bar's instrument, and requires one signal per bar; anything else is `CONTRACT_FAIL` or `SANDBOX_PROTOCOL`. The nonce is defence in depth: the strategy shares the harness process, so the guarantee is that it can only ever emit a contract-valid signal for the bar it was given.
- **Memory** is bounded by `RLIMIT_AS`, measured per host as Node's peak virtual size inside bubblewrap plus 256 MiB, and reported as `memoryEnforcement: "rlimit-as"`. `--max-old-space-size` is advisory only.
- **No `/proc`.** Strategy runs do not mount `/proc` (CI showed Node starts without it), so a strategy cannot read `/proc/self/mem` at all. The look-ahead test mounts it deliberately to prove the streaming protocol alone is sufficient.
- **Seccomp binaries** are built at install/build time by `packages/evolution/scripts/build-sandbox.mjs` into `packages/evolution/sandbox/build/` (binaries mode 0555) with SHA-256 recorded in `manifest.json`. The runner pins those hashes on first load, re-hashes the files before every run, and also requires `seccomp.so` to embed the BPF program whose SHA-256 is committed in `sandbox/seccomp-bpf.sha256` (generated from `src/seccomp-profile.ts`); any mismatch refuses the run. The postinstall never fails `pnpm install`; without a build the runner reports seccomp unavailable.
- **Threat model.** These hashes catch accidental corruption, stale builds and edits after the process started; they do not stop someone who can already write to the repository checkout, who could change the runner itself. The real M2 fix is that binaries no longer live in shared `/tmp`, where another local user could pre-plant them. Without seccomp (non-x86_64 or no gcc) isolation reports unavailable unless `ODIN_SANDBOX_ALLOW_NO_SECCOMP=true`, in which case the runner reason says `seccomp: unavailable`.

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
