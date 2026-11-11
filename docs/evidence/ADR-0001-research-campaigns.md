# ADR-0001: durable research campaigns, trial and holdout ledgers, and the bridge to shadow

Status: accepted for research use (10–11 Nov 2026), revised after two independent reviews (see "Review outcome"). Scope: OPERATION EVIDENCE. Research only: nothing here creates orders, changes `EngineControl`, risk limits or strategy instances, or promotes anything. No protected path is changed.

## Context

- `horizon-cli` and `ml-cli` printed JSON and recorded nothing. Their trials were not in the registry, so the programme trial count that deflates every Sharpe was a number typed on the command line (about 3,000 by 6 Nov).
- `research-cli` recorded a run after it finished. A crash lost the trials, and a holdout was read before its access row was written.
- The GENESIS model registry and shadow service existed, but `registerModel` and `transitionModel` had no caller outside tests, so no research result could reach prospective observation.
- HORIZON's overall verdict called a study `CANDIDATE_PENDING_HOLDOUT` when a holdout had already been consumed (fixed in `horizon-verdict.ts`, with regression tests).

## Decision

A **campaign** is an immutable declaration (datasets, hypotheses, validation, costs, limits), hashed. A **run** executes it; each **unit** is one hypothesis on one dataset. Code: `packages/evolution/src/campaign/` (library), `apps/worker/src/research/campaign-*.ts` (CLI, runner, evaluator), `apps/worker/src/campaign-job.ts` (opt-in worker job), migration `20261110120000_evidence_research_campaigns`.

### What is immutable and what is not

| Immutable (database triggers) | Mutable execution state |
| --- | --- |
| `ResearchCampaign` (declaration, `specHash` checked by the database) | `ResearchCampaignRunState` (state, cancellation) |
| `ResearchCampaignRun` (run number, reason, pinned code commit) | `ResearchCampaignUnit` execution columns (state, attempts, lease, version) |
| `ResearchCampaignResult` (one per unit and phase) | |
| `ResearchCampaignEvent`, `ResearchTrialLedger`, `ResearchHoldoutLedger` (append-only) | |

A unit's identity columns cannot change, a terminal unit cannot be reopened, and no row in any of these tables can be deleted or truncated.

### Retry and rerun

- **Retry**: the same unit runs again after a failed attempt or a lost lease. Same unit id, same trial reservation, same frozen `priorTrials`, at most one result per phase. A retry cannot create an experiment or overwrite evidence. The failed attempt's error stays in the event log.
- **Rerun**: `start --rerun --reason …` creates a new run number with new units and new reservations. Earlier runs are untouched.
- A run is pinned to a git commit. A process on any other commit refuses to work it before claiming anything. Each dataset's content hash is pinned by the first unit that reads it; a later unit or retry that sees different bars fails with `DATASET_CHANGED`.

### Reproducibility

Each result stores the dataset identity (source, instrument, interval, calendar, alignment, as-of instant, availability policy, cleaning with every excluded bar, content hash), the provenance (commit, runner/strategy/market-config/feature/label versions, market-config hash, seeds, declared search space and its hash, cost assumptions, the applied validation cost), the frozen prior trial count, runtime and peak memory, and a `resultHash` over the deterministic content. Re-evaluating the stored inputs reproduces the hash (integration test).

The declaration has no field for a grid or an acceptance threshold. Grids come from the pinned strategy library and rules from the pinned validator, so a disappointing result cannot widen a search or lower a bar. Unknown fields are refused. The settings it does expose can only make a study harder: folds, holdout fraction, bootstrap resamples, random controls and prefix probes are bounded below by the validated defaults, and cost overrides below the market default are refused.

### Trial accounting

Programme count = ASCEND registry rows (`TRAIN` and `FULL_GRID` windows) + declared legacy trials + for each campaign unit its settled count, else its reservation.

| Unit event | Effect on the count | Why |
| --- | --- | --- |
| Scheduled, never started | 0 | Nothing was computed, so nothing was selected on. |
| Started | Full declared upper bound, committed under one advisory lock before the first trial | A reader must never see fewer trials than may already have run. Concurrent campaigns are serialised, so each sees the other. |
| Deflation of a unit | Everything outside its run, plus every other unit of its run at that unit's planned bound (frozen in the reservation) | Independent of the order units happen to run in, so listing a favourite hypothesis first earns no lighter deflation. |
| Completed | Actual count (never above the bound), written with the result | The bound is replaced by the truth only when the truth is stored. |
| Failed, abandoned, cancelled after starting, crashed | Full bound, permanently | The trials may have run and been seen in logs or output. |
| Retried | Unchanged | The retry repeats the same deterministic trials; it adds no selection freedom and must not reset anything. |
| Intentional rerun | Counted again | Over-counting an identical rerun is the safe direction. |

Rationale: the deflated Sharpe ratio's expected maximum grows with the number of trials. Understating that number makes every later result look more significant than it is; overstating it only makes the bar higher. So every ambiguous case counts in full. A unit's `priorTrials` is frozen in its reservation, which keeps a retried result reproducible even if other campaigns ran in between.

`horizon-cli` and `ml-cli` now append the number of trials they ran to the ledger in warehouse mode (the study itself is still not stored). CSV mode has no database and says so in its output.

The unit count includes `TEST` windows; the registry count does not. This is slightly conservative and deliberate.

`campaign-cli declare-legacy-trials` records trials that were run before the ledger existed. **It has not been run against production**: the roughly 3,000 unrecorded HORIZON CLI trials are still outside the count there until the operator declares them.

### Holdout accounting

- A campaign never reads a holdout. The walk-forward phase always withholds it (`holdoutPolicy` has one legal value).
- An operator authorises **one read for one frozen result** (`AUTHORIZED`: `operator:<identity>`, expiry at most 7 days, bound by hash to the walk-forward result and the period). ADMIN-only API route or CLI.
- The read is preceded by a committed `CONSUME_INTENT`. From that commit the period is spent, whatever follows. The database allows one intent and one close per unit.
- The intent is closed by `RESULT_RECORDED` or `RESULT_LOST`. A lost result (crash, timeout, mismatch) is **never recomputed**: the answer may have been seen. The unit's holdout result is `HOLDOUT_CONSUMED_RESULT_LOST` and the lineage needs bars after that period.
- Identity is wider than names. The instrument is normalised to letters and digits; the lineage is the strategy family, or one lineage for all ML 2.0 studies of the target; periods match by calendar overlap. **The bar size is not part of the identity**: 1h and 4h bars over the same weeks are the same market history. A renamed strategy, another interval, a re-imported or appended dataset, a new dataset key or a new campaign therefore meets the earlier access.
- Bars a lineage has already been walked forward on are not a holdout. Declaring an earlier as-of instant, so that the "last 20%" lands on bars another unit of the lineage already tested, is refused.
- A strategy below its market's minimum sample cannot be authorised: it could never become a candidate, so it must not spend the period.
- Before the intent is committed, the executing process re-computes the walk-forward and must reproduce the authorised hash. A different machine, runtime or build that cannot reproduce it reads nothing and consumes nothing.
- If the evaluator fails after the intent, the result is lost. If only the database write fails, the good result is retried and the intent stays open; it is closed as lost only after twice the runtime limit plus ten minutes, measured on the database clock.
- Warehouse reads also write the existing `ResearchHoldoutAccess` row, so the ASCEND CLIs and the research loop see the holdout as spent.
- A holdout pass leaves the result research-only.

Residuals: a hypothesis deliberately filed under another family, an instrument under an unrelated name, and correlated instruments (EUR/USD and GBP/USD) are separate holdouts. `priorLooks` (every earlier read of an overlapping period on the instrument, any lineage, any interval) is shown at authorisation and stored with the intent so multiplicity stays visible. No multiplicity correction is applied to the holdout verdict, and a strategy's holdout test is only "net return above zero" (existing validator rule, unchanged here).

Consequence worth knowing: because the holdout is the last 20% of a dataset, appending a little data does not create a fresh holdout. After one read, a lineage on that instrument needs prospective evidence or a much longer history.

### Bounded execution

- `plan` is a dry run; `plan --preflight` also loads and checks the data. Nothing is written.
- Limits are declared and capped: trials (refused at declaration and again at reservation), runtime and memory per unit, concurrency, attempts.
- Each unit is evaluated in a child process at low priority: V8 heap limit, the supervisor's kill timer, the evaluator's own runtime limit (so an orphan stops if its supervisor dies), and sockets and `fetch` blocked in the evaluating thread before the job is read. The supervisor does all I/O first. Data is loaded from the warehouse (as-of bounded) or a file whose SHA-256 must match.
- Units are held under database leases. Every claim, completion, failure and cancellation runs under a row lock on the run's state, so the concurrency limit cannot be overshot and the run state is never computed from a half-updated view. A claim is fenced by its owner and attempt number; a dead executor's unit is reclaimed after the lease expires and the dead executor is refused every write. Cancellation closes pending units at once and running units at the next heartbeat, cannot be withdrawn, and does nothing to a finished run.
- Campaign transactions have explicit ceilings (60 s): the first demonstration run lost a claim to Prisma's 5 s default.
- The worker job is off unless `RESEARCH_CAMPAIGN_WORKER_ENABLED=true`. When on, each tick starts `campaign-cli work-next` as a separate low-priority process with a minimal environment, so research never runs on the trading event loop. No existing resource limit is changed.

Residual: lease expiry compares the application clock of the claiming host. Two hosts whose clocks differ by more than the 60 s lease could reclaim a live unit. Fencing keeps the data correct; an attempt is wasted.

### Evidence stages and the bridge to shadow

Six states, never merged: historical result → pending holdout → holdout evaluated → prospective observation → sufficient prospective evidence → paper-execution readiness. The last is never granted by this workflow, and `executable` is always false.

The bridge adds no scoring code. `register-model` stores the artefact that passed its holdout in the existing immutable model registry (identity derived from the holdout result hash); `observe` is an operator action that moves it to `SHADOW_CANDIDATE`; the existing shadow service (off unless `GENESIS_SHADOW_ENABLED=true`) scores it. Prospective evidence reports overlap, non-overlapping (effective) sample size, costs, block-bootstrap intervals, calibration and drift. The observation length is declared at registration (`--observe-signals`, 30 to 5,000 independent signals, no default) and stored in the immutable model row. The evidence is judged once, on the fixed sample that ends when that many independent signals have resolved; later rows cannot change the judgement. Looking every day and stopping the first time an interval clears zero would inflate the false-positive rate several-fold. It is "sufficient" only when, on that sample: at least 30 independent outcomes; the signals' own net return after costs has an interval above zero (beating "always enter" is not enough: a model can lose less than a losing baseline); the advantage over "always enter" has an interval above zero; calibration is within the monitor's limit; and no drift or integrity flag is raised.

Limits of the bridge, stated plainly:

1. **Rule-based strategies have no prospective scorer.** A strategy that passes its holdout stops at "holdout passed, research only".
2. **Only 24/7 markets on the default feature set.** The shadow service builds features on a 24/7 grid, so a gold or FX model (session calendar, no traded volume) is refused rather than scored on different features. Extending the shadow service to session calendars is the next piece of work.
3. **Model age.** A frozen artefact is as old as its holdout when observation starts, and the shadow service abstains on a model older than its staleness limit (30 days by default). Refitting would produce a model the holdout never tested. So the registrant must state the limit (1 to 730 days, no default); it is stored in the immutable model row. This is an operator decision and a real trade-off.
4. A synthetic campaign's model can only be observed on `SYNTHETIC:SYN…` instrument keys.

## Review outcome

Two independent reviews were run on the implementation: a statistical and persistence review, and the `quant-safety-reviewer`.

- **Safety review: CHANGES REQUESTED (small), since addressed.** It confirmed by reading and by 104 unit tests that no protected path is touched, that no order, intent, fill, ledger, strategy-instance, `EngineControl` or risk write exists, and that nothing can promote a model to a paper state. Its two requested changes are made: validation and resampling settings are bounded below by the defaults, and the Market Scanner survives missing research tables. Its lower notes (process priority and environment, tick ceiling, newest-first walked-forward check, minimum-sample guard on authorisation, no holdout-period drift in walk-forward results) are also made. It has not re-reviewed the fixes.
- **Statistical and persistence review: 8 high and 14 medium findings.** Fixed here: sufficiency reachable by a net-losing model; bars already walked forward re-declared as a holdout; another interval as a free second look; cost overrides lowering the bar; a good holdout result destroyed by a failed write; the walk-forward hash checked only after the read; order-dependent deflation; optional stopping; the heartbeat and run-state races; the concurrency overshoot; the stranded intent; the lost-without-intent close; CLIs outside the trial count.

Not fixed, and the operator should know:

1. **The deflated-Sharpe variance term is local to a unit.** The benchmark is the unit's own trial-Sharpe dispersion times the expected maximum of N. For ML 2.0 that dispersion comes from at most four correlated learners, so the programme count deflates ML results weakly; with fewer than two finite trial Sharpes it does not deflate at all. The reviewer proposes a variance floor of 1/(n−1). That changes the validator (`packages/backtest/src/research/metrics.ts`) and every verdict it has produced, so it is left for an explicit decision. It only ever tightens.
2. **No multiplicity correction on the holdout verdict**, and a strategy holdout passes on net return above zero. With the identity rules above this is tolerable; it is not strong.
3. **Correlated or aliased instruments are separate holdouts.**
4. **"Lost means never recompute" is deliberately strict.** The reviewer argues a logged recomputation of hash-pinned inputs is safe. The mission asked for the strict rule; the rehearsal and write-retry remove the common causes of loss.
5. `--prior-trials` can still override the programme count in the read-only CLIs, and the campaign CLI's operator identity is a self-declared string (the API route uses the authenticated admin).
6. Database triggers bind the application role only as long as it does not own the tables.
7. The integration tests' evaluator runs in-process, so the heartbeat, cancel-while-running and the real child process are exercised by the demonstration run, not by the suite.

## Alternatives rejected

- **Reuse `ResearchRun`/`ResearchTrial` for campaign results.** Their rows cannot express a reservation before the run, a phase, or an ML trial, and are written only after completion. They stay as the legacy registry and are still counted.
- **Record the holdout access with the result (existing pattern).** A crash between read and write leaves a seen holdout unrecorded.
- **Recompute a lost holdout result deterministically.** It would give the same number, but the rule "a consumed holdout is never read again" has no safe exceptions.
- **Run evaluation inside the worker process.** A study blocks the event loop for seconds to minutes.

## Consequences

- One migration, additive (eight new tables). Recovery: the tables can be dropped without affecting trading; do not delete rows from the ledgers.
- The programme count is now one function used by every research CLI.
- Honest costs: storing full trial detail per result (text column), and a strict holdout rule that will usually send a hypothesis to prospective observation rather than to a second historical look.
