# Research lab acceptance checklist

Honest results for this agent session (2026-10-26). Untested items stay SKIP/FAIL.

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Launch with Docker | SKIP | `docker` not installed in this VM. Local Postgres (`pg_isready` OK) + Redis (`PONG`) used. `docker-compose.yml` documents Postgres 16 + Redis 7 only. |
| 2 | Select a strategy | PASS | `POST /api/lab/strategies` created `lab-momentum` v1/v2; Strategy Laboratory UI route `GET /terminal/strategy` → 200. |
| 3 | Start live-data paper session | PASS | `POST /api/engine/start` → `RUNNING`; health showed `dataState=LIVE`, `lastObservationAt` updating from DexScreener ingest. |
| 4 | Watch agents on actual tokens | PASS | Snapshot while RUNNING: 12 pairs, 6 pipeline agents, 61 decisions, 32 orders against live observations. |
| 5 | Observe simulated trades + accounting | PASS | Live paper orders/fills present in snapshot; backtest run produced 46 simulated trades with fees `2.32252068` and ledger-style cash/equity metrics (paper venue). |
| 6 | Inspect every decision | PASS | Snapshot `decisions` (61) + backtest trade reason codes + ORACLE review payload on `GET /api/lab/backtests/:id`. |
| 7 | Stop safely | PASS | `pause` → `PAUSED`, `stop` → `STOPPED`; allowedActions restored to `start` / `emergency_stop`. |
| 8 | Replay historical sessions where data exists | PASS | `POST /api/lab/backtests` over 3649 persisted `MarketObservation` rows; inactive/disappeared pairs reported (not dropped). Fixture integration test also PASS. |
| 9 | Compare strategy versions | PASS | `GET /api/lab/backtests/compare?ids=` for `cmp-a3` (v1, return −2.2317%) vs `cmp-b3` (v2, return −3.6070%); both `NOT_RELEASE_READY`. |
| 10 | Export reproducible report | PASS | `GET /api/lab/backtests/:id/report` → HTML with `SIMULATION RESULTS`, `NOT_RELEASE_READY`, baselines. Sample saved at `docs/acceptance/sample-research-report.html`. Runtime path: `/api/lab/backtests/:id/report`. |

## Automated verification

- `pnpm test` — 18 files / 57 tests PASS (event ordering, no look-ahead, costs, sample gates, Monte Carlo seed, fixture integration, ORACLE).
- `pnpm typecheck` — PASS
- `pnpm lint` — PASS

## Explicit non-claims

- Docker Compose was **not** executed here.
- Strategies are **not** validated for real money; release gate always requires forward paper evaluation; `realMoneyGraduation: false`.
