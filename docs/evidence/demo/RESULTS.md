# Demonstration campaign: observed run (SYNTHETIC)

Run by Claude on 11 Nov 2026 on a local Windows machine, against a fresh local PostgreSQL 18 database with every migration applied, at commit `79b6ffe`, using the built `campaign-cli` and the real child-process evaluator. The data is constructed with planted patterns. **Nothing here is evidence about any market.**

Declaration: [`campaign.json`](campaign.json), spec hash recorded in the database. 2 datasets × 6 hypotheses = 12 units; declared limit 2,000 trials; upper bound of the declared grids 328.

## What happened

| Step | Observed |
| --- | --- |
| `plan --preflight` | Wrote nothing. Both datasets passed integrity checks (4,000 FX-calendar 1h bars; 7,000 24/7 4h bars). |
| `work --max-units 5`, then `work` | First call stopped after 5 units (5 succeeded, 7 pending). Second call resumed and finished the other 7. Total 33 s for 12 units. |
| Trial count | 0 before; 328 after, all settled, none outstanding. |
| Holdouts read by the run | 0. Every holdout withheld. |
| `evaluate-holdout` with no authorisation | Refused: `NOT_AUTHORIZED … the holdout stays withheld`. |
| `authorize-holdout` on a rejected hypothesis | Refused: `NOT_ELIGIBLE … did not pass walk-forward (INSUFFICIENT_EVIDENCE): OOS trades 18 < 30`. |
| Authorised holdout, strategy | `RECORDED`, verdict `VALIDATED_CANDIDATE`. A second `evaluate-holdout` returned `ALREADY_CLOSED` and read nothing. |
| Authorised holdout, ML 2.0 | `RECORDED`, verdict `CANDIDATE`. |
| `register-model` on a real instrument key (`XAU_USD`) | Refused: `SYNTHETIC_ONLY`. |
| `register-model` on `SYNTHETIC:SYN-SPIKE-4H`, then `observe` | Model `campaign-ml2-synthetic` registered, then `SHADOW_CANDIDATE`. No prediction recorded (no bars exist for a synthetic key). |
| Trading tables afterwards | Orders 0, trade intents 0, fills 0, promotions 0, strategy instances 0, `EngineControl` rows 0. |

## Hypotheses

Every unit was deflated by the same programme count (328: nothing outside the run, plus every other unit of the run at its planned bound).

| # | Dataset | Hypothesis | Stage | Outcome | Trials | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | FX breakout 1h | `hz_atr_breakout` | Holdout evaluated | Passed, research only | 44 | Passed walk-forward and a once-read holdout |
| 1 | FX breakout 1h | `hz_vol_expansion` | Pending holdout | Withheld | 24 | Passed every pre-holdout test; holdout unread |
| 2 | FX breakout 1h | `hz_mtf_trend` | Historical result | Insufficient evidence | 24 | 18 out-of-sample trades, below 30 |
| 3 | FX breakout 1h | `hz_vol_mean_reversion` | Historical result | Rejected: risk | 44 | Out-of-sample drawdown 42.9%, above 30% |
| 4 | FX breakout 1h | `hz_regime_breakout` | Historical result | Insufficient evidence | 24 | 29 out-of-sample trades, below 30 |
| 5 | FX breakout 1h | `ml2:h8` | Historical result | Insufficient evidence | 4 | A volume feature is missing on every bar (the series has constant volume) |
| 6 | Volume spike 4h | `hz_atr_breakout` | Historical result | Insufficient evidence | 44 | Does not beat buy-and-hold and the random control |
| 7 | Volume spike 4h | `hz_vol_expansion` | Historical result | Rejected: overfit | 24 | Deflated Sharpe 0.662, below 0.95 after 328 trials |
| 8 | Volume spike 4h | `hz_mtf_trend` | Historical result | Insufficient evidence | 24 | 11 out-of-sample trades, below 30 |
| 9 | Volume spike 4h | `hz_vol_mean_reversion` | Historical result | Rejected: costs | 44 | Gross +14.14% becomes net −3.90% at 20 bps a side |
| 10 | Volume spike 4h | `hz_regime_breakout` | Historical result | Insufficient evidence | 24 | Does not beat buy-and-hold and the random control |
| 11 | Volume spike 4h | `ml2:h24` | Prospective observation | No predictions yet | 4 | Frozen model registered and under observation |

## Things this run showed that the tests do not

- An earlier attempt at the same campaign (commit `b809155`) lost a unit claim to Prisma's 5-second transaction limit. No data was damaged. The fix changed the commit, the pinned run then refused to continue (`CODE_VERSION_MISMATCH`), it was cancelled, and an intentional rerun was declared with a reason. That is the retry/rerun distinction working on a real fault.
- The evaluator runs as a separate process here; the integration tests run it in-process.

## Not shown

- A shadow prediction for this model: the shadow service is off and has no bars for a synthetic key. Scoring of a frozen campaign model, duplicate prevention and horizon timing are covered by `campaign-shadow.integration.test.ts`. Outcome resolution after the horizon is covered by the existing GENESIS integration tests, not by a campaign model.
- Any real dataset. The local database has no warehouse history and production was not touched.
