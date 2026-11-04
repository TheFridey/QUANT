# Operation GENESIS: report (4 Nov 2026)

Status: **partial.** The infrastructure for every phase that could be built without new data, paid services, operator credentials or protected-path changes is merged and deployed, disabled where it can act. No model has shown skill. The evidence ledger is [`EXECUTION_LEDGER.md`](EXECUTION_LEDGER.md); this report summarises it and does not replace it.

## 1. Executive summary

- QUANT now has: all-history drawdown reporting; a data-quality report and point-in-time Opportunity History export; ML pipeline `ml-wf-2.0.0` with feasible-decision labels, purged walk-forward, block-bootstrap uncertainty and honest verdicts; a read-only trade-feedback layer; a research loop that tests against pinned, versioned warehouse datasets with redundancy and holdout-reuse refusal and a locked budget reservation; and an append-only model registry and shadow prediction store.
- First real ML runs on the production warehouse found **no skill**: four `NO_SKILL`, one `INSUFFICIENT_EVIDENCE`. Costs exceed the average move at the tested horizons.
- The requested 15% PAPER daily loss limit was **not applied**. The account is at a 10.02% drawdown, past the independent 10% total limit, so a higher daily limit would not admit any trade; a 15% daily limit can never bind while the total limit is 10%. The operator chose to leave it.
- Shadow predictions and the research loop are deployed **disabled**. Nothing was promoted, no risk limit changed, and live money stays refused.

## 2. Commits and PRs

| PR | Phase | Merge commit |
| --- | --- | --- |
| [#50](https://github.com/TheFridey/QUANT/pull/50) | 0–1 ledger, 15% tests | `0de81f4` |
| [#53](https://github.com/TheFridey/QUANT/pull/53) | 2 drawdown reporting | `e5a0c21` |
| [#54](https://github.com/TheFridey/QUANT/pull/54) | 3 data quality, Opportunity History | `b51b398` |
| [#52](https://github.com/TheFridey/QUANT/pull/52) | 4 ML engine 2.0 | `0d489e1` |
| [#56](https://github.com/TheFridey/QUANT/pull/56) | 5–6 registry and shadow | `7cdff36` |
| [#51](https://github.com/TheFridey/QUANT/pull/51) | 7 trade feedback | `0648c67` |
| [#55](https://github.com/TheFridey/QUANT/pull/55) | 8 research loop 2.0 | `c816104` |

Production: `7cdff36`, deployed 4 Nov 2026 21:48 UTC.

## 3. Implemented functionality by phase

| Phase | State | Notes |
| --- | --- | --- |
| 0 Reconstruct | Done | Baseline verified against production records |
| 1 15% daily loss | `BLOCKED` (by design) | Tests at 15% `UNIT_VERIFIED`; not applied (see §8) |
| 2 Safety and reliability | Partly done | Drawdown reporting fixed. PCR-1 ([#45](https://github.com/TheFridey/QUANT/pull/45)) still awaits the operator unlock; restore drill and authenticated smoke tests need credentials; `AgentDecision` grows ≈ 470 MB/day with no retention |
| 3 Warehouse | First increment | Quality report, coverage doc ([`DATA_COVERAGE.md`](DATA_COVERAGE.md)), Opportunity History; no new data sources added |
| 4 ML 2.0 | `UNIT_VERIFIED`, real runs done | See §5 |
| 5 Registry | Deployed, empty | Immutable `ModelVersion` (exact-text artefact with sha256 CHECK), append-only lifecycle with SQL-enforced transitions and operator approval for PAPER states; evidence labels only |
| 6 Shadow | Deployed, **disabled** | Predictions recorded before outcomes, triggers refuse edits, fair resolver, monitor suspends degrading models, leaderboard; static and runtime tests show no order path |
| 7 Feedback | Deployed | Read-only; decision record only from stored ENTRY snapshots; self-reinforcement guard |
| 8 Research loop 2.0 | Deployed, loop **disabled** | Point-in-time dataset adapter, redundancy and holdout-reuse refusal, scorer, adversary, fail-closed reservation |
| 9 Portfolio and regimes | Not started | Needs models with skill first |
| 10 Command centre | Not started | APIs exist (feedback, data quality, drawdown); new UI views not built |
| 11 Quality | Per PR | Unit, Postgres integration (CI) and e2e; independent reviews below |
| 12 Release | Done for this release | Migration-first deploy with backup and rollback snapshot |

## 4. Historical datasets

Production warehouse on 4 Nov 2026: 7 datasets, 8,043 bars. SOL/USDC 1h (4,337 bars, May–Nov 2026), GATO 1h (1,637), SPY 1d (1,464, 2021–2026), four speculative Solana 5m pools (21–515 bars). The survivorship cohort (`INACTIVE`) is empty, so every crypto result is on survivors only.

## 5. ML models and measured results

`ml-wf-2.0.0`, seed 1, programme trials 2,454 + 4 per run, holdout never evaluated (walk-forward failed first).

| Dataset | Horizon | Verdict | Champion walk-forward |
| --- | --- | --- | --- |
| SOL/USDC 1h | 4 bars | NO_SKILL | AUC 0.556, block-bootstrap lower 0.495 |
| SOL/USDC 1h | 24 bars | NO_SKILL | AUC 0.442 |
| GATO 1h | 4 bars | NO_SKILL | AUC 0.571, lower 0.494 |
| SPY 1d | 5 bars | NO_SKILL | AUC 0.505, lower 0.410 |
| SPY 1d | 20 bars | INSUFFICIENT_EVIDENCE | ≈ 41 independent labels |

No artefact was registered: none earned it, and all failed the staleness/drift deployment check.

## 6. Strategies

Validated: none. Rejected or insufficient: the five ML configurations above. The ASCEND-03 registry (174 runs, 0 holdouts consumed) is unchanged.

## 7. Shadow system

Deployed disabled; 0 predictions. No prospective results exist.

## 8. PAPER risk configuration

| Item | Before | After |
| --- | --- | --- |
| `maxDailyLossPct` | 3 | 3 (unchanged; operator: leave it) |
| `maxTotalDrawdownPct` | 10 | 10 |
| `maxRiskPerTradePct` / `maxAggregateExposurePct` | 0.5 / 20 | unchanged |
| Equity / HWM | 9,093.15 / 10,106.00 | (3 Nov reading) |
| Total drawdown | 10.02% | at or above the limit: BUYs rejected with `TOTAL_DRAWDOWN_LIMIT`, circuit breaker open on evaluation |
| Paper results | 69 trades, 13 W / 56 L, PF 0.3346, −13.14 USD/trade | — |

## 9. Tests

Each PR: targeted vitest, typecheck and lint locally; CI `test` (including Postgres integration), `build-packages` and `browser-e2e` green before merge. `main` CI green on `7cdff36`. Locally on Windows, `packages/shared/src/restore-drill.test.ts` fails to load its `.mjs` script (not on CI). One intermittent e2e start-up failure (`Unique constraint failed on the fields: (id)`) passed on rerun; root cause not investigated.

## 10. Independent reviews

- Regression review of #51–#54: APPROVE WITH NOTES each; three Medium load issues and accuracy notes, all fixed before merge.
- quant-safety-reviewer on #55: APPROVE WITH NOTES; M1 holdout re-queue, M2 reservation under-count, L1–L4, all fixed.
- db-migration-reviewer on #56: REQUEST CHANGES, then APPROVE WITH NOTES; all notes fixed. The later exact-text hash change was not re-reviewed by it.

## 11. Production and rollback

`7cdff36` live; backup `quant-20261104T214108Z.dump`; rollback to `d2fc28a` with snapshot `/srv/quant/releases/d2fc28a-20261104T214202Z`. The migration is additive; rolling back code leaves the new tables in place and unused.

## 12. Known limitations and open questions

- No model has skill on the data available; the warehouse is short (≤ 6 months crypto) and survivor-only.
- QUANT records no return forecast at entry, so feedback compares costs, not expected returns.
- `AgentDecision` growth needs a retention decision.
- The app DB role owns the GENESIS tables; separate ownership before enabling shadow.
- API and research-loop model spend can still jointly exceed the cap (documented residual M-2).
- Restore drill and authenticated production checks are still not run.

## 13. Purchases needing approval

From [`DATA_COVERAGE.md`](DATA_COVERAGE.md): GeckoTerminal paid tier (longer Solana history), Birdeye history, Alpaca SIP data, licensed index levels; an FX history source (OANDA not configured).

## 14. Next priorities (value vs risk)

1. Longer and survivor-inclusive crypto history (needs purchase decision), then rerun ML: the main limit on evidence.
2. Restore drill and authenticated smoke tests (operator credentials).
3. `AgentDecision` retention.
4. Command centre views over the new APIs (Phase 10).
5. DB role separation, then enable shadow for any model that reaches `HISTORICALLY_ELIGIBLE`.
6. PCR-1 after the operator unlock.
7. Portfolio and regime layer (Phase 9) once a model shows skill.
