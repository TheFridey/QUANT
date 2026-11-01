# ASCEND status

Updated 1 Nov 2026. Deployed commit: `982c045` (PR #21, 13:11 UTC). Labels are defined in [`README.md`](README.md).

| Workstream | State | Evidence | Next step |
| --- | --- | --- | --- |
| ASCEND-00 daily-loss lockout | No bypass found. F1 (same-day latch) and F2 (entry sized to headroom) are merged (PR #21) and deployed (`982c045`, 1 Nov 2026 13:11 UTC). The latch is populated in production and inactive (worst day P&L −1.0%) | `VERIFIED_UNIT`; `VERIFIED_INTEGRATION` (CI `test` job and local Postgres, `apps/worker/src/daily-loss-latch.integration.test.ts`); `VERIFIED_HISTORICAL` (production ledger). Not yet `VERIFIED_AUTONOMOUS_PAPER`: no production breach has exercised the latch | Watch for the first real latch event |
| ASCEND-00 production forensics | Done for all 27 round trips: loss decomposition, rejections, inferred config | `VERIFIED_HISTORICAL` | |
| ASCEND-00 F5 duplicate NET_CLOSE | Fixed: settle cancels a pending SELL on a flat position with `EXIT_SUPERSEDED`, releasing reservations. Merged (PR #23); not deployed | `VERIFIED_UNIT` (`apps/worker/src/executor/settle.test.ts`); CI green; safety review APPROVE WITH NOTES | Deploy |
| ASCEND-00 F3 sandbox BUY after breach | Fixed: the outbox cancels never-submitted SANDBOX BUYs when halted, paused, unrolled, or breached (fenced on PENDING + PRE_SUBMIT). PR #24 | `VERIFIED_UNIT` (`apps/worker/src/sandbox-execution.test.ts`, loop scope included); safety review APPROVE WITH NOTES, medium note fixed | Merge on green CI, then deploy |
| ASCEND-00 F6 config audit history | Fixed: an `EngineControl` trigger appends `EngineConfigRevision` rows (append-only); `GET /api/engine/config/history`. Merged (PR #25); not deployed (migration) | `VERIFIED_INTEGRATION` (`packages/shared/src/engine-config-revision.integration.test.ts`); CI green | Deploy with migration |
| ASCEND-00 trade autopsy capability | Implemented: `packages/analytics/src/trade-autopsy.ts` and `GET /api/terminal/autopsy`. PR #26 | `VERIFIED_UNIT` (`trade-autopsy.test.ts`); `VERIFIED_HISTORICAL` (reproduces the 27-trip forensic totals from the production ledger) | Merge on green CI, then deploy; web view (ASCEND-10) |
| ASCEND-06 execution costs | Prioritised: costs caused ~75% of realised losses | none | Net-expected-edge gate design |
| ASCEND-01 historical data | Not started | none | Provider audit |
| ASCEND-02 to 05, 07 to 11 | Not started | none | See the dependency graph in `README.md` |

No strategy, model or return figure has been produced by ASCEND yet.
