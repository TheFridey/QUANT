# ASCEND status

Updated 1 Nov 2026. Deployed commit: `d0260a3` (services restarted 1 Nov 2026 14:29:43 UTC; previous `982c045`). Labels are defined in [`README.md`](README.md).

| Workstream | State | Evidence | Next step |
| --- | --- | --- | --- |
| ASCEND-00 daily-loss lockout | No bypass found. F1 (same-day latch) and F2 (entry sized to headroom) are merged (PR #21) and deployed (`982c045`, 1 Nov 2026 13:11 UTC). The latch is populated in production and inactive (worst day P&L −1.0%) | `VERIFIED_UNIT`; `VERIFIED_INTEGRATION` (CI `test` job and local Postgres, `apps/worker/src/daily-loss-latch.integration.test.ts`); `VERIFIED_HISTORICAL` (production ledger). Not yet `VERIFIED_AUTONOMOUS_PAPER`: no production breach has exercised the latch | Watch for the first real latch event |
| ASCEND-00 production forensics | Done for all 27 round trips: loss decomposition, rejections, inferred config | `VERIFIED_HISTORICAL` | |
| ASCEND-00 F5 duplicate NET_CLOSE | Fixed: settle cancels a pending SELL on a flat position with `EXIT_SUPERSEDED`, releasing reservations. Merged (PR #23); deployed `d0260a3` | `VERIFIED_UNIT` (`apps/worker/src/executor/settle.test.ts`); CI green; safety review APPROVE WITH NOTES | Watch for `EXIT_SUPERSEDED` cancels beside protective exits |
| ASCEND-00 F3 sandbox BUY after breach | Fixed: the outbox cancels never-submitted SANDBOX BUYs when halted, paused, unrolled, or breached (fenced on PENDING + PRE_SUBMIT). Merged (PR #24); deployed `d0260a3` | `VERIFIED_UNIT` (`apps/worker/src/sandbox-execution.test.ts`, loop scope included); safety review APPROVE WITH NOTES, medium note fixed; CI green | Follow-ups: release SANDBOX reservations on cancel; lifecycle-fence pending exits |
| ASCEND-00 F6 config audit history | Fixed: an `EngineControl` trigger appends `EngineConfigRevision` rows (append-only); `GET /api/engine/config/history`. Merged (PR #25); deployed `d0260a3`. Production has the BASELINE row and both triggers | `VERIFIED_INTEGRATION` (`packages/shared/src/engine-config-revision.integration.test.ts`); CI green | |
| ASCEND-00 trade autopsy capability | Implemented: `packages/analytics/src/trade-autopsy.ts` and `GET /api/terminal/autopsy`. Merged (PR #26); deployed `d0260a3` | `VERIFIED_UNIT` (`trade-autopsy.test.ts`); `VERIFIED_HISTORICAL` (reproduces the 27-trip forensic totals from the production ledger) | Web view (ASCEND-10) |
| ASCEND-06 execution costs | Prioritised: costs caused ~75% of realised losses | none | Net-expected-edge gate design |
| ASCEND-01 historical data | Not started | none | Provider audit |
| ASCEND-02 to 05, 07 to 11 | Not started | none | See the dependency graph in `README.md` |

CI note: since about #21, the manual-buy e2e failed intermittently. #28 guessed at F2 headroom and was wrong. Its added diagnostics showed the real cause: automatic entries from FX/ETF strategy instances (which ignore the M5 threshold) held the picked pair, so the manual BUY was refused as a second entry. #30 disables automatic entries per market for that test, restores them afterwards, and reverts #28's `maxDailyLossPct` override. It passed two CI attempts. No production code or limits changed.

No strategy, model or return figure has been produced by ASCEND yet.
