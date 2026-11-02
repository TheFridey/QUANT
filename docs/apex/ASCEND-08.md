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

- `ResearchLoopControl` (`id = primary`): `enabled` (**default false; a missing row is off**), `maxExperimentsPerDay` (2), `maxConcurrentExperiments` (2), `maxAttemptsPerExperiment` (3), `tickRuntimeMs` (120 000), `leaseMs` (600 000). A CHECK constraint bounds every limit (0–50, 1–10, 1–10, 5 s–10 min, 10 s–1 h) and requires `leaseMs > tickRuntimeMs`; the API validates the same bounds.
- `ResearchExperiment`: `hypothesisId`, `state`, `blockedState`, `attempts`, `lastError`, `leaseOwner`, `leaseExpiresAt`, `version`, `context` (stage outputs: restated hypothesis, forged source and hashes, measured metrics, report id), `createdBy`, timestamps. CHECKs: known state; `blockedState ∈ {FORGE, TEST, PAPER}` exactly when `BLOCKED_APPROVAL`. Trigger: rows are never deleted, terminal states never change, `REVIEW` may only become `ABANDONED`.
- `ResearchExperimentEvent`: append-only log (`CREATED`, `TRANSITION`, `ATTEMPT_FAILED`, `LEASE_RECLAIMED`) with `evidence` and `evidenceHash` (SHA-256 of key-sorted evidence, `hashEvidence`).
- `ResearchApproval`: append-only operator approvals (`experimentId`, `action ∈ {forge_code, run_backtest, promote_paper}` by CHECK, `approvedBy`, `approvedAt`, `expiresAt > approvedAt` by CHECK). Valid only while `approvedAt ≤ now < expiresAt`.

UPDATE and DELETE on the two log tables raise `… is append-only (ASCEND-08)`.

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
| POST | `/experiments/:id/approvals` | Approve `forge_code`, `run_backtest` or `promote_paper` for one experiment (`ttlMinutes` 1–10 080, default 1 440) |
| POST | `/experiments/:id/abandon` | Operator abandons a non-terminal experiment (refused while a live lease is held) |

## Evidence (this session, local Postgres 16 `odin_test_a08`, Redis 7)

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
- **Approvals are per experiment and action, reusable until expiry** (a retried forge within the window reuses it). They are not single-use, because the table is append-only.
- **Dataset**: TEST uses the most recent 400 persisted `MarketObservation` rows at or before the tick (all pairs, as `runResearchPipeline` does); it does not yet use the historical warehouse or select by instrument. Results on that data are not evidence of a strategy edge.
- **No bubblewrap locally**: the forge/TEST isolated run is exercised here through test seams (`deps.forge`, `deps.execute`); the real runner path is covered by existing sandbox tests in CI only. Without isolation the stage fails honestly (`FORGE_ISOLATION_DISABLED` / `SANDBOX_ISOLATION_DISABLED`, then the retry ceiling).
- **Live model calls were not exercised** (no keys in this session); model steps were tested with explicit FIXTURE providers and with no keys (UNAVAILABLE).
- Kill-switch changes record `updatedBy`/`updatedAt` only; there is no separate audit table for control changes.
- `REVIEW` has no operator "accept" action yet; the operator uses the existing promotion flow (human, separately gated) or abandons.
- The independent `quant-safety-reviewer` agent was not available in this session (no agent tool); no protected path changed, so the high-risk review rule was not triggered, but an independent review is still recommended before enabling the loop in production.
- The smoke boot left BullMQ keys for `odin.research-loop` in local Redis db 9 (no worker running).
