# PROJECT EVOLUTION — acceptance evidence

Honest results for this agent session (2026-10-26). Untested items stay SKIP/FAIL.

## Automated verification

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm test` | PASS | 25 files / 73 tests (instruments, registry, router, forge adversarial static reject, challenge/leakage, signed reports, memory entry scrub, lifecycle, pipeline E2E) |
| `pnpm typecheck` | PASS | All workspace packages including `@odin/evolution` and `apps/api` |
| `pnpm lint` | PASS | eslint clean |
| Docker Compose launch | SKIP | `docker` not exercised this session; local Postgres + Redis used (`pg_isready` OK, Redis `PONG`) |

## E2E research pipeline (live API :4318)

| # | Step | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Hypothesis discovered | PASS | `POST /api/evolution/hypotheses` → `hyp_604c82fa-…` |
| 2 | Coding model creates candidate | PASS | Pipeline forge template (mock/no LLM key) → module `strat_live_e2e_m5_packaging` hash `7a0bd4ef…` |
| 3 | Sandbox run | PASS | Workspace `/tmp/odin-forge/strat_live_e2e_m5_packaging/0.1.0`; contract tests in forge |
| 4 | Historical measurable results | PASS | Pipeline used persisted `MarketObservation` count; `historical_measurable_results=PASS` (returns remain `null` — not invented) |
| 5 | Independent challenge | PASS | Challenge ran; live pipeline `passed=true` with warnings path; adversarial API call with look-ahead+leakage → `passed=false` BLOCK |
| 6 | Versioned evidence report | PASS | `reportId=rpt_c76f6f9f-…`, `contentHash=bce541f2…`, persisted `ExperimentReport` |
| 7 | Reject or approved paper eval | PASS | Lifecycle advanced `CHALLENGED→VALIDATED→PAPER_CANDIDATE` (still `NOT_RELEASE_READY`; no real-money) |
| 8 | Forward paper trades recorded | PASS | Isolated research paper memory trade recorded (`tradesRecorded=1`); **live Solana paper ledger unchanged** (`venue=PAPER`, cash `59.21294477`, 12 LIVE pairs) |
| 9 | Post-trade memory update | PASS | `GET /api/evolution/memory` → 3 rows phases BEFORE/DURING/AFTER; AFTER marked `postExit` |
| 10 | Subsequent experiment proposed | PASS | `nextExperimentProposed=true`; research queue length 2 |

## Adversarial forge

| Attack | Result | Evidence |
| --- | --- | --- |
| Generated code imports `fs`, reads `process.env.DATABASE_URL`, calls `placeOrder` | PASS (rejected) | `POST /api/evolution/forge` → `STATIC_REJECT` with forbidden-pattern findings |
| Mix Solana + SPX in one strategy | PASS (rejected) | `POST /api/evolution/markets/validate` → incompatible mix |
| Index levels invented for LIVE fills | PASS (not invented) | Index quotes `level=null`, `dataState=DEMO`, provenance labelled; order spec `allowed=false` |
| Autonomy L4 / real money | PASS (disabled) | `realMoneyExecutionEnabled=false`; UI L4 button disabled; API caps level ≤3 |

## Command centre UI

| Section route | Result |
| --- | --- |
| `/terminal/markets` | PASS HTTP 200 |
| `/terminal/research` | PASS HTTP 200 |
| `/terminal/genome` | PASS HTTP 200 |
| `/terminal/memory` | PASS HTTP 200 |
| `/terminal/models` | PASS HTTP 200 |
| `/terminal/autonomy` | PASS HTTP 200 |

## Explicit non-claims

- Docker Compose was **not** executed.
- Equity index delayed Yahoo adapter exists but was **not** required for acceptance; stub DEMO null levels used.
- Pipeline “paper trades” in step 8 are **isolated research-memory records**, not additional live-engine fills. Live paper path remained healthy separately.
- No real-money execution adapter exists; Level 4 stays disabled.
- LLM keys were absent — forge used deterministic templates; router fell back to mock providers.

## Commit

`f6085d2e733f018707de16ca8cba82fa0f63a597` on `main` — *Add PROJECT EVOLUTION: multi-market registry, model router, research pipeline.*
