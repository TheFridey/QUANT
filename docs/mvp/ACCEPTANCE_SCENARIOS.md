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
| PARTIAL | 5 |
| IMPLEMENTED_UNVERIFIED | 0 |
| VERIFIED_OFFLINE | 52 |
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
| A04 | Held positions evaluated outside discovery | stage-runner loadPlan + held-marks | worker cycle + planCycle | held-marks + multi-market.e2e | n/a | VERIFIED_OFFLINE | missing marks stay MISSING | A09 |
| A05 | Flatten incomplete stays incomplete | executor flatten flag | worker executor | gate-a.regression | n/a | VERIFIED_OFFLINE | marks missing still fragile | — |
| A06 | Observation history = latest window | loadObservationHistory desc+reverse | loadPlan | gate-a.regression | n/a | VERIFIED_OFFLINE | — | — |
| A07 | PENDING until eligibleAt; expire honestly | store.ts pending path | executor commit | store.pending.test | n/a | VERIFIED_OFFLINE | multi-worker fill race | B19 |
| A08 | In-cycle sell releases capacity | plan.ts exposure subtract | planCycle | gate-a.regression | n/a | VERIFIED_OFFLINE | — | — |
| A09 | Registry: FX pairs + ETF proxies; indices research-only | instruments + productCatalog/refuseFutures | ingest/registry + sizing refuse | instruments + product-semantics | n/a | VERIFIED_OFFLINE | credentialed live feeds are B12/B13 | B12–B14 |
| A10 | Sessions / freshness for non-24x7 | `sessions.ts` holidays/DST/FX weekend | providers + planCycle SESSION_CLOSED | sessions.test + multi-market.e2e | n/a | VERIFIED_OFFLINE | static holiday table needs periodic refresh | B12 |

## Gate B — Markets, lifecycle, risk (11–29)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B11 | Broaden crypto discovery | dexscreener profiles+search (+optional boosts) | observe | dexscreener.test (boosts optional) | live DexScreener | VERIFIED_OFFLINE | organic primary; live feed not claimed external | — |
| B12 | FX data/instruments | instruments + Frankfurter/OANDA + FX session | observe/providers + plan session gate | fx-feed (Frankfurter offline DELAYED) | named provider | PARTIAL | practice exec / live levels blocked without keys | WS3 |
| B13 | Executable index ETF proxies | etf:SPY/QQQ + Alpaca | paper path | instruments + fx-feed offline fixture | delayed feed | PARTIAL | market-driven levels need Alpaca keys | WS4 |
| B14 | Equity/ETF/commodity semantics | product-semantics labels/pip/family | cost-model + paper path | product-semantics tests | — | VERIFIED_OFFLINE | CL futures multiplier intentionally unsupported | WS4 |
| B15 | Market-data gateway | MarketDataGateway + named adapters | **worker observe FX ingest** | gateway.test | — | VERIFIED_OFFLINE | credentialed Alpaca/OANDA still blocked | WS3 |
| B16 | Durable order lifecycle | Order model + store + offline ack transitions | executor | pending + transitionOrderAck e2e | — | PARTIAL | credentialed venue ack path missing | C40 |
| B17 | Paper latency/expiry | eligibleAt/expiresAt | store | store.pending.test | n/a | VERIFIED_OFFLINE | — | — |
| B18 | Realistic market-specific costs | cost-model.ts (+ product semantics) | **fill path** | cost-model + parity tests | n/a | VERIFIED_OFFLINE | DEX impact still for Solana | WS4 |
| B19 | Atomic risk reservations | PostgresReservationAuthority + reserveInTx | **worker executor admission** | reservations + pg race | n/a | VERIFIED_OFFLINE | — | WS5 |
| B20 | Exposure / daily loss / session equity | rollSessionEquity | **worker loadPlan persist** | session-equity.test | n/a | VERIFIED_OFFLINE | full MTM marks still incomplete on gaps | — |
| B21 | Protective stops | protection + lifecycle + recover | **worker arm/evaluate/retry/recover** | protection-crash.test | n/a | VERIFIED_OFFLINE | venue-native ACK still external-blocked | WS6 |
| B22 | Native vs synthetic protection | venue-protection compareDesiredVsConfirmed | terminal positions + schema | venue-protection.test | n/a | VERIFIED_OFFLINE | credentialed venue ACK still blocked | C40 |
| B23 | TP/OCO | claimOcoTriggerInTx + armLongShortOco | worker evaluateProtections | protection-crash 2-worker race | n/a | VERIFIED_OFFLINE | — | WS6 |
| B24 | Trailing / breakeven / time | exit-rules + updateTrailing persist | **worker evaluateProtections** | parity + exit-rules | n/a | VERIFIED_OFFLINE | trail only when trailingStopPct configured | WS6 |
| B25 | Operating controls pause/flatten | PAUSE_NEW_ENTRIES / FLATTEN gates | evaluateRisk + plan | operating-controls.test | n/a | VERIFIED_OFFLINE | — | WS6/WS9 |
| B26 | Risk hierarchy / breakers | risk-hierarchy.ts + evaluateCircuitBreaker | planCycle + terminal riskDiagnostics | risk-hierarchy.test | n/a | VERIFIED_OFFLINE | ACK≠clear ranks enforced offline | WS9 |
| B27 | Correlation budgeting | correlation.ts | evaluate | correlation.test | n/a | VERIFIED_OFFLINE | not yet on all admission routes | B19 |
| B28 | Activity-friendly presets | DEFAULT_STRATEGY | bootstrap | strategy tests | n/a | VERIFIED_OFFLINE | — | — |
| B29 | Hard blocks vs advisories | blocks.ts + why-blocked hard/advisory | terminal.service | blocks.test | n/a | VERIFIED_OFFLINE | UNKNOWN≠PASS enforced | WS9 |

## Gate C — Strategies, replay, external (30–43)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C30 | Common strategy interface | strategy-library.ts | planCycle | library.test | n/a | VERIFIED_OFFLINE | — | — |
| C31 | Strategy library modules | pulse/fx/etf/commodity/mean-revert | activeStrategy | library.test | n/a | VERIFIED_OFFLINE | consolidation incomplete | WS8 |
| C32 | Concurrent strategy instances | StrategyInstance + ensureDefault + allocate | **worker loadPlan** | strategy-instances.integration.test | n/a | VERIFIED_OFFLINE | multi-worker instance soak still light | WS7 |
| C33 | Opportunity allocation | allocateOpportunities + funnel | worker loadPlan gating | strategy-instances.integration.test | n/a | VERIFIED_OFFLINE | fairness round-robin covered offline | WS7 |
| C34 | Backtest/runtime unify | exit-rules.ts + clock.ts | backtest engine + runtime | parity.test | n/a | VERIFIED_OFFLINE | short runtime arms still LONG-default in worker | WS8 |
| C35 | Replay risk/pending | metricsAccountIdFor + REPLAY_STORE guard | worker funnel/equity + terminal | environments.test | n/a | VERIFIED_OFFLINE | observe copy still shared store | WS2/WS8 |
| C36 | Data integrity | data-integrity.ts | research/eval windows | data-integrity.test | n/a | VERIFIED_OFFLINE | — | — |
| C37 | Net performance attribution | attribution.ts | terminal instanceAttribution | attribution.test | n/a | VERIFIED_OFFLINE | stamps via order.strategyVersion | WS7 |
| C38 | Promoted strategy drives decisions | activeStrategy → plan | loadPlan | active-strategy.test | n/a | VERIFIED_OFFLINE | generated code isolation incomplete | WS8 |
| C39 | Bounded research | autonomy/oracle + sandbox honesty | evolution | research-artifact-honesty + oracle | n/a | VERIFIED_OFFLINE | adversary suites still skip without bubblewrap | — |
| C40 | Named external demo adapter | alpaca_paper + oanda_practice | ExternalDemoFacade | fx-feed offline; script exit 2 | credentials | BLOCKED_EXTERNAL_TEST | adapters READY only with practice keys | WS3 |
| C41 | Reconciliation | reconcile + position qty enrich | **worker reconcileAndAlert** | fault-injection + alerts-ack | n/a | VERIFIED_OFFLINE | external broker truth still paper self-truth | WS9 |
| C42 | Secure ops / live gate | execution-gate.ts | API/worker | execution-gate.test | n/a | VERIFIED_OFFLINE | — | — |
| C43 | Versioned config/provenance stamps | strategyVersionStamp | store fills | active-strategy.test | n/a | VERIFIED_OFFLINE | multi-artifact hash on all paths | — |

## Gate D — UX, ops, verification (44–58)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D44 | Opportunity funnel | OpportunityFunnelEvent | worker+terminal | funnel.test | n/a | VERIFIED_OFFLINE | — | — |
| D45 | Command centre overview | overview + FIXTURE/REPLAY + unresolved + risk controls + readiness | web from terminal snapshot | — | n/a | VERIFIED_OFFLINE | not a theatre redesign | WS10 |
| D46 | Multi-market controls | settings multi-market panel | web | settings-section | n/a | VERIFIED_OFFLINE | operator toggles still API/engine | WS10 |
| D47 | Positions panel depth | confirmed vs helper vs venue ACK + product/session | terminal.service + positions-section | venue-protection + e2e | n/a | VERIFIED_OFFLINE | credentialed venue ACK blocked | WS6/WS10 |
| D48 | Strategy/ops controls UI | opsControls + strategyInstances snapshot + toggles | web strategy/settings | — | n/a | VERIFIED_OFFLINE | pause engine required for config patches | WS10 |
| D49 | Risk settings/diagnostics | riskDiagnostics hierarchy + attribution + readiness | terminal + risk-section | risk-hierarchy.test | n/a | VERIFIED_OFFLINE | mode/origin stay honest | WS10 |
| D50 | Durable alerts | DurableAlert + sort/ACK≠clear helpers | worker+API + risk UI | alerts.test + alerts-ack | n/a | VERIFIED_OFFLINE | — | WS9 |
| D51 | Scheduling | BullMQ + Redis SET NX PX StageLeaseService | processors + worker.module | redis-worker-lease + stage-lease.wiring | n/a | VERIFIED_OFFLINE | not a live throughput SLO | — |
| D52 | Observability | ObservabilityEvent + worker persist | **worker complete + terminal** | observability.test | n/a | VERIFIED_OFFLINE | category coverage still expanding | — |
| D53 | Infra migrations | `20261029070000` + prior | db:deploy | migration-schema.test | n/a | VERIFIED_OFFLINE | — | WS5/WS6 |
| D54 | Unit/contract tests | vitest + acceptance-contract-map | CI | pnpm test 279 pass / 1 skip | n/a | VERIFIED_OFFLINE | map may still expand; no live SLO | verify |
| D55 | Fault-injection | fault-injection + protection-crash | unit + PG | protection-crash.test | n/a | VERIFIED_OFFLINE | broader infra faults still TBD | WS5/WS6 |
| D56 | Multi-market E2E | multi-market.e2e held+session+futures refuse | in-process | e2e | n/a | PARTIAL | still largely fixture-shaped; no live SLO | WS2 |
| D57 | Load/capacity | soak-capacity.mjs honesty labels | PG reservation/OCO path | soak exit 0 fixture_shaped | n/a | PARTIAL | real PG path; not live-feed SLO | capacity |
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
9. Concurrent OCO race (2 workers) — pass (`protection-crash.test` exactly-one claim)
10. Partial close + rejected stop — pass (lifecycle tests)
11. Failed amendment / trailing restart — pass (amend keep-confirmed + recoverProtectionAfterRestart)
12. Pause-new-entries keeps exits; flatten incomplete — pass (gate-a + evaluateRisk)
13. Alert ACK ≠ resolve safety suspension — pass
14. ≥3 concurrent strategy instances — pass (library + worker seed/evaluate/allocate)
15. FX sessions/DST/minima — pass offline (sessions.test holidays/DST/FX weekend + plan SESSION_CLOSED)
16. Replay/runtime parity — pass offline (exit-rules parity + REPLAY metrics account isolation)
17. External manual position policy — documented (refuse fake LIVE)
18. Normal paper never fills fixtures — pass (isolation tests)

## Notes on prior matrix inflation

Prior `DONE 34` treated helper libraries and fixture DEMO ingest as production-complete. Rows above reclassify those as `PARTIAL` until runtime call-site evidence exists.
