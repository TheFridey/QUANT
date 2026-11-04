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

## Checkpoint 4: 4 Nov 2026, ~22:45 UTC (risk limits editor deployed)

Operator request: "make an options page where I can edit my max daily losses, drawdown etc." then "Merge and deploy". [#58](https://github.com/TheFridey/QUANT/pull/58) adds a Risk limits (PAPER) panel on Settings for `maxDailyLossPct`, `maxTotalDrawdownPct`, `maxRiskPerTradePct`, `maxAggregateExposurePct` and `maxPositionPctEquity`. It uses the existing audited `PATCH /engine/config` (admin, paused engine, server bounds, `EngineConfigRevision`); no new server path; `DEFAULT_STRATEGY` and the risk engine unchanged; saving never resumes the engine. quant-safety-reviewer: APPROVE WITH NOTES, six notes fixed before merge. CI green (unit, parity with `strategy.ts`, browser e2e of the whole flow). Merged `5e26943`.

Deploy: fast-forward `7cdff36` → `5e26943`; web-only change, no migration, lockfile unchanged; backup `/srv/quant/backups/quant-20261104T224242Z.dump`; web snapshot `/srv/quant/releases/7cdff36-20261104T224337Z`; only `quant-web` rebuilt and restarted (22:44:06 UTC). Smoke: SHA `5e26943`; panel present in the build; `/terminal/settings` 200; API health `ok`; worker cycles advancing; other tenants 200; 0 web error lines. Stored limits unchanged at deploy (3 / 10 / 0.5 / 20 / 5; engine RUNNING). Not verified: the panel in a logged-in browser on production.

## Checkpoint 3: 4 Nov 2026, ~21:50 UTC (all GENESIS PRs merged; `7cdff36` deployed)

Operator instruction, 4 Nov 2026: "merge all push to main and push live". Merging, the one migration and the deploy were approved by that instruction. The 15% daily limit stays **not applied** ("Leave it for now"). The shadow service and research loop stay **disabled**.

| PR | Merged as | Before merge |
| --- | --- | --- |
| [#53](https://github.com/TheFridey/QUANT/pull/53) drawdown | `e5a0c21` (squash; the branch's last commit had a wrong message) | CI green; review notes fixed (single-pass SQL, 30 s cache) |
| [#52](https://github.com/TheFridey/QUANT/pull/52) ML 2.0 | `0d489e1` | CI green; SPY session calendar and review fixes |
| [#54](https://github.com/TheFridey/QUANT/pull/54) data quality | `b51b398` | CI green after fixing a real integration failure (counterfactual `BEYOND_DATA` used the bounded read's end) |
| [#55](https://github.com/TheFridey/QUANT/pull/55) research loop 2.0 | `c816104` | quant-safety-reviewer APPROVE WITH NOTES; M1 (holdout re-queue) and M2 (reservation under-count) and L1–L4 fixed; CI green with the Postgres integration tests |
| [#51](https://github.com/TheFridey/QUANT/pull/51) trade feedback | `0648c67` | main merged in (two trivial conflicts); first browser-e2e run failed at startup with `Unique constraint failed on the fields: (id)`, rerun passed (intermittent start-up race, not this PR; `NOT_VERIFIED` root cause) |
| [#50](https://github.com/TheFridey/QUANT/pull/50) ledger, 15% tests | `0de81f4` | CI green |
| [#56](https://github.com/TheFridey/QUANT/pull/56) registry and shadow | `7cdff36` | db-migration-reviewer REQUEST CHANGES → fixed → APPROVE WITH NOTES → notes fixed. CI found a real defect: hashes over float/JSONB columns did not re-verify after the Prisma round trip; fixed by storing hashed content as exact TEXT with `sha256` CHECKs. CI green (1,179 tests, Postgres integration included). The post-fix schema was not re-reviewed by the migration reviewer; I checked it is additive only |

### Production deploy of `7cdff36`

| Item | Value |
| --- | --- |
| Previous / rollback | `d2fc28a`; build snapshot `/srv/quant/releases/d2fc28a-20261104T214202Z` |
| Backup | `/srv/quant/backups/quant-20261104T214108Z.dump` (522 MB, 62 `TABLE DATA` entries). Restore drill **not run** (no drill-role credentials) |
| Preflight | fast-forward; no protected paths; lockfile unchanged; `.env` PAPER / false, `GENESIS_SHADOW_ENABLED` unset; `ResearchLoopControl` no row (disabled); main CI green on `7cdff36` |
| Migration | `20261104100000_genesis_model_registry_shadow` applied before the new code started (5 new tables, 15 triggers, all `ENABLE ALWAYS`; only an FK to `Hypothesis` on an existing table) |
| Restart | `quant-api`, `quant-worker`, `quant-web` at 21:48:01 UTC |
| Smoke | health `ok`; SHA `7cdff36`; 168 observations in 2 min; `CycleRun` advancing; 0 error lines in API/worker logs; worker logs "genesis shadow disabled … nothing scheduled"; 0 `ShadowPrediction` rows; engine RUNNING with `maxDailyLossPct` 3 and `maxTotalDrawdownPct` 10 (unchanged); web 307; scalesmiths.co.uk and veteranfinder.co.uk 200 |
| Not verified | authenticated endpoints (`/api/terminal/feedback/*`, `/api/research/data-quality*`, overview drawdown fields), UI in a browser, restore drill |
| Before enabling shadow | the app role `quant_app` **owns** the tables, so it could disable the triggers with DDL; move ownership to a separate migration role and confirm NTP, per `DEPLOY_REGISTRY_SHADOW.md` |

## Checkpoint 2: 4 Nov 2026 (wave 1 PRs and first real ML runs)

Operator: "Leave it for now" on the 15% daily limit (not applied). Then: implement the rest of GENESIS.

| PR | Phase | Branch / head | Local evidence | Not verified |
| --- | --- | --- | --- | --- |
| [#53](https://github.com/TheFridey/QUANT/pull/53) drawdown reporting | 2 | `genesis/drawdown-reporting` `aa3d9d8` | Max drawdown from all `EquitySnapshot` rows in SQL; separate current drawdown vs HWM and return; every metric window labelled. 16 targeted tests passed, `apps/api` 57 passed; typecheck, lint clean | SQL integration test (needs `odin_test`); UI in a browser; e2e |
| [#54](https://github.com/TheFridey/QUANT/pull/54) data quality, opportunity history | 3 | `genesis/data-quality` `cc9e703` | Per-dataset quality report (asset-class calendars, gaps, duplicates, revisions, content hash = `versionHash`); `docs/genesis/DATA_COVERAGE.md`; bounded Opportunity History export with HYPOTHETICAL counterfactuals. 46 targeted tests passed; full suite 877 passed (only `restore-drill.test.ts` fails, as on `main`) | Integration test; CLIs against a database; NYSE holiday table hand-entered (2025-01-09 closure missing from the engine's `sessions.ts`, left unchanged) |
| [#52](https://github.com/TheFridey/QUANT/pull/52) ML engine 2.0 | 4 | `genesis/ml-engine-2` `43ffd47` | `ml-wf-2.0.0`: next-bar-open labels with costs, purged/embargoed walk-forward, train-only preprocessing and calibration, feature-set hashes and causal checks, seeded random forest challenger, block-bootstrap CIs, honest verdicts, trial ledger, drift abstention. 74 targeted tests passed after the review and SPY fixes (`43ffd47`); full suite 877 passed on `a4e7b52` | `restore-drill` as on `main`; full suite not rerun on `43ffd47` |
| [#51](https://github.com/TheFridey/QUANT/pull/51) trade feedback | 7 | `genesis/trade-feedback` `ed90bff` | Read-only feedback summary, per-lot explainability (decision record from the stored ENTRY snapshot only; retrospective separate), error-attribution rules, HYPOTHETICAL non-trades, self-reinforcement guard. 21 unit + 10 auth tests passed; typecheck, lint clean | Integration test; full suite |

### First real ML runs (`HISTORICAL_VERIFIED` as runs; no skill found)

Data: read-only CSV export of the production warehouse on 4 Nov 2026 (7 datasets, 8,043 bars, raw UTC `openTime` and `availableAt`). Code: PR #52 at `a4e7b52`, compiled locally with `tsc`. Seed 1; programme trials 2,454 prior `ResearchTrial` rows + 4 per run; holdout never evaluated (walk-forward failed first, and the CLI cannot consume a holdout without a recorded gate).

| Run | Data (sha256 prefix) | Horizon, costs per side | Usable rows | Champion walk-forward | Verdict |
| --- | --- | --- | --- | --- | --- |
| SOL/USDC 1h | `742a7bceabef`, 4,337 bars | 4 bars; 30 bps fee + 10 bps slippage | 4,070 | Brier skill 0.0066; AUC 0.556, block-bootstrap lower 0.495; ECE 0.054 | **NO_SKILL** |
| SOL/USDC 1h | same | 24 bars; same | 4,050 | Brier skill −0.0078; AUC 0.442, lower 0.348; ECE 0.088 | **NO_SKILL** |
| GATO 1h | `8c54ce6bd406`, 1,637 bars | 4 bars; 30 + 50 bps | 1,370 | Brier skill −0.031; AUC 0.571, lower 0.494; ECE 0.093 | **NO_SKILL** |
| SPY 1d | `b556d0532986`*, 1,464 bars | 5 bars; 1 + 2 bps | 1,320 | Brier skill 0.048; AUC 0.505, lower 0.410; ECE 0.046 | **NO_SKILL** |
| SPY 1d | same | 20 bars; same | 1,305 | ≈41 independent test labels (< 100) | **INSUFFICIENT_EVIDENCE** |

Always-enter net expectancy per trade at 1× costs was negative in every run (−0.70%, −0.19%, −1.44%), so costs alone exceed any average move at these horizons. Each run took 1.3–5.0 s and ≤ 167 MB RSS. Every artefact also failed the deployment check (stale training cutoff > 30 days and PSI drift > 0.25), so none could be used for shadow predictions even with skill. The speculative 5m pools (21–515 bars) are too short to train on.

SPY: the first run (`a4e7b52`) refused all bars because Alpaca daily bars open at New York midnight and the pipeline used a UTC day grid. Fixed in `43ffd47` with a `US_EQUITY` session calendar (NYSE closures, DST); SPY rows above are from `43ffd47` with `--calendar US_EQUITY`. Rerunning the three Solana runs on `43ffd47` gave identical figures (deterministic). *sha256 prefix of the exported CSV.

Wave 2 in progress: model registry and shadow store (Phases 5–6, one additive migration, stacked on #52); research loop dataset adapter (Phase 8).

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
| 2 Execution safety and reliability | In progress; drawdown fix in [#53](https://github.com/TheFridey/QUANT/pull/53) | PCR-1 needs operator unlock | Retention design; drill and smoke tests via operator |
| 3 Warehouse expansion | First increment in [#54](https://github.com/TheFridey/QUANT/pull/54) | ASCEND-01 warehouse | Run quality CLI on production after deploy; free-source backfills; inactive cohort |
| 4 ML engine 2.0 | `UNIT_VERIFIED` in [#52](https://github.com/TheFridey/QUANT/pull/52); real runs: 4 NO_SKILL, 1 INSUFFICIENT_EVIDENCE | 3 (data), existing `ml.ts` | More targets and horizons; longer histories |
| 5 Model registry | In progress (stacked on #52) | 4 | Migration-backed registry; needs separate migration approval |
| 6 Shadow trading | In progress (with 5) | 5 | Prediction store, written before outcome, no order path; ships disabled |
| 7 Trade memory feedback | `UNIT_VERIFIED` in [#51](https://github.com/TheFridey/QUANT/pull/51) | ASCEND-09 snapshots (138 in production) | Run on production lots after deploy |
| 8 Research loop 2.0 | In progress; loop stays disabled | 3, 4 | Instrument-scoped dataset adapter for TEST |
| 9 Portfolio and regimes | Not started | 4, ASCEND-07 | — |
| 10 Command centre | Not started | 5, 6 | — |
| 11 Quality and integrity | Ongoing per PR | — | — |
| 12 Release control | Per PR | — | — |
| 13 Final report | [`FINAL_REPORT.md`](FINAL_REPORT.md) | all | Update as phases gain evidence |

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
