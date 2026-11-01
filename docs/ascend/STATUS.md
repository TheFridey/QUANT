# ASCEND status

Updated 1 Nov 2026. Deployed commit: `982c045` (PR #21, 13:11 UTC). Labels are defined in [`README.md`](README.md).

| Workstream | State | Evidence | Next step |
| --- | --- | --- | --- |
| ASCEND-00 daily-loss lockout | No bypass found. F1 (same-day latch) and F2 (entry sized to headroom) are merged (PR #21) and deployed (`982c045`, 1 Nov 2026 13:11 UTC). The latch is populated in production and inactive (worst day P&L −1.0%) | `VERIFIED_UNIT`; `VERIFIED_INTEGRATION` (CI `test` job and local Postgres, `apps/worker/src/daily-loss-latch.integration.test.ts`); `VERIFIED_HISTORICAL` (production ledger). Not yet `VERIFIED_AUTONOMOUS_PAPER`: no production breach has exercised the latch | Watch for the first real latch event; F3 approval |
| ASCEND-00 production forensics | Done for all 27 round trips: loss decomposition, rejections, inferred config | `VERIFIED_HISTORICAL` | |
| ASCEND-00 open findings | F3 sandbox BUY after breach; F5 duplicate NET_CLOSE; F6 no config audit history | none (not fixed) | F5 and F6 are unprotected paths and can proceed; F3 needs approval |
| ASCEND-00 trade autopsy capability | Not started. The fields are now defined by `forensics/2026-11-01-queries.sql` | none | Port query 5 to a tested function plus an API view |
| ASCEND-06 execution costs | Prioritised: costs caused ~75% of realised losses | none | Net-expected-edge gate design |
| ASCEND-01 historical data | Not started | none | Provider audit |
| ASCEND-02 to 05, 07 to 11 | Not started | none | See the dependency graph in `README.md` |

No strategy, model or return figure has been produced by ASCEND yet.
