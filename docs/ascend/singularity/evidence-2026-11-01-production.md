# Recorded production studies, 1 Nov 2026

Operator-approved deploy and run, 1 Nov 2026 ~20:41–20:50 UTC.

## Deploy

- VPS `f56151f` → `0e970a9` (fast-forward; no lockfile, Prisma schema or protected-path change between them). Packages (`pnpm build:packages`) and worker (`nest build`) rebuilt at `nice 15`. No migration, no service restart.
- Backup: `/srv/quant/backups/quant-20261101T204151Z.dump` (153 MB, via `quant-backup.service`; `pg_restore -l` reads 57 table-data entries).
- Rollback: build snapshot `/srv/quant/releases/f56151f-20261101T204207Z` (packages and worker `dist`), and `git checkout f56151f` in `/srv/quant/app/repo`. Research rows are append-only and are not rolled back.
- After deploy: API `{"status":"ok"}`; web 307 locally, 401 publicly (Basic Auth intact); `EXECUTION_MODE=PAPER`, `LIVE_MONEY_ENABLED=false`; market observations flowing (720 in 10 min before, 360 in 5 min after); scalesmiths.co.uk and veteranfinder.co.uk 200.

## Runs

`node apps/worker/dist/src/research/intelligence-cli.js <datasetId> --record` with `GIT_COMMIT=0e970a9`, `nice 15`, run one dataset at a time.

| Dataset | Bars | Cost/side | Time | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| SOL/USDC 1h | 4,337 | 33.25 bps (present-day reserve proxy) | 8.2 s | 218 MB |
| GATO 1h | 1,637 | 86.94 bps (latest QUANT observation, proxy) | 2.3 s | 145 MB |
| SPY 1d | 1,464 | 2.0 bps (static ETF spread) | 2.0 s | 143 MB |

Registry before: 150 runs, 1,594 trials, 0 holdouts consumed. After: 168 runs, 2,239 trials, 0 holdouts consumed. New rows: 15 `REGIME_CONDITIONED` (13 `INSUFFICIENT_EVIDENCE`, 1 `REJECTED_COSTS`, 1 `REJECTED_RISK`) and 3 `ML` (1 `NO_SKILL`, 2 `INSUFFICIENT_EVIDENCE`). Unchanged: `EngineConfigRevision` (1 row, 14:28 UTC) and the `EngineControl` row hash.

## Results

**SOL/USDC 1h** (DSR deflated by the programme count)

| Gated hypothesis | OOS trades | Net | Gross | 2× cost | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| TSMOM, trend only | 12 | +0.12% | +8.43% | −7.56% | `INSUFFICIENT_EVIDENCE` |
| MA trend, trend only | 11 | +1.52% | +9.22% | −5.64% | `INSUFFICIENT_EVIDENCE` |
| Z-score, range only | 3 | +7.92% | +10.10% | +5.79% | `INSUFFICIENT_EVIDENCE` |
| Bollinger, range only | 17 | −1.39% | +10.42% | −11.93% | `INSUFFICIENT_EVIDENCE` |
| TSMOM, not unstable | 55 | −24.59% | +8.70% | −47.69% | `REJECTED_COSTS` |

ML: `NO_SKILL`. Brier base 0.2579, logistic 0.2788, boosted 0.2798 (skill −0.081 / −0.085); AUC 0.501 / 0.495; 41 signals with mean −0.16% per signal against −0.06% for always entering.

**GATO 1h.** The trend is RANGE on 94% of bars, so both trend-only gates never traded (0 OOS trades). Z-score, range only: +81.05% net on **15 trades** (gross +135%; still +39.5% at 2× cost; DSR 0.31; PBO 0.17), `INSUFFICIENT_EVIDENCE`. The ungated z-score made +62.65% on 18 trades. This is the only gated result that is better than its base on this data, and with 15 trades from one speculative token it is far from evidence. Bollinger, range only: +8.66% on 7 trades. TSMOM, not unstable: `REJECTED_RISK` (−87.3%, max drawdown 87.6%). ML: `INSUFFICIENT_EVIDENCE` (≈35 independent 24-bar labels).

**SPY 1d. Not a valid regime test.** Trend was `UNKNOWN` on 100% of bars because regime engine 1.0.0 counted weekends as missing bars, so daily equity coverage never reached 80%. The trend-gated runs therefore never traded and are recorded as `INSUFFICIENT_EVIDENCE` (0 trades). That label is accurate, but the cause is the defect, not the market. They stay in the append-only registry. Fixed in `regime-det-1.1.0` (weekday calendar); SPY needs a re-run after that fix is deployed. ML: `INSUFFICIENT_EVIDENCE` (≈43 independent 20-day labels).

## Conclusion

**NO TRADE — NO VALIDATED POSITIVE NET EDGE** on all three datasets. Nothing is eligible for shadow evaluation. No active paper strategy, engine setting or risk limit changed.
