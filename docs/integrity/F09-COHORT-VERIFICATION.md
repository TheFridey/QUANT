# F09 — complete prospective cohort evaluation

Branch `integrity/phase-ii`. Files: `packages/evolution/src/campaign/bridge.ts` (reader), `packages/evolution/src/campaign/stages.ts` (judgement rules).

## Defect (confirmed by reading, `main` `33c6a4a`)

`modelProspectiveEvidence` loaded `take: 5_000` shadow rows ordered by `decisionTime` only. The 5,000 included abstentions and overlapping predictions. Registration allows `targetEffectiveSignals` up to 5,000. With one decision per bar and horizon 8, 5,000 rows hold about 625 independent signals, so a declared target above that could never be reached, and later rows never entered the calculation. Ties (several instruments at one decision time) had no defined order. A regression test shows a 16,000-row cohort with a 1,200-signal target: the old prefix is "not reached", the complete read reaches it.

## Semantics

| Aspect | Rule |
| --- | --- |
| Cohort | The fixed prefix of the model's rows in `(decisionTime ASC, id ASC)` order. It ends at the decision time of the resolved, hash-verified, above-threshold, non-overlapping signal that reaches `targetEffectiveSignals` (declared at registration, immutable). All rows sharing that decision time are included. |
| Pagination | Keyset `decisionTime > t OR (decisionTime = t AND id > lastId)`, `PROSPECTIVE_PAGE_SIZE` = 2,000. No OFFSET. The existing `(modelVersionId, decisionTime)` index serves it, so **no schema change**. |
| Snapshot | Every page is read in one `REPEATABLE READ` transaction (timeout 120 s), so rows the shadow service inserts during the read cannot appear in a later page. |
| Bound | At most `PROSPECTIVE_MAX_COHORT_ROWS` = 250,000 rows held. If the bound is hit first, the evidence is `truncated`, `NOT_YET_JUDGED` and never sufficient, and the reason is listed. |
| Later rows | Counted (`cohort.laterRows`), never loaded. They cannot change a reached cohort. |
| Abstentions | Kept in the cohort, never counted as signals (unchanged). |
| Late outcomes | **New:** a sample is judged only when no prediction inside it still lacks an outcome. An earlier outcome arriving later would move the cutoff earlier and change the sample (test shows this). A permanently missing outcome keeps the evidence insufficient and says so (`pendingOutcomesInSample`). |
| Retry / interruption | The read is a pure function of stored rows; nothing is persisted, so an interrupted read simply reruns. |
| Display change | `predictions` / `abstained` / `integrityFailures` now describe the rows read (the judged cohort, or every row while unreached) rather than an arbitrary first 5,000. `cohort` (`pages`, `rowsRead`, `laterRows`, `truncated`, `maxRows`) and `observation.pendingOutcomesInSample` are new fields. |

## Tests

| Test | Kind | Result |
| --- | --- | --- |
| `packages/evolution/src/campaign/cohort.test.ts` (14) | in-memory store implementing the exact keyset contract | 14/14: empty; single row; 5,000 / 5,001 / 15,437 rows read completely at ≤ pageSize per call; the old 5,000-prefix cannot reach a target the full read reaches; matches a full reference calculation for page sizes 1, 2, 7 and 1,000 with 3 instruments tied at every decision time (input shuffled); all tied rows at the cutoff included, none after; later rows counted not loaded; abstentions and sub-threshold predictions; truncation never judged; pending earlier outcome blocks judgement and would have moved the cutoff; later inserts leave a reached cohort unchanged; invalid page size refused; benchmark |
| `packages/evolution/src/campaign/cohort.integration.test.ts` (3) | real PostgreSQL 18.3 (disposable), two connections | 3/3: 15,003 rows (3 tied instruments × 5,001 times) read exactly once in DB order for page sizes 1,000 / 4,999 / 5,000 / 5,001 / 20,000; a row committed by another connection after page 1 does not appear (snapshot); `modelProspectiveEvidence` reports cohort progress, and a 10,000-row bound gives `truncated` |
| Mutation: keyset `id > lastId` → `id >= lastId` | | 6 tests fail (killed) |
| Mutation: stop at `t >= cutoff` (drops tied rows) | | 1 test fails (killed) |

Live-timed rows only on Postgres: the insert triggers forbid backdated predictions and outcomes before the horizon ends, so resolved-outcome cohorts are covered by the in-memory reference tests.

## Benchmark (local, Windows, Node 22.19)

| Case | Pages | Time | Memory |
| --- | --- | --- | --- |
| 100,000 rows, in-memory store, page 2,000 | 51 | 2.4 s (includes per-row SHA-256 verification; excludes DB time) | heap +29.9 MB |
| 15,003 rows, Postgres, five full reads (page sizes 1,000–20,000) | 16 / 4 / 4 / 3 / 1 | 4.6 s for all five | not measured |

At the 250,000-row bound, extrapolated memory is about 75 MB of heap. Not measured on the VPS.

## Limitations

- Reading 250,000 rows inside one 120-second transaction is not verified at that size on production hardware.
- `ShadowOutcome` rows are assumed immutable once written (append-only trigger), which the late-outcome rule relies on.
