# QUANT MVP — Acceptance Scenarios (stages 01–58)

**Baseline commit:** `05143f1d8f1941a0377737490f3ad40285532e57`  
**Method:** Implementation completeness is separate from verification. Statuses below are mechanical.

Allowed statuses: `NOT_STARTED` | `IMPLEMENTING` | `PARTIAL` | `IMPLEMENTED_UNVERIFIED` | `VERIFIED_OFFLINE` | `VERIFIED_EXTERNAL` | `BLOCKED_EXTERNAL_TEST`

Helper unit tests alone never promote a row to `VERIFIED_*` for a runtime path.

## Summary (recomputed from rows)

| Status | Count |
| --- | --- |
| NOT_STARTED | 0 |
| IMPLEMENTING | 0 |
| PARTIAL | 32 |
| IMPLEMENTED_UNVERIFIED | 6 |
| VERIFIED_OFFLINE | 19 |
| VERIFIED_EXTERNAL | 0 |
| BLOCKED_EXTERNAL_TEST | 1 |

Total rows: 58. Do not group stages to inflate DONE. Legacy DONE 34 is invalid.
Credentialed Alpaca/OANDA/Birdeye are also operationally BLOCKED_EXTERNAL_TEST outside this table (see EVIDENCE).

---

## Gate A — Engine baseline (01–10)

| ID | Original requirement | Implemented code | Runtime call sites | Offline evidence | External evidence | Status | Residual risk | Dependency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01 | Document verified defects + freeze contracts | `docs/mvp/*` | n/a | docs present | n/a | VERIFIED_OFFLINE | docs can drift | — |
| A02 | Activity headroom defaults ($10k paper, feasible min) | `strategy.ts` DEFAULT_STRATEGY | worker config bootstrap | strategy tests | n/a | VERIFIED_OFFLINE | operator overrides | — |
| A03 | Never round min size up through risk caps | `size.ts`, plan reject | planCycle → sizeOrder | size/plan tests | n/a | VERIFIED_OFFLINE | other paths must call sizeOrder | — |
| A04 | Held positions evaluated outside discovery | stage-runner loadPlan merge | worker cycle | gate-a.regression | n/a | PARTIAL | depth on multi-market marks | A09 |
| A05 | Flatten incomplete stays incomplete | executor flatten flag | worker executor | gate-a.regression | n/a | VERIFIED_OFFLINE | marks missing still fragile | — |
| A06 | Observation history = latest window | loadObservationHistory desc+reverse | loadPlan | gate-a.regression | n/a | VERIFIED_OFFLINE | — | — |
| A07 | PENDING until eligibleAt; expire honestly | store.ts pending path | executor commit | store.pending.test | n/a | VERIFIED_OFFLINE | multi-worker fill race | B19 |
| A08 | In-cycle sell releases capacity | plan.ts exposure subtract | planCycle | gate-a.regression | n/a | VERIFIED_OFFLINE | — | — |
| A09 | Registry: FX pairs + ETF proxies; indices research-only | `instruments.ts` | ingest/registry | instruments.test | n/a | PARTIAL | live product semantics incomplete | B12–B14 |
| A10 | Sessions / freshness for non-24x7 | `sessions.ts`, freshness | providers + plan | sessions.test | n/a | PARTIAL | holidays/DST incomplete | B12 |

## Gate B — Markets, lifecycle, risk (11–29)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B11 | Broaden crypto discovery | dexscreener universe | observe | dexscreener.test | live DexScreener | PARTIAL | still boost+WSOL primary | — |
| B12 | FX data/instruments | instruments + Frankfurter/OANDA | observe/providers | fx-feed.test | named provider | PARTIAL | holidays/DST; practice exec blocked | WS3 |
| B13 | Executable index ETF proxies | etf:SPY/QQQ + Alpaca | paper path | instruments + fx-feed | delayed feed | PARTIAL | fixture levels ≠ market-driven without Alpaca | WS4 |
| B14 | Equity/ETF/commodity semantics | commodity seeds | paper path | multi-market tests | — | PARTIAL | multipliers/currency incomplete | WS4 |
| B15 | Market-data gateway | market-provider + named adapters | observe | provider tests | — | IMPLEMENTED_UNVERIFIED | credentialed smoke blocked | WS3 |
| B16 | Durable order lifecycle | Order model + store | executor | pending tests | — | PARTIAL | venue ack path missing | C40 |
| B17 | Paper latency/expiry | eligibleAt/expiresAt | store | store.pending.test | n/a | VERIFIED_OFFLINE | — | — |
| B18 | Realistic market-specific costs | cost-model.ts in fill | fill path | cost-model.test | n/a | IMPLEMENTED_UNVERIFIED | DEX impact still for Solana | WS4 |
| B19 | Atomic risk reservations | PostgresReservationAuthority + reserveInTx | **worker executor admission** | reservations + pg race | n/a | VERIFIED_OFFLINE | richer multi-worker crash/restart harness TBD | WS5 |
| B20 | Exposure / daily loss / session equity | session-equity.ts | stage-runner | session-equity.test | n/a | PARTIAL | midnight+HWM present; full MTM TBD | — |
| B21 | Protective stops | protection + lifecycle | **worker arm/evaluate/retry** | protection*.test | n/a | IMPLEMENTED_UNVERIFIED | multi-worker crash depth TBD | WS6 |
| B22 | Native vs synthetic protection | ProtectionOrigin type | schema + helper | protection.test | n/a | PARTIAL | venue-native not wired | C40 |
| B23 | TP/OCO | claimOcoTriggerInTx + armLongShortOco | worker evaluateProtections | protection + lifecycle | n/a | IMPLEMENTED_UNVERIFIED | crash/restart races depth | WS6 |
| B24 | Trailing / breakeven / time | helpers + pulse params | pulse/backtest | unit | n/a | PARTIAL | peak/trough persist incomplete | WS6 |
| B25 | Operating controls pause/flatten | pauseNewEntries + flatten | engine control | gate-a + alerts | n/a | PARTIAL | exits active when paused — covered in evaluateRisk | WS6/WS9 |
| B26 | Risk hierarchy / breakers | evaluate + alerts | risk path | evaluate.test | n/a | PARTIAL | ACK≠resolve suspension covered; depth TBD | WS9 |
| B27 | Correlation budgeting | correlation.ts | evaluate | correlation.test | n/a | VERIFIED_OFFLINE | not yet on all admission routes | B19 |
| B28 | Activity-friendly presets | DEFAULT_STRATEGY | bootstrap | strategy tests | n/a | VERIFIED_OFFLINE | — | — |
| B29 | Hard blocks vs advisories | reasons + terminal why-blocked | terminal | terminal UX | n/a | PARTIAL | UNKNOWN≠pass for Solana security only | WS9 |

## Gate C — Strategies, replay, external (30–43)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C30 | Common strategy interface | strategy-library.ts | planCycle | library.test | n/a | VERIFIED_OFFLINE | — | — |
| C31 | Strategy library modules | pulse/fx/etf/commodity/mean-revert | activeStrategy | library.test | n/a | VERIFIED_OFFLINE | consolidation incomplete | WS8 |
| C32 | Concurrent strategy instances | StrategyInstance + ensureDefault + allocate | **worker loadPlan** | strategy-instances.test | n/a | IMPLEMENTED_UNVERIFIED | richer multi-worker instance soak TBD | WS7 |
| C33 | Opportunity allocation | allocateOpportunities + funnel | worker loadPlan gating | strategy-instances + funnel | n/a | IMPLEMENTED_UNVERIFIED | fairness depth TBD | WS7 |
| C34 | Backtest/runtime unify | trailing/time partial | pulse vs engine | tests | n/a | PARTIAL | shared clock/rules TBD | WS8 |
| C35 | Replay risk/pending | DATA_MODE=replay | observe copy | environments helpers | n/a | PARTIAL | isolated REPLAY account not on all metrics | WS2/WS8 |
| C36 | Data integrity | evolution integrity | research | integrity tests | n/a | PARTIAL | — | — |
| C37 | Net performance attribution | analytics | reports | performance.test | n/a | PARTIAL | instance-level attribution missing | WS7 |
| C38 | Promoted strategy drives decisions | activeStrategy → plan | loadPlan | active-strategy.test | n/a | VERIFIED_OFFLINE | generated code isolation incomplete | WS8 |
| C39 | Bounded research | autonomy/oracle limits | evolution | oracle tests | n/a | PARTIAL | sandbox env dependent | — |
| C40 | Named external demo adapter | alpaca_paper + oanda_practice | ExternalDemoFacade | fx-feed offline; script exit 2 | credentials | BLOCKED_EXTERNAL_TEST | adapters READY only with practice keys | WS3 |
| C41 | Reconciliation | reconcile.ts | worker | reconcile + alerts-ack | n/a | PARTIAL | ACK vs resolve covered offline | WS9 |
| C42 | Secure ops / live gate | execution-gate.ts | API/worker | execution-gate.test | n/a | VERIFIED_OFFLINE | — | — |
| C43 | Versioned config/provenance stamps | strategyVersionStamp | store fills | active-strategy.test | n/a | VERIFIED_OFFLINE | multi-artifact hash on all paths | — |

## Gate D — UX, ops, verification (44–58)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D44 | Opportunity funnel | OpportunityFunnelEvent | worker+terminal | funnel.test | n/a | VERIFIED_OFFLINE | — | — |
| D45 | Command centre overview | terminal overview + FIXTURE banner | web | manual | n/a | PARTIAL | readiness fields incomplete | WS10 |
| D46 | Multi-market controls | partial terminal | web/api | — | n/a | PARTIAL | — | WS10 |
| D47 | Positions panel depth | positions + protection read | terminal.service | — | n/a | PARTIAL | durable protection fields incomplete | WS6/WS10 |
| D48 | Strategy/ops controls UI | engine control API | web | — | n/a | PARTIAL | — | WS10 |
| D49 | Risk settings/diagnostics | risk-section env fields | terminal | — | n/a | PARTIAL | mode/origin must stay honest | WS10 |
| D50 | Durable alerts | DurableAlert | worker+API | alerts-ack.test | n/a | PARTIAL | ACK≠safety resolve covered | WS9 |
| D51 | Scheduling | BullMQ processors | worker | integration | n/a | PARTIAL | multi-worker concurrency | — |
| D52 | Observability | ObservabilityEvent | analytics | — | n/a | PARTIAL | — | — |
| D53 | Infra migrations | `20261028240000_mvp_durable_authority_isolation` | db:deploy | applied odin+odin_test | n/a | VERIFIED_OFFLINE | — | WS5/WS6 |
| D54 | Unit/contract tests | vitest suite | CI | pnpm test 195 pass / 1 skip | n/a | PARTIAL | map continues to deepen | verify |
| D55 | Fault-injection | fault-injection.test | unit | tests | n/a | PARTIAL | durable crash/restart races TBD | WS5/WS6 |
| D56 | Multi-market E2E | multi-market.e2e.test | in-process | e2e | n/a | PARTIAL | still largely fixture-shaped | WS2 |
| D57 | Load/capacity | load-capacity.report | in-process ledger | report | n/a | PARTIAL | 50 slots ≠ prod-shaped | capacity |
| D58 | Runbooks/handoff | RUNBOOKS/HANDOFF/EVIDENCE | docs | — | n/a | VERIFIED_OFFLINE | must stay synced to HEAD | delivery |

---

## Required verification suite (18 items)

Track separately; each needs command + result in `EVIDENCE.md`.

1. Engine regressions (Gate A) — pass
2. Fixture isolation — pass
3. Named provider contract tests — pass
4. Credentialed provider script — BLOCKED_EXTERNAL_TEST exit 2
5. PG concurrent admission (≥2 workers) — pass
6. Reservation adversarial — pass
7. Durable stop failure → retry/unresolved — pass (lifecycle + worker retry hook)
8. Long + short protection lifecycle — pass
9. Concurrent OCO race (2 workers) — PARTIAL (claim path unit; multi-worker harness depth TBD)
10. Partial close + rejected stop — pass (lifecycle tests)
11. Failed amendment / trailing restart — PARTIAL
12. Pause-new-entries keeps exits; flatten incomplete — pass (gate-a + evaluateRisk)
13. Alert ACK ≠ resolve safety suspension — pass
14. ≥3 concurrent strategy instances — pass (library + worker seed/evaluate/allocate)
15. FX sessions/DST/minima — PARTIAL (sessions.test; DST incomplete)
16. Replay/runtime parity — PARTIAL
17. External manual position policy — documented (refuse fake LIVE)
18. Normal paper never fills fixtures — pass (isolation tests)

## Notes on prior matrix inflation

Prior `DONE 34` treated helper libraries and fixture DEMO ingest as production-complete. Rows above reclassify those as `PARTIAL` until runtime call-site evidence exists.
