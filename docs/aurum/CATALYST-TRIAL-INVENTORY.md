# Historical trial inventory: experiments outside the registry

CATALYST, 18 Nov 2026. Repository, git-history and documentation evidence only. No production query beyond D8, no CLI run, no holdout read, nothing declared.

The registry discrepancy is closed ([D8-PRODUCTION-READONLY.md](D8-PRODUCTION-READONLY.md)): 2,454 rows = 2,170 counted (TRAIN + FULL_GRID) + 284 TEST. This document covers only trials that the registry and the (empty) ledger do not contain.

## How trials were counted then (VERIFIED_REPOSITORY)

| Code | Rule | Source |
| --- | --- | --- |
| Strategy walk-forward (all versions used) | per family with grid G and 4 folds: G×4 TRAIN + 4 TEST + G FULL_GRID = **5G + 4** rows; the programme rule counts **5G** | `packages/backtest/src/research/validate.ts` (`trialCount` excludes HOLDOUT only), `DEFAULT_VALIDATION.folds = 4` |
| Check against production | `donchian_breakout` 34 rows / 30 counted ⇒ G = 6 ✓; `zscore_reversion` 94 / 90 ⇒ G = 18 ✓ | D8 run inventory |
| HORIZON grids (`5902f49`, `19d938d`, identical) | ATR breakout 8, vol expansion 4, MTF trend 4, vol mean-reversion 8, regime breakout 4 (sum 28); session breakout 4 × session windows, **intraday only** | `horizon-strategies.ts` |
| Session windows | GOLD and FX 2 (London open, NY open); ETF 2; CRYPTO 0 | `market-config.ts` at `19d938d` |
| ML 2.0 (`ml-wf-2.0.0`) | 4 learners (base rate, logistic, boosted stumps, random forest) per horizon; `horizon-cli` and GENESIS use 1 horizon ⇒ **4 per run** | `ml2.ts` `DEFAULT_LEARNERS`; GENESIS ledger "+4 per run" |
| ML 1.0 (`ml-wf-1.0.0`) | 3 models (base rate, logistic, boosted stumps) ⇒ 3 per run; **never written as `ResearchTrial` rows** | `ml.ts` at `d2d1526`; D8: every `ml_netpos_*` run has 0 rows |

Each HORIZON run started from the same hand-typed `--prior-trials`, so the running totals in the ledgers (2,474, 2,700, "~2,900", 3,000) are per-run labels, not cumulative counts. **The earlier "≈ 550" estimate (3,000 − 2,454) is rejected.** It subtracted raw rows (including TEST) from a rounded label, and it treated per-run totals as cumulative. For example, four hourly runs of about 208 trials each, all starting from 2,700, add about 830, not 200.

## Inventory

Counted = the programme's own rule (TRAIN + FULL_GRID + ML learners). Attempted also includes TEST windows. "UB" means an upper bound from declared grids: a grid scaled down for short data, or a family refused for too few bars, gives fewer.

| # | Date | Family | Instrument / data | Mode, code | Runs | Attempted | Counted | Registry | Ledger | Evidence | Confidence |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| E1 | 1 Nov | regime-gated (5) + ungated base (4) + ML 1.0 | SOL/USDC 1h, GeckoTerminal, 4,319 bars (same pool as warehouse; not independent) | offline `intelligence-cli`, uncommitted `feat/singularity-regimes-ml` build | 2 (20:24; rerun 20:31 after review fixes) | 818 | 746 | no (offline mode has no registry) | no | `docs/ascend/singularity/evidence-2026-11-01-sol-usdc.md` | MEDIUM: per run 215 + 191 rows, grids assumed equal to `0e970a9` registry rows |
| E2 | 1 Nov | ML 1.0 learners of registered runs | 6 datasets | warehouse, `0e970a9`, `d2d1526` | 6 | 18 | 18 | run rows yes, **trial rows no** | no | D8 (`ml_netpos_h20/h24`, 0 rows) | HIGH |
| E3 | 4 Nov | GENESIS ML 2.0 | SOL/USDC 1h ×2 horizons, GATO 1h, SPY 1d ×2 horizons; CSV export of production warehouse | CSV, `a4e7b52` / `43ffd47` | 5 distinct, plus 3 deterministic Solana reruns on `43ffd47`; first SPY run refused all bars (0) | 32 | 32 (20 distinct) | no | no | `docs/genesis/EXECUTION_LEDGER.md` §"First real ML runs" | HIGH |
| E4 | 4 Nov | HORIZON 5 families + ML 2.0 | SPY 1d, SOL/USDC 1h, GATO 1h; warehouse CSV export | CSV, `5902f49`, prior 2,474 | 3 | 492 UB | 432 UB | no | no | `docs/horizon/LEDGER.md` §"Real-data runs" | MEDIUM (UB: CRYPTO has no session windows; SPY daily 1,464 bars may scale grids) |
| E5 | 6 Nov | HORIZON 6 families + ML 2.0 | EUR, GBP, JPY, XAU 1h (OANDA practice) | CSV, `19d938d` (#65), prior 2,700 | 4 | 832 | 736 | no | no | `docs/horizon/LEDGER.md` §"Hourly gold and FX studies" | MEDIUM-HIGH: about 208 per run, matching the reported "~2,900" |
| E6 | 6 Nov | HORIZON 5 families + ML 2.0 | EUR, GBP, JPY, XAU 1d ny17 (weekend stubs excluded) | CSV, `horizon/fx-weekend-stubs`, prior 3,000 | 4 (earlier attempts refused at bar integrity: 0 trials) | 656 UB | 576 UB | no | no | `docs/horizon/LEDGER.md` §"Daily gold and FX studies" | MEDIUM (UB: daily grids may scale) |
| E7 | 10 Nov | HORIZON + ML 2.0, repeat of E6 XAU | XAU 1d ny17, production warehouse | **warehouse mode, pre-#71**, `62e2787` | 1 | 164 UB | 144 UB | no (`horizon-cli` never wrote the registry) | no | `docs/horizon/LEDGER.md` checkpoint 5 ("run directly from the production warehouse … matching the local run") | HIGH that it ran; count as E6 |
| — | 1 Nov | registered strategy runs | 7 datasets | warehouse `--record` | 174 | 2,454 | 2,170 | **yes** | n/a | D8 | VERIFIED: already counted; TEST excluded by rule |
| — | various | synthetic fixtures, demo reports, tests | synthetic | n/a | — | — | 0 | n/a | n/a | `docs/evidence/demo/RESULTS.md`, `docs/acceptance/*` | excluded: no selection on real data |

**Duplicate descriptions identified:**
- E1's two runs are the same experiment, rerun after review fixes, with identical strategy figures.
- E3's Solana reruns on `43ffd47` are deterministic repeats.
- E7 repeats E6's XAU run on the same dataset ("matching the local run").
- E1 also overlaps in data and design with the registered `0e970a9` SOL runs, but uses a different source and code build.
- The figures 2,474, 2,700, ~2,900 and 3,000 are labels on the runs above, not separate experiments.

**Pre-#71 warehouse mode (questionnaire Q2):** E7 is the only warehouse-mode run documented before #71. E2's ML learners ran in warehouse mode, but their parent runs are registered. No CLI log or output file of any run survives on this machine: a search of the project and scratch directories for `runTrials` and `programmeTrialCount` output found nothing. Production stdout of E7 was not retained.

## Totals and the proposed declaration

| Basis | Total |
| --- | ---: |
| Distinct configurations, programme rule (E1 one run, E3 20, E7 excluded) | 2,155 |
| **Programme rule, every run including reruns (recommended)** | **2,684** |
| Strictest: every evaluation including TEST windows and reruns | 3,012 |

Recommendation: declare **2,684** as one `LEGACY_DECLARED` row. It is an upper bound under the same rule the registry uses (TRAIN + FULL_GRID + ML learners). It counts reruns, because each was a further look at the same data. It takes the unscaled declared grid wherever the scaled grid is unknown.
- Over-counting only makes deflation stricter; under-counting would loosen it.
- The main uncertainty is E1, which ran an uncommitted build. If its grids were larger than the `0e970a9` registry grids, the bound is low. The evidence file lists exactly the five gated hypotheses and their four ungated strategies, which is what was counted.

Command for operator review (**not run**; it appends irreversibly and is not idempotent by note):

```text
node apps/worker/dist/src/research/campaign-cli.js declare-legacy-trials --count 2684 --by <OPERATOR> --note "CATALYST historical inventory 2026-11-18 (docs/aurum/CATALYST-TRIAL-INVENTORY.md): E1-E7 CSV/offline/warehouse HORIZON, GENESIS and ML trials outside ResearchTrial; programme rule TRAIN+FULL_GRID+ML learners incl. reruns; unscaled declared grids as upper bound; registry 2,170 counted rows unchanged (D8)"
```

Before running it, confirm that the production `ResearchTrialLedger` is still empty, so that nothing is declared twice. Then record the returned declaration id and check that `campaign-cli trials` reports 2,170 + 2,684 = 4,854.

**Not covered:** research before the registry existed (26 Oct–1 Nov research lab and backtests in tables such as `BacktestRun` and `ExperimentReport`). Those rows, if any, sit in production tables that D8 did not cover. Counting them needs a further read-only query (`SELECT count(*), min("createdAt"), max("createdAt") FROM "BacktestRun"`, and the same for `ExperimentReport`), which needs its own approval.
