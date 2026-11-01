# Operation Singularity: work ledger

Durable record for ASCEND-04, 05, 07, 08, 09, 10 and 11, so a new session resumes instead of repeating work. Labels are those in [`../README.md`](../README.md). Authority order: the repository, then `AGENTS.md`, then this file.

Nothing here changes order admission, risk limits, engine config or strategy promotion. Everything below is research-only unless a row says otherwise.

## Master matrix

| Item | State | Evidence | Next |
| --- | --- | --- | --- |
| S-00 holdout circumvention | Fixed in code: a strategy id consumes a holdout once per instrument × interval, across versions and re-imported datasets (`apps/worker/src/research/holdout-policy.ts`). The DB unique key (strategy × version × dataset) still backs the exact case. Strategy renaming is not preventable in code; review catches it, and DSR now deflates by the whole programme | `VERIFIED_UNIT` (`holdout-policy.test.ts`) | Deploy with the next research run |
| S-00 programme-wide selection | DSR was deflated by the run's own ~50–100 trials, not the programme's 1,594. `validateStrategy` now takes `programmeTrialCount`; the verdict uses the stricter `dsrProgramme`. Stored runs keep their original (local) DSR; nothing is rewritten | `VERIFIED_UNIT` (`research.test.ts`) | |
| S-00 cost proxy (4.1) | Every DEX cost basis is present-day pool liquidity standing in for the whole window; the ETF basis is a static spread. No point-in-time reserve history is held. Mitigation: OOS net at 2× and 3× cost is reported, and a candidate on a proxy basis must stay net-positive at 2× | `VERIFIED_UNIT`. Historical reserves: `BLOCKED_EXTERNAL` (no licensed source configured; candidates to evaluate: on-chain pool account history via an archive RPC, Dune/Flipside exports; licensing not checked) | Choose a provider (operator decision; may cost money) |
| S-00 `fitGridToData` (4.4) | Re-read: depends only on bar count, fold config and the declared grid. Performance-blind | Code inspection | |
| S-00 leakage (4.2) | Simulator is structurally point-in-time (frozen look-back, next-open fills); the CLI reads bars with `availableAt ≤ now`. Known gaps: SPY bars are IEX and unadjusted (no corporate-action table), so dividends are missing from every SPY return, buy-and-hold included; the speculative-token cohort is the four pools QUANT traded (selection and survivorship bias) | Code inspection | Corporate-action table; inactive-token cohort |
| S-00 E2E isolation / empty `whyBlocked` (4.5) | Not started this session | none | |
| ASCEND-04 regime engine | `packages/backtest/src/research/regime.ts` (`regime-det-1.0.0`): filtered, deterministic; trend from the drift t-statistic of returns (a slope t-stat on price levels was found by test to call most random walks STRONG trends, and was replaced); volatility level by expanding-history percentile and direction; behaviour by variance ratio, Donchian breakout and two-sided CUSUM change points; broader market from a benchmark only after its bar closes; liquidity always UNKNOWN (no point-in-time liquidity). Confidence is a heuristic margin, not a probability. HMM / Bayesian state-space: `DEFERRED` (the deterministic baseline has shown no decision utility to beat yet) | `IMPLEMENTED`, `VERIFIED_UNIT` (prefix-invariance, gaps → UNKNOWN, benchmark timing); `VERIFIED_HISTORICAL` on SOL/USDC 1h ([evidence](evidence-2026-11-01-sol-usdc.md)) | Persisted regime history table (migration: operator approval); dashboard (ASCEND-10) |
| ASCEND-04 strategy-by-regime | `regime-analysis.ts`: descriptive split by regime at the decision bar, and five pre-declared gated hypotheses run as their own strategies through the full ASCEND-03 protocol | SOL/USDC 1h: all five rejected or unproven; no gate improved both net return and drawdown | Done 1 Nov 2026 ([production evidence](evidence-2026-11-01-production.md)): nothing validated; GATO z-score range-only +81% on 15 trades (`INSUFFICIENT_EVIDENCE`); SPY invalid under 1.0.0 (weekends counted as gaps), fixed in 1.1.0, re-run pending |
| ASCEND-05 feature store | `features.ts` (`features-1.0.0`, 16 features with definition, inputs, lookback, missing policy; hash recorded); executable net labels (next open → open after horizon, cost both sides) and barrier labels (stop assumed first within a bar) | `VERIFIED_UNIT` (prefix-invariance, label timing) | Persisted feature snapshots for shadow forecasts (ASCEND-09/11) |
| ASCEND-05 models | `ml.ts` (`ml-wf-1.0.0`): base rate, L2 logistic, boosted stumps; expanding walk-forward with purge of every training label reaching the test window; standardiser fitted per training fold; 20% holdout reserved, never evaluated; Brier, log loss, ECE, AUC (overlap-deflated p), reliability, PSI drift; abstention on model disagreement / out-of-distribution / missing features; plain-JSON artefacts with hashes. Random forest and neural models: `DEFERRED` (no baseline skill) | `VERIFIED_UNIT` (purging, no skill on random walk, learns a planted signal, refuses tiny data); SOL/USDC 1h: `NO_SKILL` (both models worse than base rate) | Dedicated model-registry table (migration: approval); currently ML runs are recorded as `ResearchRun` rows with family `ML` |
| Integrated study CLI | `apps/worker/src/research/intelligence-cli.ts`: warehouse mode (dry run unless `--record`) and an offline GeckoTerminal mode that writes nothing | Offline SOL/USDC; recorded production runs on SOL/USDC, GATO and SPY at `0e970a9` (≤ 8.2 s, ≤ 218 MB each) | |
| ASCEND-07 portfolio | Not started | none | |
| ASCEND-08 ORACLE loop | Not started | none | |
| ASCEND-09 trade feedback | Not started (needs forecasts recorded before outcomes, i.e. ASCEND-05 shadow predictions) | none | |
| ASCEND-10 terminal | Not started | none | |
| ASCEND-11 integration/deploy | Not started. No deploy, push to main or production DB write without operator approval | none | |

## Operator approvals

- 1 Nov 2026: operator approved merging PRs #40 and #41 after green CI, deploying `0e970a9`, and recorded studies on SOL/USDC, GATO and SPY. Done; see the production evidence.

Standing rule: Required before: any migration on production, any deploy, any paid data provider, any change to protected paths.
