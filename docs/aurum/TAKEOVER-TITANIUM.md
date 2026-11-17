# TITANIUM takeover evidence — 17 November 2026

Checkpoint is IN PROGRESS. No production inspection, deployment, activation, account creation, policy approval, trial declaration or protected edit is authorised by this takeover.

## Starting baseline (VERIFIED_REPOSITORY)

Root checkout clean, including untracked files, on `aurum/04-product` at `a86f4b7a1693a6dfa003f6f2a178f1ddd89d8590`.

| Ref | Exact head | Ancestry |
| --- | --- | --- |
| main / origin/main | dc24992209b6790fa978ded9d61c0a61bdf80b9a | confirmed remote by `git ls-remote origin refs/heads/main` |
| aurum/01-storage | 34c05f24704bdcfd4bd3a00b72670b7b78e42ea0 | merge base with main is dc24992209b6790fa978ded9d61c0a61bdf80b9a |
| aurum/03-market-data | 0cc864c0eefda5818d3f82cf9578d3d223f1a70c | same main merge base |
| aurum/04-product | a86f4b7a1693a6dfa003f6f2a178f1ddd89d8590 | same main merge base |

Ten other existing Claude worktrees were enumerated with `git worktree list --porcelain`; none changed. Existing stash `stash@{0}` on refactor/cycle-plan retained. Node, Claude, Codex and Docker processes exist; no process was killed. Disposable `quant-aurum-odin-test` is PostgreSQL 16.13 on localhost:55432; unrelated containers are untouched. Separate named disposable databases are used for review and regression.

AGENTS.md, docs/ARCHITECTURE.md, docs/STATUS.md, docs/RUNBOOKS.md, CI and protected-path hook inspected. Existing unlock marker is present, unexplained, unused and unchanged. Schema and migrations are treated as protected under the explicit takeover instructions even though the hook path list is narrower. No environment-file values inspected or printed.

## Historical claims

| Claim | Evidence | Classification |
| --- | --- | --- |
| PR 82 merged as aec2a80 | GitHub PR metadata: merged 2026-11-17 12:36:51Z; full SHA aec2a80cbc6ca34ef4a32f267d04adbf938e128d | VERIFIED_REPOSITORY |
| CI run 44083988025 passed | GitHub jobs 134041489873, 134041490526, 134041491174 all success | VERIFIED_TEST (historical CI, not combined branch) |
| 1,663 tests, 238 files, one skip | job 134041491174 summary at 12:35:29Z | VERIFIED_TEST (historical CI) |
| 14 browser tests | job 134041490526: `14 passed (3.2m)` | VERIFIED_TEST (historical CI) |
| 177 integration tests | independently extracted 34 integration-project file summaries, including singular `1 test`; total 177 | VERIFIED_TEST (historical CI) |
| deployed aec2a80 | repository deployment notes only; production access explicitly withheld | UNVERIFIED |

GitHub evidence: https://github.com/TheFridey/QUANT/pull/82 and https://github.com/TheFridey/QUANT/actions/runs/44083988025.

## Review and integration gates

Independent isolated storage and feed reviewers, and a separate financial reviewer, inspect implementation rather than completion claims. Root reviews fixes and integration/security. Review documents record findings and test evidence. High or critical unresolved findings block integration. Original branch refs remain preserved. No production evidence will be inferred from local tests.

Initial scope: storage adds six worker ops files; feed adds five market-data files; product changes four shared files. All are presently unwired. Retention policy approval list must remain empty and MarketObservation archival blocked. Research campaigns and holdouts remain untouched.
