# QUANT MVP — Acceptance Scenarios (stages 01–58)

**Baseline commit:** `05143f1d8f1941a0377737490f3ad40285532e57`  
**Method:** Implementation completeness is separate from verification. Statuses below are mechanical.

Allowed statuses: `NOT_STARTED` | `IMPLEMENTING` | `PARTIAL` | `IMPLEMENTED_UNVERIFIED` | `VERIFIED_OFFLINE` | `VERIFIED_EXTERNAL` | `BLOCKED_EXTERNAL_TEST`

Helper unit tests alone never promote a row to `VERIFIED_*` for a runtime path.

## Summary (recomputed from rows)

| Status | Count |
| --- | --- |
| NOT_STARTED | see matrix after edits |
| IMPLEMENTING | — |
| PARTIAL | — |
| IMPLEMENTED_UNVERIFIED | — |
| VERIFIED_OFFLINE | — |
| VERIFIED_EXTERNAL | — |
| BLOCKED_EXTERNAL_TEST | — |

Update counts after each coherent increment. Do not group stages to inflate DONE.

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

| ID | Original requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B11 | Broaden crypto discovery | dexscreener universe | observe | dexscreener.test | live DexScreener | PARTIAL | still boost+WSOL primary | — |
| B12 | FX data/instruments | instruments + providers | observe/providers | fx-feed.test | named provider | PARTIAL→IMPLEMENTING | stub/fixture historically mixed into paper | WS2/WS3 |
| B13 | Executable index ETF proxies | etf:SPY/QQQ | paper path | instruments.test | delayed feed | PARTIAL | fixture levels ≠ market-driven | WS4 |
| B14 | Equity/ETF/commodity semantics | commodity seeds | paper path | multi-market tests | — | PARTIAL | multipliers/currency incomplete | WS4 |
| B15 | Market-data gateway | market-provider + adapters | observe | provider tests | — | PARTIAL | readiness/provenance incomplete | WS3 |
| B16 | Durable order lifecycle | Order model + store | executor | pending tests | — | PARTIAL | venue ack path missing | C40 |
| B17 | Paper latency/expiry | eligibleAt/expiresAt | store | store.pending.test | n/a | VERIFIED_OFFLINE | — | — |
| B18 | Realistic market-specific costs | fill fee/slippage | fill path | fill.test | — | PARTIAL | DEX impact still applied broadly | WS4 |
| B19 | Atomic risk reservations | ReservationLedger + PG authority | admission routes | reservations.test + pg race | n/a | PARTIAL→IMPLEMENTING | prior: in-memory only; table unused by worker | WS5 |
| B20 | Exposure / daily loss / session equity | session-equity.ts | stage-runner | session-equity.test | n/a | PARTIAL | midnight+HWM present; full MTM TBD | — |
| B21 | Protective stops | protection helpers | **not fully in worker** | protection.test | n/a | PARTIAL | long-only helper; no durable worker lifecycle | WS6 |
| B22 | Native vs synthetic protection | ProtectionOrigin type | schema + helper | protection.test | n/a | PARTIAL | venue-native not wired | C40 |
| B23 | TP/OCO | evaluateOco | helper only | protection + fault tests | n/a | PARTIAL | not durable transactional claim path | WS6 |
| B24 | Trailing / breakeven / time | helpers + pulse params | pulse/backtest | unit | n/a | PARTIAL | peak/trough persist incomplete | WS6 |
| B25 | Operating controls pause/flatten | pauseNewEntries + flatten | engine control | tests | n/a | PARTIAL | exits must stay active when paused | WS6/WS9 |
| B26 | Risk hierarchy / breakers | evaluate + alerts | risk path | evaluate.test | n/a | PARTIAL | ACK≠resolve suspension | WS9 |
| B27 | Correlation budgeting | correlation.ts | evaluate | correlation.test | n/a | VERIFIED_OFFLINE | not yet on all admission routes | B19 |
| B28 | Activity-friendly presets | DEFAULT_STRATEGY | bootstrap | strategy tests | n/a | VERIFIED_OFFLINE | — | — |
| B29 | Hard blocks vs advisories | reasons + terminal why-blocked | terminal | terminal UX | n/a | PARTIAL | UNKNOWN≠pass for Solana security only | WS9 |

## Gate C — Strategies, replay, external (30–43)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C30 | Common strategy interface | strategy-library.ts | planCycle | library.test | n/a | VERIFIED_OFFLINE | — | — |
| C31 | Strategy library modules | pulse/fx/etf/commodity/mean-revert | activeStrategy | library.test | n/a | VERIFIED_OFFLINE | consolidation incomplete | WS8 |
| C32 | Concurrent strategy instances | library multi-id | **no durable StrategyInstance worker** | unit | n/a | PARTIAL | need durable instances + netting | WS7 |
| C33 | Opportunity allocation | funnel.ts | executor persist | funnel.test | n/a | PARTIAL | fairness/exit priority incomplete | WS7 |
| C34 | Backtest/runtime unify | trailing/time partial | pulse vs engine | tests | n/a | PARTIAL | shared clock/rules TBD | WS8 |
| C35 | Replay risk/pending | DATA_MODE=replay | observe copy | — | n/a | PARTIAL | isolated REPLAY account TBD | WS2/WS8 |
| C36 | Data integrity | evolution integrity | research | integrity tests | n/a | PARTIAL | — | — |
| C37 | Net performance attribution | analytics | reports | performance.test | n/a | PARTIAL | instance-level attribution missing | WS7 |
| C38 | Promoted strategy drives decisions | activeStrategy → plan | loadPlan | active-strategy.test | n/a | VERIFIED_OFFLINE | generated code isolation incomplete | WS8 |
| C39 | Bounded research | autonomy/oracle limits | evolution | oracle tests | n/a | PARTIAL | sandbox env dependent | — |
| C40 | Named external demo adapter | ExternalDemoAdapter was placeholder | — | refuses even with key | credentials | BLOCKED_EXTERNAL_TEST | must implement named adapter first | WS3 |
| C41 | Reconciliation | reconcile.ts | worker | reconcile.test | n/a | PARTIAL | ACK vs resolve | WS9 |
| C42 | Secure ops / live gate | execution-gate.ts | API/worker | execution-gate.test | n/a | VERIFIED_OFFLINE | — | — |
| C43 | Versioned config/provenance stamps | strategyVersionStamp | store fills | active-strategy.test | n/a | VERIFIED_OFFLINE | multi-artifact hash on all paths | — |

## Gate D — UX, ops, verification (44–58)

| ID | Requirement | Code | Runtime | Offline | External | Status | Residual | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D44 | Opportunity funnel | OpportunityFunnelEvent | worker+terminal | funnel.test | n/a | VERIFIED_OFFLINE | — | — |
| D45 | Command centre overview | terminal overview | web | manual | n/a | PARTIAL | fixture banner / readiness | WS10 |
| D46 | Multi-market controls | partial terminal | web/api | — | n/a | PARTIAL | — | WS10 |
| D47 | Positions panel depth | positions + protection read | terminal.service | — | n/a | PARTIAL | durable protection fields incomplete | WS6/WS10 |
| D48 | Strategy/ops controls UI | engine control API | web | — | n/a | PARTIAL | — | WS10 |
| D49 | Risk settings/diagnostics | risk-section | terminal | — | n/a | PARTIAL | mode/origin must be honest | WS10 |
| D50 | Durable alerts | DurableAlert | worker+API | tests | n/a | PARTIAL | ACK≠safety resolve | WS9 |
| D51 | Scheduling | BullMQ processors | worker | integration | n/a | PARTIAL | multi-worker concurrency | — |
| D52 | Observability | ObservabilityEvent | analytics | — | n/a | PARTIAL | — | — |
| D53 | Infra migrations | prisma migrations | db:deploy | — | n/a | PARTIAL | additive durable authority migration | WS5/WS6 |
| D54 | Unit/contract tests | vitest suite | CI | pnpm test | n/a | PARTIAL | must map to scenarios | verify |
| D55 | Fault-injection | fault-injection.test | unit | tests | n/a | PARTIAL | durable crash/restart races TBD | WS5/WS6 |
| D56 | Multi-market E2E | multi-market.e2e.test | in-process | e2e | n/a | PARTIAL | used fixtures + in-memory OCO | WS2 |
| D57 | Load/capacity | load-capacity.report | in-process ledger | report | n/a | PARTIAL | 50 slots ≠ prod-shaped | capacity |
| D58 | Runbooks/handoff | RUNBOOKS/HANDOFF | docs | — | n/a | PARTIAL | must match final reality | delivery |

---

## Required verification suite (18 items)

Track separately; each needs command + result in `EVIDENCE.md`.

1. Engine regressions (Gate A)
2. Fixture isolation (no cross-account contamination)
3. Named provider contract tests (sanitised)
4. Credentialed provider script (or BLOCKED_EXTERNAL_TEST + exact setup)
5. PG concurrent admission (≥2 workers)
6. Reservation adversarial (double/over/negative release)
7. Durable stop failure → retry/unresolved
8. Long + short protection lifecycle
9. Concurrent OCO race (2 workers)
10. Partial close + rejected stop
11. Failed amendment / trailing restart
12. Pause-new-entries keeps exits; flatten incomplete
13. Alert ACK ≠ resolve safety suspension
14. ≥3 concurrent strategy instances (crypto/FX/index)
15. FX sessions/DST/minima
16. Replay/runtime parity
17. External manual position policy
18. Normal paper never fills fixtures + multi-market lifecycle with losses/no-signal

## Notes on prior matrix inflation

Prior `DONE 34` treated helper libraries and fixture DEMO ingest as production-complete. Rows above reclassify those as `PARTIAL` until runtime call-site evidence exists.
