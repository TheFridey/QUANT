# Release readiness — OPERATION INTEGRITY Phase II

## Classification: **READY WITH EXPLICIT EXTERNAL BLOCKERS**

The engineering work is complete to the extent possible without operator action. Linux CI on [PR #79](https://github.com/TheFridey/QUANT/pull/79) has not yet reported. A CI failure there downgrades this classification to NOT READY. This is not `READY FOR OPERATOR APPROVAL`, because the qualifying CI run, real-Redis verification and the browser e2e are still missing.

## Integration report

- **No stack to integrate.** The brief expected PRs #73–#77 still open. All five were already merged into `main` and deployed (`2cc6627`, 12 Nov 2026).
- **Release candidate:** Phase II is one linear branch, `integrity/phase-ii`, off `33c6a4a`. It is itself the candidate, so no separate `phase-ii-release-candidate` branch was created.
- **Conflicts:** none. The branch merges cleanly into `main`; GitHub reports MERGEABLE.

| Commit | Content |
| --- | --- |
| `aceb735` | F03/F06: study accounting, legacy holdout retired |
| `56612f6` | F09: keyset cohort |
| `bab301b` | F04: DSR `dsr-2.0.0` |
| `e6daa04` | F11: economic-trade analytics |
| `f41438f` | F10: process guarantees |
| `fa8b084` | F10: deterministic test, tick abort signal |
| `c767d50` | F12: restore-drill CyclePlan probe |
| `5fd6142` | F12: docs reconciliation |
| `a6fa778` | safety-review fixes H1, M1, M2, L2, L5 |
| (this commit) | readiness |

**Interactions checked:**

| Interaction | Result |
| --- | --- |
| DSR protocol × campaign versions × shadow registration | `dsrProtocol` in `campaignVersions()`; `REVALIDATION_REQUIRED` for older results; `unitSpecHash` is write-only, so in-flight runs are not broken (regression review) |
| Trial accounting × campaign reservations | same advisory lock; study rows are `LEGACY_DECLARED`, already counted by `programmeTrials` |
| Cohort × statistical evidence | the judged sample is unchanged in definition; it is only read completely, with stricter "reached" |
| Economic trades × lifecycle fencing | grouping by root exit order; PCR-1 stamps untouched |
| Process guards × worker | the trading worker runs no research code; the guards are only active with an explicit env flag |

## Independent reviews

| Review | Scope | Verdict | Disposition |
| --- | --- | --- | --- |
| Statistical (independent agent, read-only, numerical checks) | F04 methodology | (a) insufficiency APPROVED WITH CONDITIONS; (b) variance floor APPROVED WITH CONDITIONS; (c) effective-N REJECTED | all conditions implemented; effective-N not used. See `F04-STATISTICAL-REVIEW.md`. |
| `quant-safety-reviewer` (whole diff, threat model of brief §14) | all Phase II code | **REJECT until H1 fixed, then APPROVE WITH NOTES** | see the findings below |
| `regression-reviewer` (whole diff) | contracts, consumers, spawners | no blocking regressions | see the notes below |

**Safety-review findings:**

- **H1 HIGH, fixed in `a6fa778`.** Stdin liveness kept a finished CLI alive, so every successful tick would hang until the ceiling SIGKILL. A regression test runs a real child; the mutation that reverts the fix is killed by it.
- **M1 MEDIUM, fixed.** A reused study key under unversioned code could re-disclose results with no new trials. The key now binds to a clean commit or is unique, and a mismatched re-close is refused.
- **M2 MEDIUM, fixed.** A frozen prior could deflate less than the live count. A retry, and each research-cli strategy, now use at least the live count.
- **L2 fixed.** Spoofed study prefixes are refused.
- **L5 fixed.** Shutdown aborts the running tick.
- **L1 and L3** are documented behaviour.
- **L4 is not an issue.** Only `VALIDATED_CANDIDATE`/`CANDIDATE` pass; both relabelled outcomes fail.

**Regression-review notes:**

- **View latency.** `campaign view` latency now scales with cohort size: sequential REPEATABLE READ reads, 120 s timeout per model. This is a residual risk, listed below.
- **Additive API fields.** `cohort`, `pendingOutcomesInSample` and `economicTrades` are new fields; no consumer breaks.
- **Shadow registration.** CANDIDATE units validated before `dsr-2.0.0` now need a rerun before shadow registration. This is an intended behaviour change, and the operator must be told.

A post-fix re-review by the safety agent was not run. The fixes are covered by targeted tests and by the full suites below.

## Verification at branch head (`a6fa778`)

| Check | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| Unit suite | 1,359 passed, 34 skipped, 0 failed (with LF `scripts/*.mjs`; on CRLF the two restore-drill files fail to import, environmental) |
| DB integration (38 files, fresh database, PostgreSQL 18.3) | 216 passed, 0 failed |
| Real restore drill | `ok: true` (before the F12 fix: `ok: false`) |
| Linux CI, PostgreSQL 16, Redis, build, browser-e2e | **pending on PR #79** |

## External blockers (exact)

| Blocker | Why it matters | Done already | Operator action | Release impact |
| --- | --- | --- | --- | --- |
| CI on PR #79 | the only Linux, PostgreSQL 16, real-Redis, build and e2e run; it also proves the F10 SIGKILL tests on Linux | PR opened as a draft | read the result. Any red check blocks. | blocks qualification |
| Merge approval | repository policy | — | review and approve PR #79 | blocks deploy |
| Production read-only checks | F08 kinds, migration state, dsr-1 models, registry count | queries written (`DEPLOYMENT-PLAN.md` §1) | run them on the VPS | blocks deploy |
| Legacy trial declaration | the production programme count understates by about 550 trials | provenance traced, questionnaire written | answer the questionnaire; run `declare-legacy-trials` | does not block the deploy; DSRs stay slightly optimistic until done |
| F11 execution realism | paper exits on thin pools stay optimistic | approval package with scope and tests | approve or decline the protected-path increment | does not block this release |
| VPS research isolation | the hard total-memory bound needs a cgroup | systemd recipe; `RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION` | apply the recipe, or accept a heap limit plus the soft RSS watchdog | does not block while `RESEARCH_CAMPAIGN_WORKER_ENABLED` is off |
| Production restore drill | release evidence | the drill script is fixed | run it on the pre-deploy dump | gate in the deployment plan |

## Residual risks (not zero)

- **DSR is conservative, not exact.** The full N with the floor overstates the selection penalty for correlated trials and may reject genuine edges. Effective-N is not estimated.
- **Exploratory studies are counted only at close.** A crash before the close discloses nothing and counts 0, by design. A partial research-cli run plus its retry overstates, which is the safe direction.
- **The RSS watchdog is soft**, and `campaign view` latency grows with cohort size.
- **Paper exit realism for chained remainders** is optimistic (F11-X).
- **Local verification was not on the target stack.** It used PostgreSQL 18.3, no Redis, and Windows, where libuv job objects mask the F10 SIGKILL behaviour.
- **Production state is not re-verified this session.** No VPS access was used.

## Recommended merge order and gates

1. CI on PR #79 is fully green.
2. Operator review, then mark the PR ready and merge. One PR; no other dependencies.
3. Run the read-only production checks.
4. Deploy per `DEPLOYMENT-PLAN.md`.
5. Run the post-deploy safeguard verification.
6. As separate work: the legacy trial declaration, the F11 protected increment and the VPS research isolation.
