# QUANT MVP — Requirements Matrix

Statuses (honest): see `ACCEPTANCE_SCENARIOS.md` for the authoritative per-stage table with call sites and evidence columns.

Mechanical roll-up from ACCEPTANCE_SCENARIOS (implementation ≠ verification):

| Status | Count | Notes |
| --- | --- | --- |
| VERIFIED_OFFLINE | 19 | Gate A core + PG admission + several helpers with runtime call sites |
| PARTIAL | 32 | Implemented depth incomplete or UX/ops unfinished |
| IMPLEMENTED_UNVERIFIED | 6 | Protection/instances/costs/gateway pending richer harness |
| BLOCKED_EXTERNAL_TEST | 1 | C40 named external demo (credentialed) |
| VERIFIED_EXTERNAL | 0 | none |
| NOT_STARTED | 0 | — |

**Do not use legacy DONE 34** — that count mixed fixture DEMO ingest and pure helpers with production completeness.

## Critical-path status (this branch)

| Area | Status | Evidence |
| --- | --- | --- |
| Fixture isolation | VERIFIED_OFFLINE | `paper-multimarket.test`, default `multiMarketPaperIngest=false`, FIXTURE banner |
| Named providers | IMPLEMENTED_UNVERIFIED + BLOCKED_EXTERNAL_TEST | Alpaca/OANDA adapters + offline contracts; credentialed script exit 2 without keys |
| PG reservations in admission | VERIFIED_OFFLINE | `reserveInTx` in worker executor + `pg-reservations.test` race |
| Long/short protection | IMPLEMENTED_UNVERIFIED | helpers + worker arm/evaluate/retry; richer multi-worker crash harness TBD |
| Concurrent strategies | IMPLEMENTED_UNVERIFIED | durable `StrategyInstance` seeded + evaluate/allocate in `loadPlan` |
| Capacity 50 slots | PARTIAL | in-process only — explicitly not prod SLO |
| External demo C40 | BLOCKED_EXTERNAL_TEST | adapter READY only with named practice credentials |

## External blockers

Alpaca paper keys, OANDA practice token/account, Birdeye, OpenAI — BLOCKED_EXTERNAL_TEST / UNKNOWN paths. Never fake LIVE success.
