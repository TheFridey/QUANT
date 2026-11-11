# ADR-0001: durable research campaigns, trial and holdout ledgers, and the bridge to shadow

Status: accepted for research use (10–11 Nov 2026). Scope: OPERATION EVIDENCE. Research only: nothing here creates orders, changes `EngineControl`, risk limits or strategy instances, or promotes anything. No protected path is changed.

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

The declaration has no field for a grid or an acceptance threshold. Grids come from the pinned strategy library and rules from the pinned validator, so a disappointing result cannot widen a search or lower a bar. Unknown fields are refused.

### Trial accounting

Programme count = ASCEND registry rows (`TRAIN` and `FULL_GRID` windows) + declared legacy trials + for each campaign unit its settled count, else its reservation.

| Unit event | Effect on the count | Why |
| --- | --- | --- |
| Scheduled, never started | 0 | Nothing was computed, so nothing was selected on. |
| Started | Full declared upper bound, committed under one advisory lock before the first trial | A reader must never see fewer trials than may already have run. Concurrent campaigns are serialised, so each sees the other. |
| Completed | Actual count (never above the bound), written with the result | The bound is replaced by the truth only when the truth is stored. |
| Failed, abandoned, cancelled after starting, crashed | Full bound, permanently | The trials may have run and been seen in logs or output. |
| Retried | Unchanged | The retry repeats the same deterministic trials; it adds no selection freedom and must not reset anything. |
| Intentional rerun | Counted again | Over-counting an identical rerun is the safe direction. |

Rationale: the deflated Sharpe ratio's expected maximum grows with the number of trials. Understating that number makes every later result look more significant than it is; overstating it only makes the bar higher. So every ambiguous case counts in full. A unit's `priorTrials` is frozen in its reservation, which keeps a retried result reproducible even if other campaigns ran in between.

The unit count includes `TEST` windows; the registry count does not. This is slightly conservative and deliberate.

`campaign-cli declare-legacy-trials` records trials that were run before the ledger existed. **It has not been run against production**: the roughly 3,000 unrecorded HORIZON CLI trials are still outside the count there until the operator declares them.

### Holdout accounting

- A campaign never reads a holdout. The walk-forward phase always withholds it (`holdoutPolicy` has one legal value).
- An operator authorises **one read for one frozen result** (`AUTHORIZED`: `operator:<identity>`, expiry at most 7 days, bound by hash to the walk-forward result and the period). ADMIN-only API route or CLI.
- The read is preceded by a committed `CONSUME_INTENT`. From that commit the period is spent, whatever follows. The database allows one intent and one close per unit.
- The intent is closed by `RESULT_RECORDED` or `RESULT_LOST`. A lost result (crash, timeout, mismatch) is **never recomputed**: the answer may have been seen. The unit's holdout result is `HOLDOUT_CONSUMED_RESULT_LOST` and the lineage needs bars after that period.
- Identity is wider than names: instrument normalised to letters and digits; lineage is the strategy family or the ML label horizon; periods match by time overlap. A renamed strategy, a re-imported or appended dataset, a new dataset key or a new campaign therefore meets the earlier access. Warehouse reads also write the existing `ResearchHoldoutAccess` row, so the ASCEND CLIs and the research loop see the holdout as spent.
- A holdout pass leaves the result research-only.

Residuals: a hypothesis deliberately filed under another family, or an instrument under an unrelated name, is not recognised. `priorLooks` (every earlier read of an overlapping period on the instrument, any lineage) is shown at authorisation and stored with the intent so multiplicity stays visible. No multiplicity correction is applied to the holdout verdict.

Consequence worth knowing: because the holdout is the last 20% of a dataset, appending a little data does not create a fresh holdout. After one read, a lineage on that instrument and interval needs prospective evidence or a much longer history.

### Bounded execution

- `plan` is a dry run; `plan --preflight` also loads and checks the data. Nothing is written.
- Limits are declared and capped: trials (refused at declaration and again at reservation), runtime and memory per unit, concurrency, attempts.
- Each unit is evaluated in a child process: V8 heap limit, kill timer, sockets and `fetch` blocked before the job is read. The supervisor does all I/O first. Data is loaded from the warehouse (as-of bounded) or a file whose SHA-256 must match.
- Units are held under database leases with compare-and-set on a version. A dead executor's unit is reclaimed after the lease expires; the dead executor is fenced out of every write. Cancellation closes pending units at once and running units at the next heartbeat, and cannot be withdrawn.
- The worker job is off unless `RESEARCH_CAMPAIGN_WORKER_ENABLED=true`. When on, each tick starts `campaign-cli work-next` as a separate process, so research never runs on the trading event loop. No existing resource limit is changed.

### Evidence stages and the bridge to shadow

Six states, never merged: historical result → pending holdout → holdout evaluated → prospective observation → sufficient prospective evidence → paper-execution readiness. The last is never granted by this workflow, and `executable` is always false.

The bridge adds no scoring code. `register-model` stores the artefact that passed its holdout in the existing immutable model registry (identity derived from the holdout result hash); `observe` is an operator action that moves it to `SHADOW_CANDIDATE`; the existing shadow service (off unless `GENESIS_SHADOW_ENABLED=true`) scores it. Prospective evidence reports overlap, non-overlapping (effective) sample size, costs, a block-bootstrap interval, calibration and drift, and is "sufficient" only at 30 independent outcomes, 10 independent signals, an interval above zero, calibration within the monitor's limit and no drift flag.

Limits of the bridge, stated plainly:

1. **Rule-based strategies have no prospective scorer.** A strategy that passes its holdout stops at "holdout passed, research only".
2. **Only 24/7 markets on the default feature set.** The shadow service builds features on a 24/7 grid, so a gold or FX model (session calendar, no traded volume) is refused rather than scored on different features. Extending the shadow service to session calendars is the next piece of work.
3. **Model age.** A frozen artefact is as old as its holdout when observation starts, and the shadow service abstains on a model older than its staleness limit (30 days by default). Refitting would produce a model the holdout never tested. So the registrant must state the limit (1 to 730 days, no default); it is stored in the immutable model row. This is an operator decision and a real trade-off.
4. A synthetic campaign's model can only be observed on `SYNTHETIC:SYN…` instrument keys.

## Alternatives rejected

- **Reuse `ResearchRun`/`ResearchTrial` for campaign results.** Their rows cannot express a reservation before the run, a phase, or an ML trial, and are written only after completion. They stay as the legacy registry and are still counted.
- **Record the holdout access with the result (existing pattern).** A crash between read and write leaves a seen holdout unrecorded.
- **Recompute a lost holdout result deterministically.** It would give the same number, but the rule "a consumed holdout is never read again" has no safe exceptions.
- **Run evaluation inside the worker process.** A study blocks the event loop for seconds to minutes.

## Consequences

- One migration, additive (eight new tables). Recovery: the tables can be dropped without affecting trading; do not delete rows from the ledgers.
- The programme count is now one function used by every research CLI.
- Honest costs: storing full trial detail per result (text column), and a strict holdout rule that will usually send a hypothesis to prospective observation rather than to a second historical look.
