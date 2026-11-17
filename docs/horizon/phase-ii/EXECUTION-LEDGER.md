# HORIZON Phase II: execution ledger

Branch `horizon/phase-ii-breakout`, cut from `main` `873bdd6`. Not merged, not deployed. No protected path changed, and no flag or limit changed.

## Session 1: 17 Nov 2026

### Reconnaissance

- **Read:** AGENTS.md and all mandatory documents.
- **Code survey:** two read-only agents covered the execution path and ingest/strategy/scanner/research. Citations are in `CURRENT-STATE.md`.
- **Production, read-only:**
  - git HEAD and service status;
  - SQL over `EngineControl`, `PaperAccount`, `EquitySnapshot`, `MarketObservation`, `Order`, `Fill`, `Position`, `StrategyInstance`, `MarketSelection`, `HistoricalDataset`, research tables, `AgentDecision` reason codes and table sizes;
  - credential **names** from `.env`;
  - `market-probe-cli` twice;
  - one availability and pricing read for 13 OANDA instruments and 6 Alpaca ETFs.
- **Temporary script:** a read-only script was copied to the VPS, run and deleted. Nothing else was written there.

### Commits

| Commit | Content | Tests |
| --- | --- | --- |
| `78aa955` | `packages/shared/src/quote-admission.ts`: PCR-2 C1/C5 classifier (pure, unwired) | 20, then 26 after review fixes |
| `0119fdf` | `sessions.ts`, `instruments.ts`: NYSE early closes; equity sessions UNKNOWN outside 2025–2027; `METALS_ENERGY_CFD` for XAU and WTI. WTI reverted after review | 5 new |
| `7bb86dd` | `packages/market-data/src/provider-circuit.ts`: per-instrument breaker (pure, unwired) | 9, then 10 after review fixes |
| `0cba4ae` | `packages/analytics/src/maturity-ladder.ts`: REGISTERED…PAPER_ELIGIBLE ladder, per-class scan capacity (pure, unwired) | 8 |
| `dcb5ae3` | Phase II documents | — |
| (next commit) | safety-review fixes (code), ledger, living-doc updates, review dispositions | — |

### Verification (local Windows; Linux CI not yet run on this branch)

| Check | Command | Result |
| --- | --- | --- |
| Baseline unit suite (`873bdd6`, before changes) | `pnpm test` | 1,306 passed, 2 failed, 6 files failed. All environmental: restore-drill `.mjs` imports, and API auth/Redis tests with no Redis |
| Unit suite on branch (before review fixes) | `pnpm test` | 1,366 passed, 1 failed (`token-revocation.failclosed`, environmental, also failing at baseline), 3 files failed (that one plus the two restore-drill files) |
| Targeted suites after review fixes | `pnpm vitest run` on the shared session, quote-admission and instruments tests, provider-circuit, `packages/agent-core`, `packages/analytics` | 38 files, 288 passed, 3 skipped |
| Typecheck | `pnpm typecheck` | pass |
| Lint | `pnpm exec eslint apps packages` | clean |
| Package build | `pnpm build:packages` | pass |
| Production build | `pnpm build` | web builds. `nest build` for api and worker fails locally on `@swc/core` loading (known, see `docs/evidence/HANDOVER.md`); `tsc -p` for both passes |
| DB integration suite | — | **not run**: no `odin_test` database on this host |
| Browser e2e | — | **not run locally**: needs Redis |
| Mutation tests | — | not run; the new modules are pure, with property tests |

### Independent reviews

| Review | Verdict | Disposition |
| --- | --- | --- |
| `quant-safety-reviewer` on `873bdd6..dcb5ae3` | **APPROVE WITH NOTES (code).** The approval package must not be approved as written | See the findings below |
| `regression-reviewer` | no blocking regressions | the 2028 calendar cliff and the XAU/WTI session change are documented |
| Statistical review | not applicable: no statistical code changed | required before any Phase II campaign result is used |

**Safety-review findings:**

- **HIGH H1 (A1 is a gate bypass; the classifier ignored `dataState`).**
  - The classifier now refuses any stored `dataState` other than DEMO or LIVE (`DATA_STATE_NOT_ADMISSIBLE`).
  - A1 is relabelled a loosening, and the spread cap is mandatory.
- **MEDIUM M2 (a NaN skew or an invalid `now` disabled the time checks).** Both now give `INVALID_LIMIT`, with tests.
- **M3 (A2 contradiction).** The "risk PASS ⇒ settle passes" promise is removed. Settle re-evaluates at fill time and never reuses the risk-time verdict.
- **M4 (A4 removes a liquidity cap).** A4 is relabelled a loosening, with a proposed per-class notional cap on top of the existing limits.
- **L-M5 (A5 and A7 boundary changes).** Lock-order, deadlock and timeout tests are added to A7; A5's boundary is stated.
- **L6 (WTI entry window widened today).** WTI is reverted to `INDEX_EXTENDED`. XAU stays on CFD hours, which is narrower than before.
- **L7 (calendar ends 2028).** Documented. 2027 early closes need operator confirmation against the NYSE calendar.
- **L8 (breaker gaps):**
  - late success or failure while OPEN is now ignored;
  - a half-open probe with no result times out and reopens.
  - Not changed: Retry-After is capped at `maxBackoffMs`, and jitter is clipped at the cap.
- **L9 (descriptor spread vs bid/ask).** The spread is now computed from the bid/ask passed in. `providerTradeable: null` and DEALER_INDICATIVE are accepted by design and disclosed.

A post-fix re-review by the safety agent has not been run.

### Production actions

Read-only only. No deploy, no restart, no configuration or flag change, and no order.
