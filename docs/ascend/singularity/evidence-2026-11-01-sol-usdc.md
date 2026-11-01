# Integrated study: SOL/USDC 1h, 1 Nov 2026

First end-to-end run of the SINGULARITY pipeline (regimes → regime-gated hypotheses through ASCEND-03 → point-in-time features → baseline models → adversarial checklist) on genuine data. Offline dry run: nothing was written to any database, and no engine, strategy or order state was touched.

## Run

- Command: `node apps/worker/dist/research/intelligence-cli.js --gecko 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2 1h --days 180` (code at branch `feat/singularity-regimes-ml`, uncommitted build; compiled with `tsc` because the local `@swc` builder is not installed).
- Data: GeckoTerminal public API (Data: GeckoTerminal), Raydium SOL/USDC pool, hourly, fetched 2026-11-01 20:24 UTC. 4,319 closed bars after normalisation (1 rejected, 4 duplicates dropped). Same source and pool as the production warehouse dataset (4,337 bars), so not independent of it.
- Cost basis: 33.25 bps per side = conservative 66.5 bps round trip for $500 at the pool's **present-day** reserve of $20.0M (`costIsProxy: true`). No point-in-time liquidity exists for this window.
- Offline mode has no registry, so DSR here is deflated by this run's own trials only; the warehouse mode deflates by the programme count.

## Regimes (`regime-det-1.0.0`, filtered)

| Trend | Share | Buy-and-hold return in state |
| --- | ---: | ---: |
| RANGE | 88.9% | +4.00% |
| WEAK_UP | 5.2% | +10.97% |
| WEAK_DOWN | 4.2% | −7.43% |
| STRONG_UP | 0.1% | −5.37% |
| UNKNOWN | 1.6% | +6.17% |

Volatility: NORMAL 51%, COMPRESSED 23%, ELEVATED 15%, EXTREME 5%, UNKNOWN 6%. Liquidity: UNKNOWN throughout (by design). Latest bar (19:00 UTC): RANGE (drift t −0.57), COMPRESSED. The by-regime split is in-sample and descriptive; it is not evidence that any regime is predictable.

## Regime-gated hypotheses (out of sample, walk-forward)

| Hypothesis | Ungated OOS | Gated OOS | Gated verdict |
| --- | --- | --- | --- |
| TSMOM, trend only | 31 trades, +14.93%, DD 21.8% | 14 trades, −1.52% (gross +8.09%; at 2× cost −10.27%), DSR 0.13, PBO 0.84 | `INSUFFICIENT_EVIDENCE` |
| MA trend, trend only | 11 trades, +51.99% | 13 trades, −0.14% (gross +8.88%), PBO 0.66 | `INSUFFICIENT_EVIDENCE` |
| Z-score reversion, range only | 9 trades, +7.00% | 3 trades, +2.53% | `INSUFFICIENT_EVIDENCE` |
| Bollinger reversion, range only | 9 trades, +10.85% | 15 trades, −1.80% (gross +8.50%) | `INSUFFICIENT_EVIDENCE` |
| TSMOM, stand aside when unstable | 31 trades, +14.93% | 46 trades, gross +32.84% → net −2.17% | `REJECTED_COSTS` |

Every hypothesis is rejected or unproven. No gate improved both net return and drawdown against its ungated strategy. Gross returns were positive in four of five, and costs removed them all.

## Models (`ml-wf-1.0.0`, label: net-positive 24-bar forward return after costs)

- 4,294 labelled rows; 263 excluded for missing features (warm-up); 807 reserved as holdout and **not evaluated**. 4 folds; 25 training rows purged per fold.
- Out-of-sample Brier: base rate 0.2544, logistic 0.2732, boosted stumps 0.2756. Brier skill −0.074 and −0.083: **both models are worse than the base rate**. AUC 0.504 / 0.496 (overlap-deflated p 0.47 / 0.53). ECE 0.146 / 0.132.
- Acting on p ≥ 0.55: 27 signals (13 more abstained on model disagreement), mean net −0.67% per signal against −0.09% for always entering.
- Maximum feature drift (PSI, last training fold vs test) 0.11.
- Verdict: `NO_SKILL`.

## Conclusion

**NO TRADE — NO VALIDATED POSITIVE NET EDGE.** Nothing is eligible for shadow evaluation. Labels: regime engine `IMPLEMENTED`, `VERIFIED_UNIT`, `VERIFIED_HISTORICAL` (classification history on genuine bars); regime decision utility `INSUFFICIENT_EVIDENCE` (rejected here); models `VERIFIED_HISTORICAL` with result `NO_SKILL`.
