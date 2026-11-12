# OPERATION INTEGRITY — finding ledger

**Audit baseline:** `main` at `6eaac8e`, a docs-only merge over production code `eba979f`.

- **Phase I** was merged as PRs #73–#77 and **deployed 12 Nov 2026 as `2cc6627`** ([`docs/horizon/LEDGER.md`](../horizon/LEDGER.md), checkpoint 8). `main` is now `33c6a4a`, docs only on top of that.
- **Phase II** is on branch **`integrity/phase-ii`** (off `33c6a4a`, pushed, **not merged, not deployed**). The Phase II brief assumed open PRs #73–#77; all five were already merged, so there is no stack to integrate. `integrity/phase-ii` is itself the release candidate.

PAPER only. Nothing here enables live money, changes `EXECUTION_MODE`, loosens risk limits, consumes production holdouts or deploys. No protected path was edited in Phase II.

**Classifications:** `FIXED` (implemented with tests, not yet independently release-qualified) · `VERIFIED` (FIXED, plus Linux CI and independent review) · `PARTIAL` · `BLOCKED` · `NOT_A_DEFECT` · `OPEN`. Implementation status and release status are kept apart; see [`RELEASE-READINESS.md`](RELEASE-READINESS.md).

## Findings

| ID | Sev | Phase I | Phase II state | Evidence | Commit / PR |
| --- | --- | --- | --- | --- | --- |
| F01 | HIGH | FIXED, deployed | **FIXED** (deployed in `2cc6627`); `quant-safety-reviewer` APPROVE WITH NOTES (Phase I); residuals tracked under F11. Not re-verified in Phase II beyond the full DB integration suite (`lifecycle-fence` included, all pass). | Phase I record below; Phase II DB suite 38/38 files | #77 |
| F02 | HIGH | FIXED, deployed | **FIXED**. Real-Redis integration is still unverified locally (no Redis or Docker on this host); CI e2e runs against real Redis. | Phase I record | #73 |
| F03 | HIGH | PARTIAL | **FIXED**. Campaigns are the sole evidence path. Legacy CLIs open a study in the trial ledger before computing and close it before printing; idempotent per study key; crash, outage and concurrency are visible. Intelligence dry runs previously counted nothing. | [`F03-F06-RESEARCH-INTEGRITY.md`](F03-F06-RESEARCH-INTEGRITY.md); real-PG 10/10, unit 7/7, mutation killed | `aceb735` |
| F03-H | — | not started | **BLOCKED** (operator input). Historical "3,000": it is a cumulative count including about 2,454 registry rows, so roughly 550 trials are unrecorded. Questionnaire and command prepared; nothing declared. | same doc | — |
| F04 | HIGH | OPEN | **FIXED**. DSR protocol `dsr-2.0.0`: variance = max(cross-trial, estimator null variance), full programme N, explicit reason codes, NaN-safe gates, no normal-moment defaults in ML. Older-protocol results are kept and need a rerun before shadow registration. Independent statistical review: (a) and (b) APPROVED WITH CONDITIONS (all met), (c) effective-N REJECTED (not used). | [`F04-STATISTICAL-REVIEW.md`](F04-STATISTICAL-REVIEW.md); 24 + 4 tests, 3 mutations killed | `bab301b` |
| F05 | HIGH | FIXED, deployed | **FIXED**. Disposable restore drill re-run in Phase II: `ok: true` on 75 tables, 26 tables probed, scratch database dropped. A production-dump drill needs operator access. | [`F12-OPERATIONAL-RECONCILIATION.md`](F12-OPERATIONAL-RECONCILIATION.md) | #74 |
| F06 | MED | PARTIAL | **FIXED**. The legacy `holdoutAvailable` identity is retired: it never grants and never queries. The flag floor now applies to the frozen study prior. | F03 doc | `aceb735` |
| F07 | MED | FIXED, deployed | **FIXED**. Its real-PG tests are part of the 38-file DB suite, all pass. Historical double pins are not rewritten. | — | #76 |
| F08 | MED | FIXED, deployed | **FIXED**. The production `instrumentKind` compatibility query is still to be run by the operator (deployment plan). | — | #76 |
| F09 | MED | OPEN | **FIXED**. Complete cohort read via keyset pages over `(decisionTime, id)` in one REPEATABLE READ snapshot. The row bound is explicit and a truncated cohort is never judged. A sample is judged only when none of its outcomes is pending. | [`F09-COHORT-VERIFICATION.md`](F09-COHORT-VERIFICATION.md); 14 unit + 3 real-PG tests, 2 mutations killed | `56612f6` |
| F10 | MED | OPEN (spec missing) | **FIXED**. The spec was recovered verbatim from the Phase I transcript. Stdin-pipe liveness removes descendants. Heap and RSS limits are now named accurately; a sampled RSS watchdog and cgroup detection are added, and the cgroup can be required. FILE loads are bounded. A systemd isolation recipe is documented. | [`F10-INVESTIGATION.md`](F10-INVESTIGATION.md); 13 real-process tests | `f41438f`, `fa8b084` |
| F10-OS | — | — | **BLOCKED** (operator). OS-level isolation on the VPS is neither applied nor inspected. | F10 doc | — |
| F11 | MED | OPEN | **FIXED** (analytics). Trade statistics count economic exits (the root exit order of a remainder chain), not fill chunks. Totals, fees and cash are unchanged. | [`F11-ECONOMIC-TRADE-IDENTITY.md`](F11-ECONOMIC-TRADE-IDENTITY.md); 8 tests | `e6daa04` |
| F11-X | — | — | **BLOCKED** (protected-path approval). Chained-exit liquidity realism, the SANDBOX fill lock and `requestedQty`. Approval package prepared; no protected file touched. | F11 doc | — |
| F12 | LOW | PARTIAL | **FIXED**. Phase I's drill probe made every production drill fail on `CyclePlan` (an UPDATE-only trigger was probed with a DELETE); fixed and re-drilled green. The "3,000 unrecorded trials" claims were corrected in ADR-0001, HANDOVER and LEDGER. `docs/STATUS.md` now separates production, `main` and branch. | [`F12-OPERATIONAL-RECONCILIATION.md`](F12-OPERATIONAL-RECONCILIATION.md) | `c767d50`, docs commit |

Independent reviews: statistical (F04), `quant-safety-reviewer` (REJECT; H1, M1 and M2 fixed in `a6fa778`, then APPROVE WITH NOTES) and `regression-reviewer` (no blocking findings). Details in `RELEASE-READINESS.md`. None of the Phase II findings is `VERIFIED` yet. Linux CI on the PR, and the browser e2e within it, have not run; see [`ACCEPTANCE-MATRIX.md`](ACCEPTANCE-MATRIX.md).

## Phase I record (unchanged, abbreviated)

Phase I evidence for F01, F02, F05, F07 and F08 (reproductions, tests, reviews) is in git history at `f64e62d:docs/integrity/STATUS.md`, plus the PR descriptions of #73–#77.
