# Research lab acceptance checklist

Honest results for this environment. Do not treat unchecked items as passed.

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Launch with Docker | SKIP | `docker` binary not present in this VM (`command not found`). Compose file still documents Postgres 16 + Redis 7. Local Postgres/Redis were used instead. |
| 2 | Select a strategy | PASS/FAIL | Exercised via `/api/lab/strategies` + Strategy Laboratory UI after stack verify. |
| 3 | Start live-data paper session | PASS/FAIL | Existing paper path; not rewritten. Verified only if engine start succeeds against running API. |
| 4 | Watch agents on actual tokens | PASS/FAIL | Requires RUNNING engine + DexScreener ingest. |
| 5 | Observe simulated trades + accounting | PASS/FAIL | Live paper ledger path unchanged; backtest fills covered by unit/integration tests. |
| 6 | Inspect every decision | PASS/FAIL | Existing decision feed; ORACLE reviews on `/api/lab/backtests/:id`. |
| 7 | Stop safely | PASS/FAIL | Existing engine state machine. |
| 8 | Replay historical sessions where data exists | PASS/FAIL | `POST /api/lab/backtests` + fixture integration test `packages/backtest/src/integration.test.ts`. |
| 9 | Compare strategy versions | PASS/FAIL | `GET /api/lab/backtests/compare?ids=` + Backtesting UI compare. |
| 10 | Export reproducible report | PASS/FAIL | `GET /api/lab/backtests/:id/report` → HTML download. |

Fill PASS/FAIL cells after the verification run in this agent session; leave SKIP only when infrastructure is unavailable.
