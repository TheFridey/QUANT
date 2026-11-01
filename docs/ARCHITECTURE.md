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

Entries require a `LIVE` quote and a `LIVE` book valuation. A `DELAYED` quote never opens risk; exits may use one only when `allowDelayedExits` is on. `STALE` and `REPLAY` cannot open or close risk. `DEMO` quotes open paper risk only when `allowDemoPaperEntries` is on **and** `DATA_MODE=demo` (the flag defaults to off); in demo mode, exits may use `DEMO` quotes. A missing mark makes equity `null` and blocks new entries. It is not treated as zero P&L.

## Agents

Each agent is a pure function with a fixed `modelVersion`, a confidence in `[0, 1]`, stable reason codes, `inputSource`, and `durationMs`. BullMQ runs them as separate durable jobs. The payload between jobs is the `cycleId`. Each stage reloads PostgreSQL and upserts its decisions on `(cycleId, agent, pairAddress)`.

| Agent | Role |
| --- | --- |
| SENTINEL | Discovery + quote integrity. Ranks a deduped watchlist from real DexScreener fields (age, liquidity, volume, txns). Missing fields stay null. |
| PULSE | Market intelligence from timestamped `MarketObservation` history (acceleration, imbalance, momentum, manipulation warnings) plus long-only entry/exit rules. Insufficient history returns limitations — never invented indicators. |
| AEGIS | Security. Categories `PASS` \| `REVIEW` \| `BLOCK` \| `UNKNOWN`. `UNKNOWN ≠ PASS`. `BLOCK`/`REVIEW` hard-stop entries, and so does `UNKNOWN` for a Solana token (FX/ETF paper instruments have no token-security surface). Provider: Birdeye when `BIRDEYE_API_KEY` is set, else on-chain mint state via read-only Solana RPC (`SOLANA_RPC_URL`, default public mainnet): mint/freeze authority, Token-2022 restrictions, top-10 holder concentration, liquidity. The public endpoint refuses holder queries, so non-SOL tokens stay `UNKNOWN` until a dedicated RPC URL or Birdeye key is configured; native SOL passes on verified authority-free state. FIXTURE runs receive a labelled, never-persisted `mock` PASS. |
| ATLAS | Portfolio risk + sizing. Institutional caps, stop-distance size, aggregate exposure, HWM drawdown, independent circuit breaker. Engine halt checks live here with the risk engine. |
| EXECUTOR | Paper execution realism: observed mid, spread estimate, impact, fees, explicit cost fields, latency/expiry metadata. Fills only at observable prices. Idempotent `clientOrderId`. |
| ARCHIVIST | Immutable cycle record, equity snapshots, research metrics with sample sizes. Optional LLM advisory text only. |

The default strategy is long-only spot. A 5-minute gain at or above `entryM5ChangePct` and at most `maxEntryM5ChangePct`, a non-negative 1-hour change, more 5-minute buys than sells, and a quote mint of wrapped SOL, USDC, or USDT can open a position. A wider 5-minute print is `PRICE_ANOMALY` and does not open risk. Stops, take-profits, and a 5-minute fade still close an open position from the observed mark. If those inputs are absent, the cycle holds.

Operator tickets skip the momentum rule and are labeled `OPERATOR_OVERRIDE`. They still pass SENTINEL, AEGIS, ATLAS, and the locked fill.

### Institutional risk defaults

`DEFAULT_STRATEGY` in `packages/shared/src/strategy.ts` is authoritative. Older configs take missing keys from it; stored values are never rewritten. This table is generated from it, and CI fails if it drifts:

<!-- limits:start (generated from DEFAULT_STRATEGY by scripts/render-limits.mjs; do not edit) -->

| Limit | Default | Meaning |
| --- | --- | --- |
| `startingBalanceUsd` | `10000.00000000` | Paper account starting balance (USD) |
| `maxPositions` | `8` | Open positions at once |
| `maxRiskPerTradePct` | `0.5` | Stop-distance risk per trade, % of equity |
| `maxPositionPctEquity` | `5` | Single position size, % of equity |
| `maxAggregateExposurePct` | `20` | All open positions, % of equity |
| `maxDailyLossPct` | `3` | Daily loss, % of start-of-day equity (Europe/London day) |
| `maxTotalDrawdownPct` | `10` | Drawdown from high-water mark, % |
| `maxParticipationPctLiquidity` | `1` | Entry notional, % of pool liquidity |
| `maxSlippageBps` | `150` | Entry slippage cap (bps) |
| `maxPriceImpactBps` | `150` | Entry price-impact cap (bps) |
| `maxExitImpactBps` | `1000` | Exit impact per fill (bps); must be ≥ both entry caps; the rest becomes a pending reduce order |
| `minOrderNotionalUsd` | `25` | Smallest order (USD) |
| `minLiquidityUsd` | `25000` | Minimum pool liquidity for entry (USD) |
| `minVolume24hUsd` | `50000` | Minimum 24h volume for entry (USD) |
| `stopLossPct` | `3` | Stop loss, % |
| `takeProfitPct` | `5` | Take profit, % |
| `liveMaxAgeMs` | `45000` | Quote age still LIVE (ms) |
| `delayedMaxAgeMs` | `180000` | Quote age still DELAYED (ms); older is STALE |
| `allowDelayedExits` | `true` | Exits may use DELAYED quotes |
| `allowDemoPaperEntries` | `false` | DEMO entries (only ever with DATA_MODE=demo); DELAYED never opens risk |
| `paperLatencyMs` | `1000` | Earliest paper fill after the decision (ms); measured CI soak median 706 ms, rounded up |
| `orderExpiryMs` | `60000` | Pending order expiry (ms) |

<!-- limits:end -->

The daily loss limit is `maxDailyLossPct` of **start-of-day equity**. The trading day rolls at **Europe/London midnight** (BST/GMT aware). A day never rolls while equity is unknown; daily P&L then reads unavailable and entries are blocked until marks return. A breach latches: `PaperAccount.sessionLowEquityUsd` keeps the day's lowest equity, and once (low − start of day) reaches the limit, entries stay blocked until the next London day even if equity recovers. Each entry is also sized so that a stop-out plus worst entry and exit costs fits the loss headroom left today, after subtracting the stop-out risk of positions already open (ASCEND-00 F1/F2). The session low moves only on `LIVE`/`CASH_ONLY` valuations. Exits are never blocked by either rule.

An invalid stored config is never healed or rewritten. The worker raises a CRITICAL `CONFIG_INVALID` alert naming the failing fields, pauses entries, and keeps settling, exiting and protecting on `DEFAULT_STRATEGY` values until the operator corrects it. `scripts/report-invalid-configs.mjs` lists affected rows read-only.

## Accounting

- Money is `decimal.js`, quantized to 8 decimal places. Quantity rounds down.
- `priceUsd` from DexScreener is accepted only as a string.
- Buy cash movement is `-(notional + fee)`. Sell cash movement is `+(notional - fee)`.
- Fees enter the cost basis. Realized P&L is informational and does not move cash a second time.
- Cash must equal the sum of cash-affecting ledger rows.
- **Impact model.** DexScreener `liquidityUsd` is the whole pool, so the per-side reserve is `R = liquidityUsd / 2`. Constant-product average-price impact is `N / R` for a BUY of notional `N` and `N / (R + N)` for a SELL, floored at the former linear `N / liquidityUsd`. Fill price is mid adjusted by that impact and half the spread estimate. `Fill.slippageBps` records the realised slippage from mid (including adverse gap fills).
- **Entries** are rejected when impact exceeds `maxSlippageBps` or `maxPriceImpactBps`; sizing caps notional at `R · min(those caps)` so a max-size entry passes.
- **Exit execution policy.** Risk-reducing SELLs (EXIT, FLATTEN, protection closes, OPERATOR reduce) are never rejected for impact. They fill as much as stays within `maxExitImpactBps` at the modelled worse price; the rest is booked as a PENDING reduce order (`EXIT_PARTIAL_REMAINDER`, eligible immediately, normal expiry) that the next cycle's settle phase retries against a fresh quote. A STRATEGY remainder reserves its quantity first; if it cannot, nothing is booked and the next cycle plans a fresh exit. Exit reservations are released only inside `settlePendingOrder`.
- **Known bias (documented, not corrected).** Each remainder is quoted against fresh pool liquidity that does not subtract earlier paper sells in the same chain, so a very large exit split into chunks is modelled more favourably than one real constant-product exit. Backtests share this bias, and an end-of-run liquidation above the exit cap leaves the remainder marked at mid. Partial exits add one closed-P&L entry per chunk, which inflates trade counts in win-rate statistics.
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
- Solana discovery (`fetchSolanaUniverse`) draws from all WSOL pairs (`token-pairs/v1`), a short list of verified anchor mints and organic profile mints (`tokens/v1`), optional boosts, and the text search as a supplement only. Each pair is validated before it can enter the universe: a base/quote that claims SOL, WSOL, USDC or USDT under a non-canonical mint is an impersonation; stablecoin bases, pairs with no price, no 24h volume or no trades, and pools reporting more than 1000× their daily volume as liquidity are dropped. Survivors collapse to the most active pair per base mint and rank by 24h volume. A momentum window DexScreener omits (no trades in it) stays null, never 0%. (2026-10-31: the old search-first path had filled the whole universe with 19–22 counterfeit "SOL" pools, so no pair ever carried m5/h1 data.)
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
