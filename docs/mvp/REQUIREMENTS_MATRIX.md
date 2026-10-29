# QUANT MVP — Requirements Matrix

Statuses (honest): see `ACCEPTANCE_SCENARIOS.md` for the authoritative per-stage table with call sites and evidence columns.

Mechanical roll-up from ACCEPTANCE_SCENARIOS (implementation ≠ verification):

| Status | Count | Notes |
| --- | --- | --- |
| VERIFIED_OFFLINE | 25 | Gate A core + PG admission + protection crash/OCO + exit parity + REPLAY metrics + costs |
| PARTIAL | 29 | Implemented depth incomplete or UX/ops unfinished |
| IMPLEMENTED_UNVERIFIED | 3 | Gateway + concurrent instances/allocation pending richer harness |
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
| Long/short protection | VERIFIED_OFFLINE | worker arm/evaluate/retry + crash restart + amendment keep-confirmed + 2-worker OCO race |
| Concurrent strategies | IMPLEMENTED_UNVERIFIED | durable StrategyInstance seeded + evaluate/allocate in `loadPlan` |
| Capacity 50 slots | PARTIAL | PG soak script production-shaped path; fixture-shaped without live feeds — not a live SLO |
| External demo C40 | BLOCKED_EXTERNAL_TEST | adapter READY only with named practice credentials |

## External blockers

Alpaca paper keys, OANDA practice token/account, Birdeye, OpenAI — BLOCKED_EXTERNAL_TEST / UNKNOWN paths. Never fake LIVE success.
