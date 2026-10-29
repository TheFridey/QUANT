# QUANT MVP — Requirements Matrix

Statuses (honest): see `ACCEPTANCE_SCENARIOS.md` for the authoritative per-stage table with call sites and evidence columns.

Mechanical roll-up from ACCEPTANCE_SCENARIOS (implementation ≠ verification):

| Status | Count | Notes |
| --- | --- | --- |
| VERIFIED_OFFLINE | 48 | Includes sessions/holidays/DST, held multi-market marks, risk hierarchy, attribution, UX diagnostics |
| PARTIAL | 9 | Credentialed feeds, venue ACK live path, BullMQ multi-process locks, capacity SLO, ops UI depth |
| IMPLEMENTED_UNVERIFIED | 0 | — |
| BLOCKED_EXTERNAL_TEST | 1 | C40 named external demo (credentialed) |
| VERIFIED_EXTERNAL | 0 | none |
| NOT_STARTED | 0 | — |

**Do not use legacy DONE 34** — that count mixed fixture DEMO ingest and pure helpers with production completeness.

## Critical-path status (this branch)

| Area | Status | Evidence |
| --- | --- | --- |
| Fixture isolation | VERIFIED_OFFLINE | default off; FIXTURE banner; isolation tests |
| Named providers / gateway | VERIFIED_OFFLINE + BLOCKED_EXTERNAL_TEST | MarketDataGateway call site; credentialed script exit 2 |
| Organic crypto discovery | VERIFIED_OFFLINE | profiles+search primary; boosts optional |
| PG reservations in admission | VERIFIED_OFFLINE | worker `reserveInTx` + race test |
| Long/short protection | VERIFIED_OFFLINE | crash/restart + OCO race + amendment keep-confirmed |
| Concurrent strategies | VERIFIED_OFFLINE | worker loadPlan + integration test (≥3 instances) |
| Session equity / HWM | VERIFIED_OFFLINE | `rollSessionEquity` persisted in loadPlan |
| Sessions holidays/DST/FX weekend | VERIFIED_OFFLINE | sessions.test + plan SESSION_CLOSED |
| Risk hierarchy / breakers | VERIFIED_OFFLINE | risk-hierarchy + planCycle + terminal diagnostics |
| Capacity 50 slots | PARTIAL | PG soak fixture-shaped without live feeds |
| External demo C40 | BLOCKED_EXTERNAL_TEST | READY only with practice keys |

## External blockers

Alpaca paper keys, OANDA practice token/account, Birdeye, OpenAI — BLOCKED_EXTERNAL_TEST / UNKNOWN paths. Never fake LIVE success.
