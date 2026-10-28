# QUANT MVP — Requirements Matrix

Statuses (honest): see `ACCEPTANCE_SCENARIOS.md` for the authoritative per-stage table with call sites and evidence columns.

Mechanical roll-up from ACCEPTANCE_SCENARIOS (implementation ≠ verification):

| Status | Approx count | Notes |
| --- | --- | --- |
| VERIFIED_OFFLINE | ~18 | Gate A core + several helpers with runtime call sites |
| PARTIAL | ~30 | Implemented depth incomplete or helper-only previously |
| IMPLEMENTED_UNVERIFIED | ~4 | New durable paths pending richer harness |
| BLOCKED_EXTERNAL_TEST | ~4 | Named providers / Birdeye / LLM without credentials |
| NOT_STARTED | 0 | Greenfield rows closed or mapped |

**Do not use legacy DONE 34** — that count mixed fixture DEMO ingest and pure helpers with production completeness.

## Critical-path status (this branch)

| Area | Status | Evidence |
| --- | --- | --- |
| Fixture isolation | VERIFIED_OFFLINE | `paper-multimarket.test`, default `multiMarketPaperIngest=false`, FIXTURE banner |
| Named providers | IMPLEMENTED_UNVERIFIED + BLOCKED_EXTERNAL_TEST | Alpaca/OANDA adapters + offline contracts; credentialed script exit 2 without keys |
| PG reservations | VERIFIED_OFFLINE | `pg-reservations.test` race + over-release |
| Long/short protection | PARTIAL→IMPLEMENTED_UNVERIFIED | helpers + worker arm/evaluate; richer multi-worker crash harness TBD |
| Concurrent strategies | PARTIAL | durable `StrategyInstance` + evaluate/allocate tests |
| Capacity 50 slots | PARTIAL | in-process only — explicitly not prod SLO |
| External demo C40 | BLOCKED_EXTERNAL_TEST | adapter READY only with named practice credentials |

## External blockers

Alpaca paper keys, OANDA practice token/account, Birdeye, OpenAI — BLOCKED_EXTERNAL_TEST / UNKNOWN paths. Never fake LIVE success.
