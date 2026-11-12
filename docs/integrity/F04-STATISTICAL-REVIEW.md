# F04 — Deflated Sharpe Ratio protocol (dsr-2.0.0)

Branch `integrity/phase-ii`. Files: `packages/backtest/src/research/metrics.ts`, gates in `validate.ts`, `ml2.ts`, `intelligence.ts`, campaign version record `packages/evolution/src/campaign/spec.ts`, registration gate `packages/evolution/src/campaign/bridge.ts`.

## Original defect and reproduction

`deflatedSharpe` estimated the cross-trial Sharpe variance V as 0 when fewer than two trial Sharpes were finite or all were identical. `expectedMaxSharpe(N, 0)` = 0, so DSR collapsed to PSR against 0 whatever N was:

| trialCount | dsr-1 (old) | dsr-2.0.0 (new) |
| --- | --- | --- |
| 3 | 0.99996 | 0.99897 |
| 1,000 | 0.99996 | 0.75188 |
| 1,000,000 | 0.99996 | 0.17558 |

Case: SR 0.125 (per bar), n 1,000, skew 0, kurtosis 3, trial Sharpes [0.125 × 3]. The same collapse affects the ML path, which estimates V from 3–6 highly correlated learners (V ≈ (1 − ρ)σ²) while N is the programme count (thousands).

## Methodology

- **PSR** (Bailey & López de Prado 2012): P[SR > SR*] = Φ((SR − SR*)·√(n − 1) / √(1 − γ3·SR + (γ4 − 1)/4·SR²)). Here SR is the per-bar (non-annualised) Sharpe and γ4 is non-excess kurtosis. The variance term is Mertens' (2002) Sharpe-estimator variance.
- **DSR** (Bailey & López de Prado 2014): SR* = √V · ((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))), the expected maximum of N independent N(0, V) estimates.
- **Units** (reviewer item 1): consistent, with no unit bug. Strategy path: per-bar Sharpes. ML path: per-trade Sharpe with n = trades / horizon.

## Chosen policy (protocol `dsr-2.0.0`)

1. **N** = max(1, finite trial Sharpes, programme `trialCount`), used in full. No effective-trials reduction.
2. **N ≤ 1**: no selection happened, so DSR = PSR(0).
3. **N ≥ 2**: at least 2 finite trial Sharpes are required; otherwise the result is `DSR_DISPERSION_UNESTIMABLE`. Silently dropped failures would make N and V unverifiable.
4. **V = max(V_cross, V_floor)**, where V_floor = max(1, 1 − γ3·SR + (γ4 − 1)/4·SR²) / (n − 1), using the tested Sharpe's own n. The report records `variance` and `varianceSource` (`CROSS_TRIAL` / `SAMPLING_FLOOR`).
5. **Explicit insufficiency.** DSR is null with a reason code instead of a convenient default:

   | Reason code | Condition |
   | --- | --- |
   | `DSR_NONFINITE_INPUT` | a non-finite input |
   | `DSR_SAMPLE_TOO_SMALL` | n < 100 |
   | `DSR_INVALID_MOMENTS` | γ4 < 1 + γ3² |
   | `DSR_VARIANCE_NONPOSITIVE` | the PSR variance is not positive |
   | `DSR_INVALID_TRIAL_COUNT` | trial count NaN, ±∞, negative, or > 10¹⁵ (where 1 − 1/N rounds to 1) |
   | `DSR_DISPERSION_UNESTIMABLE` | see item 3 |
   | `DSR_NONFINITE_OUTPUT` | a non-finite result |

6. **The PSR function never returns NaN.** Every gate now uses `dsrPasses(dsr, threshold)`, which is true only for a finite DSR ≥ the threshold.
7. **ML no longer assumes normal moments.** Missing skew or kurtosis is passed as NaN, which gives `DSR_NONFINITE_INPUT` and a gate failure, instead of `?? 0` / `?? 3`.
8. **Verdicts.** In `validate.ts`, a non-computable DSR is `INSUFFICIENT_EVIDENCE` (previously `REJECTED_OVERFIT`). A computable DSR below 0.95 is still `REJECTED_OVERFIT`. Reason strings name the reason code and the protocol.

### Mathematical reasoning

- **Why max, not sum.** Under the null that every trial has true SR 0, each estimated Sharpe has marginal variance ≈ V_floor. V_cross already contains that estimation noise, so adding V_floor to it would count the noise twice. Taking the maximum only restores the null-case dispersion when the observed spread is smaller, which happens for identical or correlated trials.
- **Why the full N is conservative with the floor.** For correlated normals with equal marginal variance, the expected maximum is at most the independent-case value (Slepian's inequality). The reviewer's Monte Carlo at N = 100 gave 2.51 / 1.76 / 0.78 for ρ = 0 / 0.5 / 0.9. Using the full N with V_floor therefore overstates the benchmark for correlated trials. That errs towards rejection, which is the safe direction.
- **Why the numerator is clamped at 1.** With positive skew, 1 − γ3·SR + … can be below 1, which would put the floor under the null variance 1/(n − 1).
- **Why the boundary case is unreachable with valid moments.** With γ4 ≥ 1 + γ3², the PSR variance term is at least (γ3·SR/2 − 1)², which is never negative. It is zero only at γ4 = 1 + γ3² and SR = 2/γ3, which is the case the `DSR_VARIANCE_NONPOSITIVE` test uses.
- **Monotonicity.** The expected-maximum factor rises with N; the reviewer checked every N from 2 to 200,000. V does not depend on N, so DSR is non-increasing in N for fixed data. Tests cover 1 to 10¹² for both degenerate and dispersed trials.

### Rejected alternatives

- **A floor added to V_cross:** double-counts estimation noise.
- **An effective-trials correction:** N̂ from ρ̄ or ONC clustering cannot be estimated reliably from 3–6 learners, and programme trials from other runs are not observed at all. An under-estimated N̂ would be anti-conservative. Rejected for now; reconsider only with a clustering estimate built from the full trial-return matrix, at least ~10 trials and a stated procedure.
- **Refusing every degenerate case (null) without a floor:** defensible, but it discards valid evidence when N is large and the data are informative. The floor gives a principled, conservative number instead.

## Independent review

An independent reviewer (separate read-only agent, Opus) reviewed the code and ran numerical checks against the built `dist` with its own scratch implementation of the floor. Verdicts:

| Item | Verdict | Conditions |
| --- | --- | --- |
| (a) Insufficiency policy | APPROVED WITH CONDITIONS | reason codes; null when fewer than 2 finite trial Sharpes and N ≥ 2; DSR = PSR(0) when N ≤ 1; fix the NaN gate path. All implemented. |
| (b) Sampling-variance floor | APPROVED WITH CONDITIONS | use max not sum; use the tested Sharpe's n; clamp the numerator at 1 or more; record which variance was used. All implemented. |
| (c) Effective-trials correction | REJECTED for now | use the full programme N with the floor. Implemented. |

Additional findings, all addressed:

- **High — NaN bypassed the gate.** `probabilisticSharpe` returned NaN for n = NaN, and `NaN < 0.95` is false, so the gate passed.
- **Medium — `normalQuantile` threw** for trial counts of NaN, ∞ or about 1e17.
- **Accepted impossible moments.** Kurtosis −2 was accepted.

The reviewer also noted, and I left unchanged, four conservative-only notes:

- `validate.ts` mixes TRAIN-fold and FULL_GRID Sharpes, which inflates V. This is conservative.
- TEST windows are counted in N, which over-counts. This is conservative.
- The ML champion is chosen by Brier score, not Sharpe, so deflating it as the maximum Sharpe over-penalises.
- The run-local `dsr` drops failed trials from N. This is anti-conservative, but the programme-wide `dsrProgramme`, which the gates prefer, counts them.

Not verified: whether `chosen1` and `chosen` in `ml2.ts` are the same trade set.

Reviewer limitations, stated by the reviewer: the paper formulas and the effective-N approximation were recalled from memory, not fetched; the numerical checks used compiled `dist`; Monte Carlo used 4,000 replications.

## Validation protocol and historical evidence

- `DSR_PROTOCOL_VERSION = "dsr-2.0.0"` is stamped on every DSR result. `campaignVersions()` now includes `dsrProtocol`, so it is part of every new unit's spec hash and stored provenance.
- **Historical results are not rewritten.** Stored `dsr` / `dsrProgramme` objects without `protocol` are dsr-1 by definition. Registry rows, campaign results and verdicts keep their values. Nothing recomputes or reclassifies them.
- **No automatic promotion.** The change can only lower a DSR or turn it into null. It never raises one. The single exception is the N ≤ 1 path, which is unchanged.
- **Revalidation policy.** `registerCampaignModel` refuses (`REVALIDATION_REQUIRED`) a holdout result whose provenance does not carry `dsrProtocol: "dsr-2.0.0"`. A result judged under dsr-1 must be rerun as a new campaign run, which reserves and counts its trials again, before it can enter shadow observation. Models already registered keep their state. The operator should list them before deploying (read-only: `SELECT id, family, "createdAt" FROM "ModelVersion" WHERE family IN ('campaign-ml2','campaign-ml2-synthetic')`) and decide whether to retire or revalidate any that are under observation.
- **Effect on in-flight campaign runs.** Adding `dsrProtocol` changes the unit spec hash for units planned after deploy. Runs created before deploy keep their stored versions.

## Tests

| Test | Result |
| --- | --- |
| `packages/backtest/src/research/dsr.test.ts` (24) | 24/24. Reviewer's degenerate table reproduced to 4 d.p. Agreement with an independent reference implementation (different CDF and bisection quantile) to 4 d.p. on 5 cases. Monotone in N (1 → 10¹²) for degenerate and dispersed trials. Max-not-sum. Numerator clamp. Correlated learners deflated by the programme N. N ≤ 1 → PSR(0). 13 explicit insufficiency cases incl. NaN/∞/1e17 trial counts. Extreme Sharpes bounded. PSR never NaN. Gate helper rejects null/NaN/undefined. Every gate uses the helper; ML has no `?? 0` / `?? 3`. |
| `packages/evolution/src/campaign/dsr-revalidation.test.ts` (4) | 4/4: unversioned, `dsr-1` and other protocols refused; current protocol passes the gate |
| Existing `packages/backtest` + `packages/evolution` suites | pass (366 + new). The two existing campaign tests updated only for the new `pendingOutcomesInSample` field (F09). |
| Mutation: floor removed (V = V_cross) | 5 tests fail (killed) |
| Mutation: PSR finite guards removed | 1 test fails (killed) |
| Mutation: gate helper `!(dsr < t)` (NaN passes) | 1 test fails (killed) |

## Limitations

- Primary sources were not fetched during this session; the formulas are standard and were cross-checked numerically, not textually.
- Effective-N for correlated trials is deliberately not estimated, so the penalty for small, correlated ML learner sets is an upper bound and may reject genuine edges.
