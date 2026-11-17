# HORIZON Phase II: current state (17 Nov 2026)

Reconnaissance for OPERATION HORIZON Phase II (BREAKOUT). PAPER only; nothing here enables live money, changes `EXECUTION_MODE`, loosens a risk limit or touches a protected path.

**Evidence labels:** `REPO` (code at `main` `873bdd6`, cited `file:line`) · `PROD` (read-only VPS query or probe, 17 Nov 2026 10:16–10:30 UTC) · `INFERRED` (reasoning, not observed) · `UNVERIFIED` (not checked).

## 1. Baseline reconciliation

| Item | Expected (brief) | Observed | Label |
| --- | --- | --- | --- |
| `main` | `873bdd640` | `873bdd6` (PR #80, docs only over `bed2f36`) | `REPO` |
| Production commit | `bed2f364e` | `bed2f364e6f6…` checked out on the VPS | `PROD` |
| PCR-1 | merged and deployed (#77) | merged; fence in `apps/worker/src/executor/settle.ts:69-129` and `packages/shared/src/position-lot.ts:76-146` | `REPO` |
| INTEGRITY Phase II | merged (#79) | merged and deployed | `REPO`, `PROD` |
| Tests | 1,569 unit+DB, 14 browser (CI) | CI figures not re-run. Local Windows unit baseline on `873bdd6`: 1,306 passed, 2 failed, 6 files failed. All the failures are environmental: the restore-drill `.mjs` imports, and the API auth/Redis tests on a host without Redis. | `REPO` |
| Research job, GENESIS shadow | off | off: 0 campaigns, 0 runs, 0 shadow predictions, 0 model versions | `PROD` |
| Open PRs | — | none | `REPO` |

`.claude/protected-edits.unlock` exists in the checkout. It was already there before this work (also noted in `docs/evidence/HANDOVER.md`). This session did not use it. The brief is not a protected-edit unlock, so no protected file was edited.

## 2. Production (read-only)

| # | Question | Answer | Label |
| --- | --- | --- | --- |
| 1 | Deployed commit and health | `bed2f36`. `quant-api`, `quant-worker`, `quant-web`, postgresql and redis are active. `/api/health` returns `ok`. 180 `CycleRun` COMPLETE in the last hour, 0 failed. 0 worker error lines in 30 min. | `PROD` |
| 2 | Observations by provider and class | Last 24 h: 103,608 rows, all `dexscreener` / Solana / LIVE, over 253 pools. **Zero rows with a registry id (`fx:`, `etf:`, `commodity:`) have ever been stored.** About 103.7 k rows per day. | `PROD` |
| 3 | Orders, fills, positions | All-time: 324 BUY FILLED, 324 SELL FILLED, 131 SELL CANCELLED, 20 SELL and 9 BUY REJECTED. Every order has a null `instrumentId` (Solana). 7 days: GATO 292, CBUCKS 52, RAMBO 20, SOL 9, other 5. Reject reasons (7 d): `EXIT_SUPERSEDED` 76. 648 fills, all `USD` / `LOCAL_SIM`. 0 open positions, 0 pending orders. | `PROD` |
| 4 | Selections and strategy instances | MarketSelection is enabled for all 12 registry ids. Instances: `pulse-momentum-v1` (Solana universe), `pulse-momentum-v1-fx` (EURUSD, GBPUSD, USDJPY), `mean-revert-fade-v1` (SPY, QQQ), all ACTIVE/HEALTHY. There is no commodity instance. The non-Solana instances never receive an observation. | `PROD` |
| 5 | Provider credentials (names only) | `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `OANDA_ACCOUNT_ID`, `OANDA_API_TOKEN`, `OANDA_API_URL` (equal to the practice host), `DATA_MODE`, `MARKET_POLL_MS`. Values were not read. | `PROD` |
| 6 | Alpaca and OANDA operational | **Both are configured and answer, read-only** (see `PROVIDER-READINESS.md`). The first OANDA probe failed with `fetch failed`; a retry two minutes later succeeded. Neither feeds the paper pipeline. | `PROD` |
| 7 | Equity, drawdown, limits | Account `primary`: cash 7,061.31, equity 7,061.31 (`CASH_ONLY`), HWM 10,106.00. **Drawdown 30.13%, at or over the configured 30% total-drawdown limit.** Daily loss limit 10%. Realised P&L −2,939.05, fees 780.51. Equity has fallen every day since 9 Nov (8,245.96 → 7,061.31). | `PROD` |
| 8 | Engine state | `EngineControl` is `RUNNING`, config hash `5ff22766…` unchanged, no `AccountSafetyState` rows, no unacked alerts. Any new BUY now fails `TOTAL_DRAWDOWN_LIMIT` (`packages/risk-engine/src/evaluate.ts:179,192`; `dd.gte(limit)`). The last order was 16 Nov 07:21 UTC. In the last 2 h no intent reached AEGIS (`NO_INTENT` 8,640), so the latch is the operative block on the next signal. | `PROD`; the latch effect is `INFERRED` from code |
| 9 | Research and shadow | Off. `ResearchTrialLedger` has 0 rows. `ResearchTrial` has 2,454 rows from 174 runs, all on 1 Nov. The checkpoint 9 figure "2,170" was the `campaign-cli trials` programme count, not this row count; the two are not reconciled here. | `PROD` |
| 10 | Historical datasets | OANDA 1h and 1d for EUR, GBP, JPY and XAU end on **5–6 Nov 2026**. The `ny17` 1d datasets end 4 Nov. Alpaca IEX SPY 1d ends 30 Oct. GeckoTerminal Solana datasets end 1 Nov. There is no XAG, AUD, CAD, WTI, Brent, QQQ, DIA or IWM data. Identity is by `sourceId` + `instrumentKey` + `interval`. All are stale for new campaigns. | `PROD` |
| 11 | Growth, queues, retention | Database is 13 GB (7.8 GB on 10 Nov), about +0.75 GB per day. `AgentDecision` 7.6 GB / 8.5 M rows; `MarketObservation` 3.8 GB / 1.7 M; `CyclePlan` 1.1 GB; `OpportunityFunnelEvent` 0.7 GB. **No retention exists in code** for any of these. Nightly dumps grow about 120 MB per night (1.91 GB on 17 Nov). Disk has 49 GB free (61 GB on 12 Nov). At this rate disk pressure arrives in weeks, not months (`INFERRED`). Queue depth not inspected (`UNVERIFIED`); cycles complete on time. | `PROD` |

Temporary files: one read-only probe script was copied to `/tmp` and to `apps/worker/.avail-probe.mjs` on the VPS, run, then deleted. Nothing else was written on the VPS.

## 3. Why QUANT is still crypto-only (every blocker from quote to fill)

Ordered along the path. All `REPO` unless marked. Full table with owners: [`BLOCKER-MATRIX.md`](BLOCKER-MATRIX.md).

1. **No ingest.**
   - The worker ingests DexScreener Solana only (`packages/market-data/src/dexscreener.ts:13,54,58,65`).
   - Frankfurter EUR/GBP is the only other path. It is flag-gated off (`apps/worker/src/stage-runner.ts:490-493`) and hard-coded to two pairs (`:1803-1859`).
   - `multiMarketPaperIngest` is read by no worker code (`packages/shared/src/strategy.ts:36,320`; UI toggle only).
   - OANDA and Alpaca are used only for held-mark refresh (`stage-runner.ts:501-530`).
2. **Provider quotes are dropped before persistence.**
   - Held-refresh rows carry a `*_stub` source and no `raw.dataOrigin` (`packages/market-data/src/held-refresh.ts:105-165`).
   - So `inferObservationProvenance` returns `FIXTURE_SEQUENCE` (`packages/shared/src/observation-origin.ts:89-96`), and `checkRowEnvironmentIsolation` skips them in `MARKET_DATA_PAPER` (`stage-runner.ts:576-579`).
   - Alpaca and OANDA stamp `dataState: "DEMO"` (`alpaca-paper.ts:210`, `oanda-practice.ts:201`).
3. **`QuoteQuality` is not persisted.**
   - It is produced (`market-provider.ts:30`) but dropped by `observationData` (`stage-runner.ts:2192-2234`).
   - Only the probe reads it.
4. **Data shape.**
   - Non-crypto rows have null liquidity, volume, M5/H1 change and txns (`held-refresh.ts:142-150`, `stage-runner.ts:1835-1840`).
   - PULSE then returns `INSUFFICIENT_DATA` (`packages/agent-core/src/pulse.ts:264-266`; `strategy-library.ts:68-69,111-112,205-206`).
   - SENTINEL hard-rejects `MISSING_LIQUIDITY`/`MISSING_VOLUME` (`packages/agent-core/src/sentinel.ts:32,34,184-186`), which becomes `BLOCKED_BY_SENTINEL` (`pulse.ts:205-206`).
5. **Planner liquidity gates.**
   - `executeOrder` rejects null liquidity as `MISSING_PRICE` (`packages/agent-core/src/plan.ts:913-916`).
   - `sizeOrder` gives `MARK_UNAVAILABLE` / `LIQUIDITY_FLOOR` (`:803-813`).
   - Sizing participation is `liquidity × pct` (`packages/trading-engine/src/size.ts:28`), which caps a null liquidity at 0.
   - The planner `quoteFill` omits `instrumentId` and so prices with the DEX model (`plan.ts:924-935`). Settlement passes it (`apps/worker/src/executor/admit.ts:149,248`).
6. **Risk freshness.**
   - DEMO BUYs are refused as `DATA_DEMO` and DELAYED as `DATA_DELAYED` (`packages/risk-engine/src/evaluate.ts:206-219`).
   - Non-LIVE valuation gives `VALUATION_NOT_LIVE` (`:82-83`).
   - (protected)
7. **Settlement freshness disagrees with risk.**
   - A DEMO BUY fills only with `allowDemoPaperEntries` **and** `DATA_MODE=demo` (`packages/trading-engine/src/store.ts:115-118`).
   - Demo mode ingests nothing (`stage-runner.ts:462-468`).
   - (protected)
8. **Pending-fill eligibility.**
   - A pending order needs an observation with `receivedAt` and `eventTime` ≥ `eligibleAt` (`packages/trading-engine/src/eligible-observation.ts:61-82`).
   - With `paperLatencyMs = 1000` every order is pending (`plan.ts:942-944`), so a reference rate or a slow-ticking quote can never fill.
   - This is new relative to the original PCR-2. (protected)
9. **Fill economics.**
   - Everything rounds to 8 dp (`packages/trading-engine/src/money.ts:19-29`, `size.ts:91-94`).
   - Tick, lot and multiplier are unused.
   - Quote currency is unused: USD/JPY would book about 159 JPY as `priceUsd` (`ledger.ts:24-95`; `fx-conversion.ts` and `precision.ts` have no production callers).
   - (protected)
10. **Costs.**
    - Fixed estimates apply regardless of the observed spread (`packages/trading-engine/src/cost-model.ts:64-139`, `packages/shared/src/product-semantics.ts:56-76,181-182`).
    - (protected)
11. **Valuation contagion.**
    - A held non-crypto position whose quote is dropped (item 2) has a null or STALE mark.
    - Valuation is then `INCOMPLETE`, and **every** BUY account-wide fails `MARK_UNAVAILABLE` (`stage-runner.ts:736-746`, `packages/analytics/src/performance.ts:32-80`, `evaluate.ts:80`).
12. **Strategy thresholds.** One global `entryM5ChangePct = 2` is used by every module and instance (`packages/shared/src/strategy.ts:13,303`; `pulse.ts:291-309`; `strategy-library.ts:72,105,115,209`). A 2% five-minute move is rare for EUR/USD or SPY (`INFERRED`).
13. **No validated edge.** Every hourly and daily gold, FX and SPY study returned NO_SKILL (`docs/horizon/LEDGER.md`, checkpoints 1, 3, 4).
14. **Account latch.** The 30.13% drawdown refuses all new BUYs on `primary`, crypto included (`PROD`).

## 4. Registry and calendar defects found

| Defect | Where | State |
| --- | --- | --- |
| Commodity session: XAU used FX hours, WTI used US 04:00–20:00 | `packages/shared/src/instruments.ts` | **Fixed** (`0119fdf`): new `METALS_ENERGY_CFD` session |
| No NYSE early closes; holidays beyond 2027 treated as open | `packages/shared/src/sessions.ts` | **Fixed** (`0119fdf`): early closes from `history/calendar.ts`; UNKNOWN outside covered years |
| FTSE uses the US RTH session (at 10:25 UTC the probe reports `SESSION_CLOSED: OUTSIDE_RTH` while the LSE is open) | `instruments.ts` | Open: research-only, needs a UK calendar |
| Registry provider ids are stubs (`fx_stub`, `index_yahoo_delayed`, `commodity_stub`); the gateway routes commodities to no provider (`packages/market-data/src/gateway.ts:52-54`), while the probe routes them to OANDA | `instruments.ts`, `gateway.ts` | Open: part of ingest wiring |
| Missing instruments: XAG, AUD/USD, USD/CAD, Brent, DIA, IWM | `instruments.ts` | Open: OANDA and Alpaca offer them (`PROD`); add as research-only first |
| No CFD concept: OANDA `SPX500_USD` etc. are CFDs, not index levels or ETFs | `product-semantics.ts` | Open: must not be registered as `index:` or `etf:` |
| 2027 NYSE early closes beyond the day after Thanksgiving | `sessions.ts` | Operator must confirm against the published NYSE calendar |
