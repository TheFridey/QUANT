# ASCEND status

Updated 1 Nov 2026, baseline `a5a4674` (also the deployed commit). Labels are defined in [`README.md`](README.md).

| Workstream | State | Evidence | Next step |
| --- | --- | --- | --- |
| ASCEND-00 daily-loss lockout | No bypass found. F1 (same-day latch) and F2 (entry sized to headroom) are implemented on `fix/ascend-00-daily-loss-latch`; not merged, deployed or CI-verified | `VERIFIED_UNIT` (`daily-loss-lockout.test.ts`, `evaluate.test.ts`, `size.test.ts`, `session-equity.test.ts`); `VERIFIED_INTEGRATION` locally (`apps/worker/src/daily-loss-latch.integration.test.ts`); `VERIFIED_HISTORICAL` (production ledger) | Safety review, PR, CI, then a deploy with the migration (operator approval) |
| ASCEND-00 production forensics | Done for all 27 round trips: loss decomposition, rejections, inferred config | `VERIFIED_HISTORICAL` | |
| ASCEND-00 open findings | F3 sandbox BUY after breach; F5 duplicate NET_CLOSE; F6 no config audit history | none (not fixed) | F5 and F6 are unprotected paths and can proceed; F3 needs approval |
| ASCEND-00 trade autopsy capability | Not started. The fields are now defined by `forensics/2026-11-01-queries.sql` | none | Port query 5 to a tested function plus an API view |
| ASCEND-06 execution costs | Prioritised: costs caused ~75% of realised losses | none | Net-expected-edge gate design |
| ASCEND-01 historical data | Not started | none | Provider audit |
| ASCEND-02 to 05, 07 to 11 | Not started | none | See the dependency graph in `README.md` |

No strategy, model or return figure has been produced by ASCEND yet.
