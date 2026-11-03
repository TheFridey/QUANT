# ASCEND-08: bounded autonomous research loop

Status: **implemented, verified locally (unit + integration); not deployed; off by default.** Code commit `6dd6686`. Branch `apex/ascend-08-research-loop`, based on `bff5000` (PR #44 head, merged to `main` as `4331e99`). No protected path was edited.

## What it is

A worker job that, once an operator turns it on, takes research experiments through
`OBSERVE → HYPOTHESISE → FORGE → TEST → CHALLENGE → VALIDATE → PAPER → REVIEW`, one state per experiment per tick, with durable state, leases, persistent budgets and approval enforcement. It is research only. It never deploys code, promotes a strategy, writes `EngineControl`, `StrategyPromotion`, `PromotionApproval` or risk configuration, approves its own report, or writes an approval.

| Piece | Location |
| --- | --- |
| Transition table (pure) | `packages/evolution/src/research-loop-states.ts` |
| Tick, intake, claims, stages, operator operations | `packages/evolution/src/research-loop.ts` (`runResearchLoopTick(prisma, deps, now)`) |
| Schema + migration | `packages/shared/prisma/schema.prisma`; `migrations/20261102100000_ascend08_research_loop` |
| Worker job | `apps/worker/src/research-loop.ts` (queue `odin.research-loop`, repeat every `RESEARCH_LOOP_TICK_MS`, default 300 000, minimum 60 000) |
| ADMIN API | `apps/api/src/research-loop.controller.ts` |
| Tests | `research-loop-states.test.ts`, `research-loop.integration.test.ts`, `apps/api/src/research-loop.controller.test.ts`, `apps/worker/src/research-loop.test.ts` |

## Durable state (additive migration, four new tables)

- `ResearchLoopControl` (`id = primary`): `enabled` (**default false; a missing row is off**), `maxExperimentsPerDay` (2), `maxConcurrentExperiments` (2), `maxAttemptsPerExperiment` (3), `tickRuntimeMs` (120 000), `leaseMs` (600 000). A CHECK constraint bounds every limit (0–50, 1–10, 1–10, 70 s–10 min, 140 s–1 h) and requires `leaseMs ≥ 2 × tickRuntimeMs`; the API validates the same bounds. The 70 s floor leaves a model stage (≤ 60 s timeout plus margin) room to run; the 2× rule means a lease cannot lapse while its own tick is working.
- `ResearchExperiment`: `hypothesisId`, `state`, `blockedState`, `attempts`, `lastError`, `leaseOwner`, `leaseExpiresAt`, `version`, `context` (stage outputs: restated hypothesis, forged source and hashes, measured metrics, report id), `createdBy`, timestamps. CHECKs: known state; `blockedState ∈ {FORGE, TEST, PAPER}` exactly when `BLOCKED_APPROVAL`. Trigger: rows are never deleted, terminal states never change, `REVIEW` may only become `ABANDONED`.
- `ResearchExperimentEvent`: append-only log (`CREATED`, `TRANSITION`, `ATTEMPT_FAILED`, `LEASE_RECLAIMED`) with `evidence` and `evidenceHash` (SHA-256 of key-sorted evidence, `hashEvidence`).
- `ResearchApproval`: append-only operator approvals (`experimentId`, `action ∈ {forge_code, run_backtest, promote_paper}` by CHECK, `approvedBy`, `approvedAt`, `expiresAt > approvedAt` by CHECK, `subjectHash` 64-hex by CHECK). Valid only while `approvedAt ≤ now < expiresAt`, judged at gate time (a fresh clock read, not the tick start), and only for the subject it names (below).

UPDATE, DELETE and TRUNCATE (statement trigger, so `TRUNCATE … CASCADE` too) on the two log tables raise `… is append-only (ASCEND-08)`; `ResearchExperiment` also refuses TRUNCATE and DELETE, and a terminal row (REJECTED, FAILED, ABANDONED) refuses every UPDATE, so no column of a finished experiment can be rewritten. Tests therefore never wipe these tables: they abandon leftover non-terminal experiments and run day-cap checks on a fresh UTC day.

## State table

A state names the stage whose work runs next. Anything not listed is refused (`canTransitionExperiment`), and the database trigger independently refuses leaving a terminal state.

| From | Allowed to | Work done in this state | Gate |
| --- | --- | --- | --- |
| OBSERVE | HYPOTHESISE, FAILED, ABANDONED | Hypothesis exists; count of observations received at or before `now` | — |
| HYPOTHESISE | FORGE, FAILED, ABANDONED | ORACLE tier restates a falsifiable hypothesis (model) | — |
| FORGE | TEST, REJECTED, FAILED, ABANDONED, BLOCKED_APPROVAL | FORGE tier writes source (model); `forgeStrategyModule` lint, compile, isolated run | `forge_code` |
| TEST | CHALLENGE, REJECTED, FAILED, ABANDONED, BLOCKED_APPROVAL | Recompile and check artifact hash; isolated run on observations ≤ `now`; `simulateResearchPath`, `summariseStatistics`, `scoreWindow` on the untouched split | `run_backtest` |
| CHALLENGE | VALIDATE, REJECTED, FAILED, ABANDONED | `runChallengeReview`; if it passes, the CHALLENGE tier (model) on a **separated** endpoint (`assertSeparatedReviewer`, and the answering endpoint must differ from the forge endpoint) | — |
| VALIDATE | PAPER, REJECTED, FAILED, ABANDONED | `classifyResearchOutcomes`, `finaliseEvaluation`, `buildExperimentReport`; persists an `ExperimentReport` with `approvalStatus = PENDING` | — |
| PAPER | REVIEW, FAILED, ABANDONED, BLOCKED_APPROVAL | Writes a `LifecycleAudit` `VALIDATED → PAPER_CANDIDATE` label only | `promote_paper` |
| REVIEW | ABANDONED | Nothing; never claimed. The operator decides everything after this | — |
| BLOCKED_APPROVAL | the blocked stage only, FAILED, ABANDONED | Re-checks the gate; returns to `blockedState` when it passes | as blocked stage |
| REJECTED, FAILED, ABANDONED | — | terminal | — |

REJECTED means the candidate is bad (static lint, compile or contract failure, no observations, challenge or validation failed). FAILED means the work could not be done (retry ceiling, missing context, reviewer not separated).

## Tick (`runResearchLoopTick`)

1. Returns `DISABLED` unless `ResearchLoopControl.enabled`; returns `AUTONOMY_INSUFFICIENT` unless the parsed autonomy level is 2 or 3 (level 4 is disabled).
2. Intake (when `queue_experiment` is allowed): inside one transaction holding `pg_advisory_xact_lock(8080801)`, creates experiments for OPEN hypotheses that never had one, up to `min(maxExperimentsPerDay − created today (UTC), maxConcurrentExperiments − active)`. The ADMIN enqueue endpoint goes through the same function and caps.
3. Claim: reads claimable rows whose lease is free or expired, then claims each with `UPDATE … WHERE id AND version = read AND lease free`, bumping `version`. Expired leases are reclaimed and logged `LEASE_RECLAIMED`.
4. For each claimed experiment (stopping early, and releasing leases, if the kill switch goes off or the tick runtime limit is reached): runs that state's work and commits **one** transition in a transaction whose `UPDATE` matches `leaseOwner = me AND version = claimed version`; the event row and any side rows (report, lifecycle labels) commit with it. If the lease was lost (reclaimed after expiry) nothing is committed (`leaseLost`).
5. Gated stages call `assertActionAllowed`. Denied: nothing runs, the lease is released with `DENIED: …`. `requiresApproval` without a valid `ResearchApproval`: the stage is **not** executed and the experiment moves to `BLOCKED_APPROVAL`. Level 2: forge, backtest and paper label all need approval. Level 3: forge and backtest do not; the paper label always does.
   **Approvals are bound to their subject** (review M2). An approval is accepted only while the experiment is `BLOCKED_APPROVAL` and only for the action of its `blockedState` (otherwise 409 `APPROVAL_NOT_REQUESTED` / `ACTION_MISMATCH`). The operator must send the `subjectHash` shown on the blocked experiment (`GET /experiments` → `approvalRequest`), and the gate requires that hash to equal the current subject: `forge_code` = hash of the restated hypothesis; `run_backtest` = hash of the forged `sourceHash` + `artifactHash`; `promote_paper` = hash of the report id + `contentHash` (`approvalSubject`). An early approval, or one for a different artifact or report, never unblocks anything.
   **Failures inside a tick are contained** (review M1). Each experiment's advance runs in `advanceSafely`: an unexpected error (database error, transaction timeout, failing side effect) is recorded as `ATTEMPT_FAILED` (`TICK_ERROR: …`) in a fresh compare-and-set transaction that applies the retry ceiling (→ `FAILED`), and the tick continues. A `finally` block releases every claimed lease not yet worked, even if the tick itself throws. Before stage work starts, the remaining lease must cover the rest of the tick plus 10 s (`LEASE_TOO_SHORT` otherwise; defence in depth, unreachable while the 2× CHECK holds).
6. Model steps build a router per call seeded with `MemoryBudgetStore(sum of ModelUsageLog.costUsdEst since UTC midnight)` and an `onUsage` hook that writes each call to `ModelUsageLog` before the next. No call is made when the budget is spent (`BUDGET_EXHAUSTED`: lease released, attempts unchanged) or when no endpoint for the tier is configured. Router mode is always `live`: with no key the step is `MODEL_UNAVAILABLE`, an attempt is counted, and at the ceiling the experiment is `FAILED` with the reason. No mock or fixture provider is reachable from production code (tests inject explicit FIXTURE providers).
7. Retry ceiling: attempts accumulate over the whole experiment; reaching `maxAttemptsPerExperiment` moves it to `FAILED` with `RETRY_CEILING: n/max attempts; last error: …`.
8. Multiple-testing accounting: `researchProgrammeCounts` counts all experiments and those measured (`TEST → CHALLENGE` events, failures included). VALIDATE records the counts in the event evidence, the experiment context and the report's `uncertainty` (`PROGRAMME_EXPERIMENTS=…`, `PROGRAMME_EXPERIMENTS_TESTED=…`); earlier reports for the same hypothesis over the test window count as selection (`tunedOnEvaluationSample`), as in `runResearchPipeline`.

## ADMIN API (`/api/evolution/research-loop`, every route `AdminGuard`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Control (kill switch, limits), autonomy level, whether the loop would run, UTC-day budget (cap, spent, remaining), experiments created today, programme counts |
| POST | `/control` | Toggle the kill switch and set limits (bounded) |
| GET | `/experiments` | List experiments |
| POST | `/experiments` | Queue an experiment for a hypothesis (daily and concurrency caps apply; 409 when refused) |
| GET | `/experiments/:id/events` | Transition log and approvals |
| POST | `/experiments/:id/approvals` | Approve the action a `BLOCKED_APPROVAL` experiment is waiting for, naming its `subjectHash` (`ttlMinutes` 1–10 080, default 1 440); 409 when not requested, wrong action or wrong subject |
| POST | `/experiments/:id/abandon` | Operator abandons a non-terminal experiment (refused while a live lease is held) |

## Review fixes (draft PR #47, review APPROVE WITH NOTES)

Branch `pr/ascend-08`, code commit `a6b7bd5`. M1 (contained tick failures), M2 (subject-bound approvals), L1 (lease ≥ 2 × tick, lease check before stage work), L2 (approval validity at gate time), L3 (tick ≥ 70 s), L4 (terminal rows fully frozen; TRUNCATE refused). The migration (not in production) was edited in place; on `odin_test_a08` its objects were dropped and the migration re-applied (`pnpm db:deploy`). `schema.prisma` was edited by hand (no `prisma format`); `prisma migrate diff` from the database to the schema shows nothing for the four ASCEND-08 tables.

| Check | Result |
| --- | --- |
| `pnpm test` | **163 files passed, 4 skipped; 916 tests passed, 25 skipped, 0 failed** |
| `research-loop.integration.test.ts` | 19 passed (run twice in a row: repeatable without wiping append-only tables) |
| `pnpm typecheck`, `pnpm exec eslint .` | exit 0 |

New tests: early approval refused (also 409 at the controller), expired / future / wrong-action / wrong-subject approvals refused, approval expiring mid-tick refused, injected commit failure counts an attempt and reaches FAILED with no lease left, tick that throws releases all leases, kill switch off mid-tick, CHALLENGE PASS with separated endpoints and VALIDATE persisting a `PENDING` report, non-separated reviewer → FAILED, limit bounds, TRUNCATE and terminal-row freeze.

| Mutant | Change | Result |
| --- | --- | --- |
| M1 | `advanceSafely` rethrows instead of recording the attempt | **killed** (commit-failure test) |
| M1b | `finally` releases no leases | **killed** (2 tests: tick that throws; kill switch mid-tick) |
| M2 | gate ignores `subjectHash` | **killed** (other-subject approval unblocked FORGE) |
| M2b | approvals accepted without a pending request | **killed** (early approval accepted) |
| L2 | gate judges validity at tick start | **killed** (3 tests incl. approval expiring mid-tick) |

## Evidence (first implementation, local Postgres 16 `odin_test_a08`, Redis 7)

Environment for every command: `DATABASE_URL=DATABASE_URL_TEST=postgresql://odin:odin@127.0.0.1:5432/odin_test_a08`.

| Check | Command | Result |
| --- | --- | --- |
| Migration | `pnpm db:deploy` | `20261102100000_ascend08_research_loop` applied |
| New tests | `pnpm vitest run packages/evolution/src/research-loop-states.test.ts packages/evolution/src/research-loop.integration.test.ts` | 8 + 12 passed |
| Whole suite | `pnpm test` at code commit `6dd6686` | **163 files passed, 4 skipped; 908 tests passed, 25 skipped, 0 failed** (skips: sandbox tests needing bubblewrap) |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| App build | `pnpm --filter @odin/worker --filter @odin/api build` | ok |
| Worker boot smoke | worker `dist` with deterministic feed, isolated Redis db 9, `RESEARCH_LOOP_TICK_MS=60000`, 20 s | logged `research loop tick scheduled (runs only when the kill switch is on)` and `odin worker ready`; repeatable job keys `bull:odin.research-loop:*` present |

Integration tests (`research-loop.integration.test.ts`, serial, `pg_advisory_lock(641099)`):

1. kill switch missing / off, and autonomy 1 and 4 ⇒ no experiments, no model call, no usage row;
2. approval enforcement at level 2: FORGE ⇒ BLOCKED_APPROVAL with the forge never called; an expired, a future-dated and a wrong-action approval are refused; a valid one unblocks (one state), the next tick forges, and the transition evidence carries the approval id; TEST then blocks on `run_backtest`;
3. level 3: no approval for forge/backtest; TEST measures through the real simulation (HOLD-only candidate: return `null`, n = 0, nothing invented); CHALLENGE rejects it without a model call;
4. daily budget spent in `ModelUsageLog` ⇒ zero provider calls, attempts unchanged;
5. daily cap and concurrency cap (tick intake and ADMIN enqueue);
6. retry ceiling with no API key ⇒ `MODEL_UNAVAILABLE` attempts, then `FAILED` with `RETRY_CEILING: 2/2 …`, and no usage charged;
7. two concurrent ticks on separate connections, held at a barrier after claiming ⇒ disjoint claims, every experiment advanced exactly once;
8. a tick cannot claim an experiment another live tick holds;
9. a tick whose lease expired and was reclaimed cannot commit its stale result (`leaseLost`, one transition);
10. expired-lease recovery after a simulated crash, `LEASE_RECLAIMED` logged;
11. SHA-256 of every row of `EngineControl`, `StrategyPromotion`, `PromotionApproval`, `EngineConfigRevision`, `StrategyInstance`, `StrategyAllocation`, `RiskReservation`, `AccountSafetyState`, the autonomy safety flags and `DEFAULT_STRATEGY` identical before and after ticks that include an approved PAPER step (which writes only a `PAPER_CANDIDATE` lifecycle label and moves to REVIEW, never claimed again);
12. append-only triggers reject UPDATE and DELETE; experiments cannot be deleted; terminal states are frozen; unknown approval actions and out-of-bounds limits are refused by CHECK constraints.

### Mutation checks (each run against `research-loop.integration.test.ts`, then the file restored byte-for-byte, `cmp` clean)

| Mutant | Change | Result |
| --- | --- | --- |
| M1 approval bypass | `gateAction`: proceed even when `requiresApproval` | **killed**: 2 tests fail (approval test; PAPER reached REVIEW without approval) |
| M2 expired approval accepted | `findValidApproval`: drop `expiresAt > now` | **killed**: approval test fails (expired approval unblocked FORGE) |
| M3 lease ignored on claim | `claimResearchExperiments`: drop the lease-free predicate | **killed**: 3 tests fail (concurrent claims 8 ≠ 6, live-lease steal, early reclaim) |
| M4 commit without compare-and-set | `commitAdvance`: `WHERE id` only | **killed**: stale-lease commit test fails |

## Known limitations

- **Budget race across processes**: each model call re-reads the UTC-day sum, but two ticks (or a tick and an API pipeline run) calling at the same moment can each spend one call past the cap. Same class as the accepted residual M-2. The calendar-day window also allows about 2× the cap across midnight.
- **Approvals are reusable until expiry for the same subject** (a retried forge of the same restated hypothesis within the window reuses it). They are not single-use, because the table is append-only.
- **L5, budget reservation is estimated**: the cap check uses the router's cost estimate of each call (prompt and completion tokens × configured per-1k prices), not provider-billed cost, and no amount is reserved before a call; one call can therefore overshoot the remaining budget by its own cost.
- **L6, strategy identity and lifecycle labels**: the forged strategy id is `strat_<slug(title)>` with version `0.1.0`, so two experiments of hypotheses with the same title share a strategy id/version (and forge workspace path), and their `LifecycleAudit` rows interleave under one `strategyId`. `writeLifecycle` checks each step against the lifecycle table but states its own `from` (it does not read the strategy's latest lifecycle row), so the labels are per-experiment evidence (each carries `experimentId`), not an authoritative strategy lifecycle. Neither affects trading: promotion has its own gates.
- **Dataset**: TEST uses the most recent 400 persisted `MarketObservation` rows at or before the tick (all pairs, as `runResearchPipeline` does); it does not yet use the historical warehouse or select by instrument. Results on that data are not evidence of a strategy edge.
- **No bubblewrap locally**: the forge/TEST isolated run is exercised here through test seams (`deps.forge`, `deps.execute`); the real runner path is covered by existing sandbox tests in CI only. Without isolation the stage fails honestly (`FORGE_ISOLATION_DISABLED` / `SANDBOX_ISOLATION_DISABLED`, then the retry ceiling).
- **Live model calls were not exercised** (no keys in this session); model steps were tested with explicit FIXTURE providers and with no keys (UNAVAILABLE).
- Kill-switch changes record `updatedBy`/`updatedAt` only; there is no separate audit table for control changes.
- `REVIEW` has no operator "accept" action yet; the operator uses the existing promotion flow (human, separately gated) or abandons.
- The independent `quant-safety-reviewer` agent was not available in this session (no agent tool); no protected path changed, so the high-risk review rule was not triggered, but an independent review is still recommended before enabling the loop in production.
- The smoke boot left BullMQ keys for `odin.research-loop` in local Redis db 9 (no worker running).
