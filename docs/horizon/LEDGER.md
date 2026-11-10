# HORIZON ledger

Operation HORIZON (multi-asset expansion). Evidence labels as in [`docs/genesis/EXECUTION_LEDGER.md`](../genesis/EXECUTION_LEDGER.md). Diagnosis: [`DIAGNOSIS.md`](DIAGNOSIS.md). Nothing here enables new trading.

## Checkpoint 6: 10 Nov 2026 (`926bb42` deployed; stage timeouts live)

Operator: "Yes, build it", then "Merge and deploy". [#69](https://github.com/TheFridey/QUANT/pull/69) merged as `926bb42`; main CI green, including the Postgres high-water-mark and day-roll guards.

Non-executor stages fail after 60 s; the executor is never abandoned and only raises `odin_stage_overrun`. `/api/health` and `/api/ready` report `degraded` when a RUNNING engine has completed no cycle for 5 minutes. quant-safety-reviewer: CHANGES REQUESTED twice (including a late stage lowering the high-water mark, which would have loosened the total-drawdown limit), both fixed; final verdict APPROVE at `a275b56`. Accepted residuals, no risk effect: stale fairness cursor from a late sentinel, late display and equity-snapshot writes, existing 60 s stage-lease TTL. A timed-out scheduled ingest waits for the 120 s stale sweep. The cause of the 9 Nov hang remains `NOT_VERIFIED`.

Deploy: fast-forward `62e2787` → `926bb42`; no migration; lockfile unchanged; backup `quant-20261110T112009Z.dump`; snapshot `/srv/quant/releases/62e2787-20261110T112204Z`; `quant-api` and `quant-worker` restarted 11:22:12 UTC with one open position. Smoke: health `ok`; `/api/ready` 200; five cycles `COMPLETE` in about 1 s each at the normal 20 s cadence; 168 observations in 2 min; 0 error lines; web 307; other tenants 200; limits unchanged (10% daily, 30% total); HWM unchanged at 10,106.00. Not verified: the timeout firing against a real hang in production.

## Checkpoint 5: 10 Nov 2026 (`62e2787` deployed; pipeline stall found and cleared)

Operator: "Merge and deploy" (#67), then "Restart worker". #67 merged as `62e2787`; main CI green. Fast-forward `bb53012` → `62e2787`: research code and docs only, no migration, no lockfile change; backup `quant-20261110T101356Z.dump` (1.1 GB); snapshot `/srv/quant/releases/bb53012-20261110T101549Z`; packages and worker rebuilt. Daily gold study run directly from the production warehouse: 18 weekend stubs excluded using real tick counts; NO_SKILL, matching the local run.

### Incident: paper pipeline stalled 9 Nov 16:00 UTC → 10 Nov 10:29 UTC (~18.5 h)

- **Symptom:** every `CycleRun` from 2026-11-09 16:00:00 UTC ended `FAILED` / `STALE_CYCLE` at stage `created`; cycle starts slowed from every 20 s to every ~130 s; last order 15:50 UTC on 9 Nov. API health stayed `ok`, so nothing alerted.
- **Cause (observed):** one BullMQ `sentinel` job (`cyc_23905992-…`, processedOn 16:00:00.468Z) never settled while the live worker kept renewing its lock; `odin.sentinel` runs at concurrency 1, so 502 jobs queued behind it. The job wrote no decisions and logged nothing after starting. Which await hung is `NOT_VERIFIED` (inferred: a call without a timeout in the plan load).
- **Exposure:** no open positions or pending orders during the stall, so no stops were missed. Not caused by a deploy (worker unchanged since 6 Nov 11:42 UTC).
- **Fix:** `quant-worker` restarted 10:29:31 UTC. Backlog cleared; cycles `COMPLETE` every 20 s in 1–3 s; 0 worker error lines; 96 observations in 2 min at ~90 s after restart (still ramping).
- **Follow-up needed:** a hard timeout per pipeline stage and a health signal on cycle completion, so a hung stage fails fast and is visible. The root cause can recur until then.

Also noted: database 7.8 GB (2.5 GB on 3 Nov); `AgentDecision` 4.3 GB / 4.8 M rows, still no retention. 69 GB disk free. Equity 8,187.94 vs HWM 10,106.00 (19.0% drawdown; limit 30%).

## Checkpoint 4: 6 Nov 2026 (`bb53012` deployed; daily gold/FX studies)

Operator: "Merge and deploy". Merged #65 (`cc0f64c`) and #66 (`bb53012`; #66 is docs-only and merged while its checks were still pending); main CI green on `bb53012`. Deploy: fast-forward `5fe4484` → `bb53012`, no migration, no lockfile change, no protected paths; backup `quant-20261106T114120Z.dump`; snapshot `/srv/quant/releases/5fe4484-20261106T114235Z`; api, worker, web restarted 11:42:48 UTC; health `ok`, 0 error lines, 168 observations in 2 min.

Daily re-backfill with `oanda_practice_ny17` (17:00 New York alignment), 2016-11-01 → 2026-11-04, 0 rejected: EUR_USD 2,598, GBP_USD 2,602, USD_JPY 2,615, XAU_USD 2,602 bars. The first pass left three datasets empty with no error output; a rerun of each completed (OANDA practice API 504s, as before).

Daily studies were then refused because OANDA prints occasional one-to-three-tick flat bars after the Friday close that date into the weekend (EUR 3, GBP 7, JPY 19, XAU 18 over ten years; median daily tick volume ~86,000). `horizon/fx-weekend-stubs` excludes and reports such stubs (≤ 10 ticks, or ≤ 5 bps range without a tick count) and still refuses any active weekend bar.

### Daily gold and FX studies (`HISTORICAL_VERIFIED` as runs; no edge)

That branch, CSV exports of the ny17 datasets, seed 1, prior trials 3,000, holdout never consumed; ~6.3 s and ~180 MB per run.

| Market | Stubs excluded | Strategy families | ML 2.0 (1 day) | Overall |
| --- | --- | --- | --- | --- |
| EUR/USD | 3 | 4 INSUFFICIENT_EVIDENCE (9–26 OOS trades < 30); vol mean reversion REJECTED_OVERFIT (PBO 0.74) | NO_SKILL (AUC 0.510, lower 0.477) | NO_SKILL |
| GBP/USD | 7 | 4 INSUFFICIENT_EVIDENCE; vol mean reversion REJECTED_OVERFIT (PBO 0.59) | NO_SKILL (AUC 0.491, lower 0.456) | NO_SKILL |
| USD/JPY | 19 | 4 INSUFFICIENT_EVIDENCE; vol mean reversion REJECTED_OVERFIT (PBO 0.81) | NO_SKILL (AUC 0.518, lower 0.484) | NO_SKILL |
| XAU/USD | 18 | 5 INSUFFICIENT_EVIDENCE (7–26 OOS trades) | NO_SKILL (AUC 0.505, lower 0.476) | NO_SKILL |

Across the hourly and daily runs, no gold or FX strategy or model is a candidate. Ten years of daily data still yields fewer than 30 out-of-sample trades per family, so slower families need either longer history or more instruments to reach the evidence bar.

## Checkpoint 3: 6 Nov 2026 (OANDA connected; gold and FX history; first gold/FX studies)

Operator created an OANDA fxTrade Practice account and set `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_API_URL` in the production `.env` (file `quant:quant 600`; values never read or printed by Claude). The first probe reported `AUTH_FAILED`: OANDA briefly answered `/instruments` with 401 "Insufficient authorization" for a newly issued token; minutes later every call returned 200 (no code change). OANDA's practice API also returned occasional Cloudflare 504s.

Account availability (`/v3/accounts/{id}/instruments`, 392 instruments): **XAU_USD, EUR_USD, GBP_USD, USD_JPY, WTICO_USD, XAG_USD available.** Production probe ~10:45 UTC: all five registry markets REAL_TIME / DEALER_INDICATIVE, two-sided, tradeable on the account; spreads XAU 1.2 bps, EUR/USD 0.7, GBP/USD 1.0, USD/JPY 1.0, WTI 3.3. Still `NOT_WIRED_INTO_PAPER_PIPELINE` and `RISK_ADMISSION_NEEDS_PCR2`.

Warehouse backfill (`oanda_practice`, read-only to OANDA, append-only to the warehouse; 0 rejected, 0 revisions):

| Instrument | Cohort | 1h (2024-11-01 → 2026-11-06) | 1d (2016-11-01 → 2026-11-05) |
| --- | --- | --- | --- |
| EUR_USD | MAJOR_FX | 12,513 | 3,125 |
| GBP_USD | MAJOR_FX | 12,513 | 3,125 |
| USD_JPY | MAJOR_FX | 12,513 | 3,125 |
| XAU_USD | PRECIOUS_METAL | 11,904 | 3,112 |

The 1d datasets use UTC alignment and are superseded for research by the `oanda_practice_ny17` source in [#65](https://github.com/TheFridey/QUANT/pull/65) (re-backfill after deploy; existing rows unchanged).

Real data exposed three research defects, fixed in [#65](https://github.com/TheFridey/QUANT/pull/65) (CI green): the `FX_24_5` calendar's fixed 22:00 UTC roll (real roll is 17:00 New York, 21:00 UTC in summer), UTC-aligned daily candles (Sunday stub bar), and ML features all null on OANDA data (no traded volume extended the warm-up to the whole series; regime coverage counted weekends as gaps).

### Hourly gold and FX studies (`HISTORICAL_VERIFIED` as runs; no edge)

`horizon-cli` at `19d938d` (#65) on CSV exports of the 1h datasets; seed 1; prior trials 2,700; programme trials reached ~2,900; holdout never consumed. Each run ~31–33 s, ≤ 357 MB RSS.

| Market | Strategy families | ML 2.0 (8-bar horizon) | Overall |
| --- | --- | --- | --- |
| EUR/USD | 5 REJECTED_OVERFIT (DSR ≈ 0 or PBO 0.58–0.98); MTF trend REJECTED_COSTS (OOS gross +1.53% → net −0.05%) | NO_SKILL (AUC 0.526, lower 0.491) | NO_SKILL |
| GBP/USD | 4 REJECTED_OVERFIT; ATR breakout REJECTED_COSTS (gross +1.01% → net −0.25%); MTF trend INSUFFICIENT_EVIDENCE | NO_SKILL (AUC 0.528, lower 0.497) | NO_SKILL |
| USD/JPY | 6 REJECTED_OVERFIT (best DSR 0.273) | NO_SKILL (AUC 0.529, lower 0.494) | NO_SKILL |
| XAU/USD | 5 REJECTED_OVERFIT; vol mean reversion INSUFFICIENT_EVIDENCE | NO_SKILL (AUC 0.471, lower 0.435) | NO_SKILL |

No gold or FX strategy is a candidate. Two families showed positive gross returns that costs removed; that is the expected failure mode for short-horizon FX at retail spreads.

## Checkpoint 2: 6 Nov 2026, ~10:10 UTC (`5fe4484` deployed)

Operator: "Merge and deploy". Merged #60 (`999a6ea`), #62 (`0a5559a`), #61 (`aa46037`), #63 (`5fe4484`); no conflicts; main CI green on `5fe4484`.

Deploy: fast-forward `5e26943` → `5fe4484`; no migration; lockfile unchanged; no protected paths; backup `quant-20261106T100335Z.dump` (703 MB, 67 tables); snapshot `/srv/quant/releases/5e26943-20261106T100447Z`; `quant-api`, `quant-worker`, `quant-web` restarted 10:07:18 UTC. Smoke: health `ok`; 144 observations in 2 min; cycles advancing; 0 API/worker error lines; web 307; `/api/research/opportunities` 401 without a token (guarded); other tenants 200. Not verified: scanner UI in a logged-in browser.

Risk config at deploy (not changed by this deploy): `maxDailyLossPct` 10, `maxTotalDrawdownPct` 30, set by the operator through the Settings panel (revision 2, `operator@quant.local`, 4 Nov 22:47 UTC). Equity 9,035.94 vs HWM 10,106.00 (10.6% drawdown, under the 30% limit); 50 orders since 4 Nov 22:44 UTC.

Market probe on production (read-only, `5fe4484`, ~10:09 UTC Friday):

| Instrument | Result |
| --- | --- |
| Solana universe | not probed (worker discovery) |
| EUR/USD, GBP/USD, USD/JPY | Frankfurter ECB reference rate only (`REFERENCE/REFERENCE_RATE`), not tradeable; USD/JPY also needs quote→USD conversion (PCR-2) |
| SPY | Alpaca IEX **real** quote received, `REAL_TIME/SINGLE_VENUE`; outside RTH (bid 712.54 / ask 758.52, stale overnight IEX book) — `SESSION_CLOSED: OUTSIDE_RTH` |
| QQQ | Alpaca IEX quote, one-sided outside RTH (`ONE_SIDED_QUOTE`, `SESSION_CLOSED`) |
| XAU/USD, WTI | `PROVIDER_NOT_CONFIGURED: oanda_practice MISSING_CREDENTIALS` |
| SPX, NDX, FTSE, DJI | research only, no provider |
| All non-Solana | `NOT_WIRED_INTO_PAPER_PIPELINE` (activation needs operator approval and PCR-2) |

So the Alpaca data path is `VERIFIED` against the real API; OANDA is still unverified (no account).

## Checkpoint 1: 6 Nov 2026

| PR | Scope | State |
| --- | --- | --- |
| [#60](https://github.com/TheFridey/QUANT/pull/60) | Diagnosis and this ledger | docs |
| [#61](https://github.com/TheFridey/QUANT/pull/61) | Per-market research configs (crypto, gold, FX, ETF), `FX_24_5` calendar, six cost-gated strategy families, `horizon-cli` | CI green; research only |
| [#62](https://github.com/TheFridey/QUANT/pull/62) | OANDA practice adapter (instrument availability, bid/ask pricing, candles, precision), Alpaca IEX quotes and intraday bars, warehouse sources, additive quote-quality descriptor, FX conversion and tick/lot helpers (unwired), read-only market probe, PCR-2 | CI green; quant-safety-reviewer APPROVE WITH NOTES (notes 1–3 fixed) |
| [#63](https://github.com/TheFridey/QUANT/pull/63) | Opportunity scanner: readiness ladder, evidence-only ranking with abstention, P&L by market, read-only API, Market Scanner/Selector UI | CI green (incl. e2e) |

No protected path changed, no freshness label changed, no new instrument wired into live paper entries, no migration, no risk limit changed.

### Real-data runs (`HISTORICAL_VERIFIED` as runs; no edge)

`horizon-cli` at `5902f49` on the read-only warehouse export (4 Nov 2026), seed 1, prior trials 2,474, holdout never consumed.

| Dataset | Strategy families (walk-forward, P90 cost, proxy flag) | ML 2.0 | Overall |
| --- | --- | --- | --- |
| SPY 1d | all INSUFFICIENT_EVIDENCE (6–21 OOS trades < 30) | NO_SKILL (AUC 0.502, lower 0.453) | NO_SKILL |
| SOL/USDC 1h | INSUFFICIENT_EVIDENCE; vol-expansion OOS net return not positive | NO_SKILL (AUC 0.460, lower 0.374) | NO_SKILL |
| GATO 1h | INSUFFICIENT_EVIDENCE; MTF trend REJECTED_RISK (OOS max drawdown 85.9%) | INSUFFICIENT_EVIDENCE (≈35 independent labels) | NO_SKILL |

Runs took 1.6–7.3 s and ≤ 195 MB RSS. No gold or FX data exists to test.

### Answers to HORIZON's five questions (today)

1. **Observable:** Solana pools only (DexScreener). With credentials and a deploy of #62: SPY/QQQ via Alpaca IEX (single venue, real-time); gold/FX via OANDA practice if the account offers them.
2. **Paper-tradable safely:** Solana pools only. Non-crypto needs PCR-2 (protected) after PCR-1.
3. **Positive after costs:** none found on any tested market.
4. **Why one market over another:** the scanner (#63) shows the readiness ladder and abstention reasons per market; today every non-Solana market stops before OBSERVABLE.
5. **Supporting results:** the runs above and the GENESIS ML runs; no prospective (shadow) results yet.

## Blockers

| Blocker | Type | Unblocks |
| --- | --- | --- |
| Gold and intraday FX data | `BLOCKED_EXTERNAL` | Operator opens a free OANDA fxTrade Practice account and sets `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`; then run the market probe to confirm XAU_USD |
| Consolidated US quotes | `BLOCKED_APPROVAL` (purchase) | Alpaca SIP plan; IEX-only meanwhile |
| Non-crypto paper execution | `BLOCKED_APPROVAL` (protected paths) | PCR-1 then PCR-2 via operator unlock and safety review |
| Ingesting non-Solana markets into the live pipeline | `BLOCKED_APPROVAL` | Operator decision after PCR-2 |
| Deploy of #61–#63 | `BLOCKED_APPROVAL` | Operator go-ahead (no migration; read-only additions) |
