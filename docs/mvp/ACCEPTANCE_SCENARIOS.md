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
| PARTIAL | 21 |
| IMPLEMENTED_UNVERIFIED | 0 |
| VERIFIED_OFFLINE | 36 |
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
| B11 | Broaden crypto discovery | dexscreener profiles+search (+optional boosts) | observe | dexscreener.test (boosts optional) | live DexScreener | VERIFIED_OFFLINE | organic primary; live feed not claimed external | — |
| B12 | FX data/instruments | instruments + Frankfurter/OANDA | observe/providers | fx-feed.test | named provider | PARTIAL | holidays/DST; practice exec blocked | WS3 |
| B13 | Executable index ETF proxies | etf:SPY/QQQ + Alpaca | paper path | instruments + fx-feed | delayed feed | PARTIAL | fixture levels ≠ market-driven without Alpaca | WS4 |
| B14 | Equity/ETF/commodity semantics | product-semantics.ts + commodity seeds | cost-model + paper path | product-semantics + cost-model tests | — | PARTIAL | paper proxies OK; CL futures multiplier intentionally unsupported | WS4 |
| B15 | Market-data gateway | MarketDataGateway + named adapters | **worker observe FX ingest** | gateway.test | — | VERIFIED_OFFLINE | credentialed Alpaca/OANDA still blocked | WS3 |
| B16 | Durable order lifecycle | Order model + store | executor | pending tests | — | PARTIAL | venue ack path missing | C40 |
| B17 | Paper latency/expiry | eligibleAt/expiresAt | store | store.pending.test | n/a | VERIFIED_OFFLINE | — | — |
| B18 | Realistic market-specific costs | cost-model.ts (+ product semantics) | **fill path** | cost-model + parity tests | n/a | VERIFIED_OFFLINE | DEX impact still for Solana | WS4 |
| B19 | Atomic risk reservations | PostgresReservationAuthority + reserveInTx | **worker executor admission** | reservations + pg race | n/a | VERIFIED_OFFLINE | — | WS5 |
| B20 | Exposure / daily loss / session equity | rollSessionEquity | **worker loadPlan persist** | session-equity.test | n/a | VERIFIED_OFFLINE | full MTM marks still incomplete on gaps | — |
| B21 | Protective stops | protection + lifecycle + recover | **worker arm/evaluate/retry/recover** | protection-crash.test | n/a | VERIFIED_OFFLINE | venue-native ACK still external-blocked | WS6 |
| B22 | Native vs synthetic protection | venue-protection.ts + ackState | schema + Alpaca/OANDA helpers | venue-protection.test | n/a | PARTIAL | desired→ACK offline; credentialed ACK blocked | C40 |
| B23 | TP/OCO | claimOcoTriggerInTx + armLongShortOco | worker evaluateProtections | protection-crash 2-worker race | n/a | VERIFIED_OFFLINE | — | WS6 |
| B24 | Trailing / breakeven / time | exit-rules + updateTrailing persist | **worker evaluateProtections** | parity + exit-rules | n/a | VERIFIED_OFFLINE | trail only when trailingStopPct configured | WS6 |
| B25 | Operating controls pause/flatten | PAUSE_NEW_ENTRIES / FLATTEN gates | evaluateRisk + plan | operating-controls.test | n/a | VERIFIED_OFFLINE | — | WS6/WS9 |
| B26 | Risk hierarchy / breakers | evaluate + alerts | risk path | evaluate.test | n/a | PARTIAL | ACK≠resolve suspension covered; depth TBD | WS9 |
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
| C36 | Data integrity | evolution integrity | research | integrity tests | n/a | PARTIAL | — | — |
| C37 | Net performance attribution | analytics | reports | performance.test | n/a | PARTIAL | instance-level attribution missing | WS7 |
| C38 | Promoted strategy drives decisions | activeStrategy → plan | loadPlan | active-strategy.test | n/a | VERIFIED_OFFLINE | generated code isolation incomplete | WS8 |
| C39 | Bounded research | autonomy/oracle limits | evolution | oracle tests | n/a | PARTIAL | sandbox env dependent | — |
| C40 | Named external demo adapter | alpaca_paper + oanda_practice | ExternalDemoFacade | fx-feed offline; script exit 2 | credentials | BLOCKED_EXTERNAL_TEST | adapters READY only with practice keys | WS3 |
| C41 | Reconciliation | reconcile + position qty enrich | **worker reconcileAndAlert** | fault-injection + alerts-ack | n/a | VERIFIED_OFFLINE | external broker truth still paper self-truth | WS9 |
| C42 | Secure ops / live gate | execution-gate.ts | API/worker | execution-gate.test | n/a | VERIFIED_OFFLINE | — | — |
| C43 | Versioned config/provenance stamps | strategyVersionStamp | store fills | active-strategy.test | n/a | VERIFIED_OFFLINE | multi-artifact hash on all paths | — |

## Gate D — UX, ops, verification (44–58)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D44 | Opportunity funnel | OpportunityFunnelEvent | worker+terminal | funnel.test | n/a | VERIFIED_OFFLINE | — | — |
| D45 | Command centre overview | overview + FIXTURE/REPLAY banners + unresolved + readiness | web | manual | n/a | PARTIAL | not a full redesign | WS10 |
| D46 | Multi-market controls | settings multi-market panel | web | settings-section | n/a | VERIFIED_OFFLINE | operator toggles still API/engine | WS10 |
| D47 | Positions panel depth | confirmed vs helper + ackState | terminal.service + positions-section | — | n/a | PARTIAL | venue ACK still offline-only | WS6/WS10 |
| D48 | Strategy/ops controls UI | engine control API + risk unresolved actions | web | — | n/a | PARTIAL | — | WS10 |
| D49 | Risk settings/diagnostics | risk-section env + provider readiness | terminal | — | n/a | PARTIAL | mode/origin must stay honest | WS10 |
| D50 | Durable alerts | DurableAlert | worker+API | alerts-ack.test | n/a | PARTIAL | ACK≠safety resolve covered | WS9 |
| D51 | Scheduling | BullMQ processors | worker | integration | n/a | PARTIAL | multi-worker concurrency | — |
| D52 | Observability | ObservabilityEvent + worker persist | **worker complete + terminal** | observability.test | n/a | VERIFIED_OFFLINE | category coverage still expanding | — |
| D53 | Infra migrations | `20261029070000` + prior | db:deploy | migration-schema.test | n/a | VERIFIED_OFFLINE | — | WS5/WS6 |
| D54 | Unit/contract tests | vitest suite | CI | pnpm test 239 pass / 1 skip | n/a | PARTIAL | map continues to deepen | verify |
| D55 | Fault-injection | fault-injection + protection-crash | unit + PG | protection-crash.test | n/a | VERIFIED_OFFLINE | broader infra faults still TBD | WS5/WS6 |
| D56 | Multi-market E2E | multi-market.e2e.test | in-process | e2e | n/a | PARTIAL | still largely fixture-shaped | WS2 |
| D57 | Load/capacity | soak-capacity.mjs + load-capacity.report | PG reservation/OCO path | soak exit 0 fixture_shaped | n/a | PARTIAL | real PG path; not live-feed SLO | capacity |
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
15. FX sessions/DST/minima — PARTIAL (sessions.test; DST incomplete)
16. Replay/runtime parity — pass offline (exit-rules parity + REPLAY metrics account isolation)
17. External manual position policy — documented (refuse fake LIVE)
18. Normal paper never fills fixtures — pass (isolation tests)

## Notes on prior matrix inflation

Prior `DONE 34` treated helper libraries and fixture DEMO ingest as production-complete. Rows above reclassify those as `PARTIAL` until runtime call-site evidence exists.
