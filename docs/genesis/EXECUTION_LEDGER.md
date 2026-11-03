# GENESIS execution ledger

Durable checkpoint for Operation GENESIS (ASCEND-10, ASCEND-11 and the APEX continuation). **On resume, rebuild state from Git, CI, production read-only queries and this file, in that order. Do not trust a chat summary.** Repository rules (`AGENTS.md`, `CLAUDE.md`) override everything here. Earlier history stays in [`docs/apex/EXECUTION_LEDGER.md`](../apex/EXECUTION_LEDGER.md) and [`docs/ascend/STATUS.md`](../ascend/STATUS.md); this file does not replace them.

## Evidence labels

| Label | Meaning |
| --- | --- |
| `IMPLEMENTED` | Code exists on a branch or `main`; nothing more is claimed |
| `UNIT_VERIFIED` | Unit tests pass locally or in CI |
| `INTEGRATION_VERIFIED` | Tests against PostgreSQL/Redis pass (CI or an `odin_test` database) |
| `HISTORICAL_VERIFIED` | Measured on warehouse data with recorded run IDs |
| `SHADOW_VERIFIED` | Measured prospectively on live data with no orders |
| `PAPER_VERIFIED` | Observed in the production PAPER engine |
| `BLOCKED` | Cannot proceed; the blocker and what unblocks it are named |
| `NOT_VERIFIED` | Not checked; no claim is made |

## Checkpoint 1: 3 Nov 2026, ~12:30 UTC (Phase 0 and Phase 1)

### Baseline (observed)

| Item | Value | Source |
| --- | --- | --- |
| `main` | `9cb82a8` | `git log origin/main` |
| Production | `d2fc28a`, deployed 3 Nov 2026 11:51:54 UTC (see APEX ledger); `quant-api`, `quant-worker`, `quant-web` active; health `ok` | SSH, read-only |
| Open PRs | [#45](https://github.com/TheFridey/QUANT/pull/45) PCR-1 (draft, protected proposal; awaits operator unlock) | `gh pr list` |
| Engine | `RUNNING`; `activeStrategy` NULL (no promoted strategy); last config change 31 Oct 2026 16:15 UTC; one `EngineConfigRevision` row (BASELINE) | `EngineControl`, `EngineConfigRevision` |
| Stored risk limits | `maxDailyLossPct` 3, `maxTotalDrawdownPct` 10, `maxRiskPerTradePct` 0.5, `maxAggregateExposurePct` 20 (equal to `DEFAULT_STRATEGY`) | `EngineControl.config` |
| Paper account | cash = equity 9,093.15159827 (no open positions); starting balance 10,000; HWM 10,106.00207701; session start 3 Nov 00:00 London, start equity = session low = 9,093.15159827 | `PaperAccount`, `Position` |
| Closed trades | 69 (13 wins, 56 losses); realised P&L −906.96; profit factor **0.3346** (the dashboard's "≈0.35" is rounded); expectancy −13.14 USD/trade; fees 171.08 | `LedgerEntry` `REALIZED_PNL` and `FEE`, all rows |
| Last orders | BUY filled 2 Nov 11:29 UTC; last SELL 2 Nov 12:01 UTC | `Order` |
| Max drawdown (true) | 9.94% over all 12,980 equity snapshots (31 Oct 12:13 → 3 Nov 12:21 UTC); 10.02% against the account HWM | `EquitySnapshot`, `PaperAccount` |
| Research data | 174 `ResearchRun`, 0 holdouts consumed; 8,043 `HistoricalBar` rows in 7 datasets; 138 `TradeLotSnapshot` | production, read-only |
| Database | 2,536 MB (991 MB → 1,022 MB on 1 Nov). Largest: `AgentDecision` 1,402 MB / 1.57 M rows since 31 Oct; `MarketObservation` 691 MB | `pg_database_size`, `pg_stat_user_tables` |
| ML code | `packages/backtest/src/research/ml.ts` (`ml-wf-1.0.0`: base rate, L2 logistic, boosted stumps; walk-forward with holdout, calibration, PSI) | repository |

### Phase 1: 15% PAPER daily loss limit

**Status: `BLOCKED` for application to production; tests `UNIT_VERIFIED`.**

1. **The change would have no effect today.** Equity 9,093.15 against HWM 10,106.00 is a **10.02%** drawdown, at or above the independent 10% total drawdown limit. `evaluateRisk` therefore rejects every BUY with `TOTAL_DRAWDOWN_LIMIT`, and `evaluateCircuitBreaker` reports `CIRCUIT_BREAKER, TOTAL_DRAWDOWN_LIMIT`, whatever the daily limit is. No rejection has been recorded yet only because no BUY intent has formed since 2 Nov 12:01 UTC (recent decisions are `NO_INTENT` and SENTINEL liquidity filters).
2. **15% daily can never bind while total drawdown is 10%.** The HWM only ratchets up, so it is always ≥ start-of-day equity. A 15% loss from the start of the day is therefore at least a 15% drawdown from the HWM, and the 10% total limit trips first. Raising the daily limit is only meaningful together with a total-drawdown change, which this instruction does not authorise and this ledger does not propose.
3. **Applying it needs an operator login.** `PATCH /engine/config` is behind `AdminGuard`; the engine must be `PAUSED` first ("Pause the engine before changing risk limits"). No strategy is promoted, so the promotion lock would not refuse it. The `EngineConfigRevision` trigger would record the previous and new config, changed keys, actor, time and hash. This session does not authenticate to production as the operator, so the patch was **not applied**, the engine was **not paused**, and nothing in production was written.
4. **Nothing was bypassed.** `DEFAULT_STRATEGY` (3% / 10%) and the risk engine are unchanged. No session-low, HWM, balance or trading-day state was touched.

Operator-run procedure, if still wanted after reading 1 and 2 (from the terminal's Settings, or with an admin session):

```text
POST  /api/engine/pause                         (normal operator pause)
PATCH /api/engine/config  {"maxDailyLossPct":"15"}
GET   /api/engine/config/history?limit=2        expect changedKeys ["maxDailyLossPct"], previous 3, new 15, your actor
leave PAUSED; entries stay blocked by TOTAL_DRAWDOWN_LIMIT until equity ≥ 9,095.40 (90% of HWM) or a separate, explicitly approved drawdown decision
```

Step 23 (isolated experimental account for higher-volume paper simulation) is **not started**: it needs its own design and review, and must not share or reset the primary account's safety state.

Tests: `apps/worker/src/daily-loss-15pct.test.ts` (10 cases, against the unmodified risk engine and production-shaped figures): patch schema accepts 15 and leaves other limits and the protected defaults alone; limit from start-of-day equity (exactly 1,363.9727397405 USD); just below admits, exactly at and just above reject; latch after recovery with zero headroom; operator resume does not bypass the latch while exits and paused reduce-only closes still pass; latch restored from persisted session state and reset on the next London day without lowering the HWM; London midnight across both 2026 DST changes; total drawdown still rejects at 15% daily (the production case); circuit breaker, emergency stop, stale data, max positions, aggregate exposure and missing daily P&L still reject; entry headroom capped. Concurrent entry admission is covered by the existing reservation tests in `packages/risk-engine` (unchanged) and `apps/worker/src/daily-loss-latch.integration.test.ts` (`NOT_VERIFIED` locally: needs `DATABASE_URL_TEST`).

### Phase 2 findings so far

| Finding | Evidence | Next action |
| --- | --- | --- |
| Overview "max drawdown 0.00%" | `TerminalService` computes `maxDrawdownPct` from the **earliest** 500 equity snapshots (`SNAPSHOT_BOUNDS.equitySeries`, ascending). Production has 12,980, so the figure covers only the first ~hours, when equity was flat. True values: 9.94% (snapshots), 10.02% (vs HWM) | Fix in a focused PR: all-history max drawdown in SQL, current drawdown vs HWM, labelled windows |
| `AgentDecision` growth | 1,402 MB / 1.57 M rows in ~3 days (≈ 470 MB/day); 85 GB disk free | Retention/aggregation design (append-only audit must be preserved; needs operator decision) |
| Restore drill on the 3 Nov dump | `NOT_VERIFIED`: no drill-role credentials in this session | Operator creates a `CREATEDB` (non-superuser) drill role, then `scripts/restore-verify.mjs` |
| Authenticated smoke tests | `NOT_VERIFIED`: needs an operator login | Operator runs them, or provides a session approach that does not involve this agent entering passwords |

## Phase plan

| Phase | State | Depends on | Next action |
| --- | --- | --- | --- |
| 0 Reconstruct | `IMPLEMENTED` (this checkpoint) | — | Refresh on each resume |
| 1 15% PAPER daily loss | `BLOCKED` (drawdown dominates; operator login) | Operator decision | See above |
| 2 Execution safety and reliability | In progress | PCR-1 needs operator unlock | Drawdown reporting fix; retention design; drill and smoke tests via operator |
| 3 Warehouse expansion | Not started | ASCEND-01 warehouse | Coverage audit by asset class; free-source backfills; Opportunity History dataset from `OpportunityFunnelEvent` and `AgentDecision` |
| 4 ML engine 2.0 | Not started | 3 (data), existing `ml.ts` | Multi-target labels with purging/embargo; real runs on the 7 warehouse datasets |
| 5 Model registry | Not started | 4 | Migration-backed registry; needs separate migration approval |
| 6 Shadow trading | Not started | 5 | Prediction store, written before outcome, no order path |
| 7 Trade memory feedback | Not started | ASCEND-09 snapshots (138 in production) | Error attribution over `TradeLotSnapshot` |
| 8 Research loop 2.0 | Not started; loop stays disabled | 3, 4 | Instrument-scoped dataset adapter for TEST |
| 9 Portfolio and regimes | Not started | 4, ASCEND-07 | — |
| 10 Command centre | Not started | 5, 6 | — |
| 11 Quality and integrity | Ongoing per PR | — | — |
| 12 Release control | Per PR | — | — |
| 13 Final report | Not started | all | `docs/genesis/FINAL_REPORT.md` only when the phases above have evidence |

## Blockers

| Blocker | Type | What unblocks it |
| --- | --- | --- |
| Applying `maxDailyLossPct` 15 | `BLOCKED_APPROVAL` / operator login | Operator runs the procedure above; it has no effect while total drawdown ≥ 10% |
| Higher-volume paper trading | `BLOCKED_APPROVAL` | A separate, isolated experimental account design (not a drawdown bypass) |
| PCR-1 ([#45](https://github.com/TheFridey/QUANT/pull/45)) | `BLOCKED_APPROVAL` | Operator-created `.claude/protected-edits.unlock` |
| Production restore drill | `BLOCKED_EXTERNAL` | Drill-role credentials |
| Authenticated production smoke tests | `BLOCKED_EXTERNAL` | Operator login |
| New migrations (registry, shadow store) | `BLOCKED_APPROVAL` | Per-migration operator approval and backup |
| Paid data (longer crypto history, FX, liquidity history) | `BLOCKED_APPROVAL` | Operator purchase decision |
