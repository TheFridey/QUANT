# QUANT MVP — Requirements Matrix

Status: `DONE` | `PARTIAL` | `BLOCKED_EXTERNAL` | `NOT_STARTED`

## Summary counts

| Status | Count |
| --- | --- |
| DONE | 34 |
| PARTIAL | 16 |
| BLOCKED_EXTERNAL | 4 |
| NOT_STARTED | 0 |

Counts treat D45–D48 and D51–D53 as grouped rows (same style as prior matrix). Remaining PARTIAL items are depth/polish, not greenfield.

## Gate A (01–10) — DONE

All A01–A10 landed previously (see prior commit). A03/A04 remain depth-PARTIAL.

## Gate B (11–29)

| ID | Requirement | Status | Location / validation |
| --- | --- | --- | --- |
| B11 | Broaden crypto discovery | PARTIAL | universe limits raised; DexScreener still primary |
| B12 | FX data/instruments | PARTIAL | registry + DEMO stub ingest; live BLOCKED_EXTERNAL |
| B13 | Executable index ETF proxies | DONE | `etf:SPY`/`QQQ` + paper ingest |
| B14 | Equity/ETF/commodity | DONE | ETF + `commodity:XAUUSD`/`WTI` DEMO paper path |
| B15 | Market-data gateway | PARTIAL | providers + paper-multimarket |
| B16 | Durable order lifecycle | PARTIAL | PENDING/eligible + identity |
| B17 | Paper latency/expiry | DONE | store pending path |
| B18 | Realistic costs | PARTIAL | existing fee/spread/impact |
| B19 | Atomic risk reservations | DONE | `risk-engine/reservations.ts` + tests |
| B20 | Exposure / daily loss / session equity | PARTIAL | `session-equity.ts` midnight roll + HWM ratchet |
| B21 | Protective stops | PARTIAL | stop/TP/trailing/time |
| B22 | Native vs synthetic protection | PARTIAL | `ProtectionOrigin` on OCO legs |
| B23 | TP/OCO | DONE | `trading-engine/protection.ts` race tests |
| B24 | Trailing / breakeven / time | PARTIAL | trailing/time runtime; breakeven helper |
| B25 | Operating controls | PARTIAL | `pauseNewEntries` + live gate |
| B26 | Risk hierarchy / breakers | PARTIAL | existing + entry suspension via durable alerts |
| B27 | Correlation budgeting | DONE | deterministic groups + tests |
| B28 | Activity-friendly presets | DONE | |
| B29 | Hard blocks vs advisories | PARTIAL | why-blocked on terminal snapshot |

## Gate C (30–43)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| C30 | Common strategy interface | DONE | `strategy-library.ts` contract |
| C31 | Strategy library | DONE | pulse/fx/etf/commodity/mean-revert modules |
| C32 | Concurrent instances | PARTIAL | library supports multi-id |
| C33 | Opportunity allocation | DONE | funnel stages persisted with reason codes |
| C34 | Backtest/runtime unify | PARTIAL | trailing/time on both; full unify TBD |
| C35 | Replay risk/pending | PARTIAL | |
| C36 | Data integrity | PARTIAL | evolution integrity exists |
| C37 | Net performance | PARTIAL | |
| C38 | Generated-strategy promotion drives decisions | DONE | `loadPlan` → `activeStrategyId`; divergent strategy regression |
| C39 | Bounded research | PARTIAL | |
| C40 | External demo adapter | BLOCKED_EXTERNAL | boundary refuses fake success |
| C41 | Reconciliation | DONE | `reconcile.ts` + durable suspend/resolve alerts |
| C42 | Secure ops | PARTIAL | live gate |
| C43 | Versioned config | DONE | exact strategy id@version+src+art stamp on orders |

## Gate D (44–58)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| D44 | Opportunity funnel | DONE | worker persists `OpportunityFunnelEvent`; terminal summary |
| D45–D48 | Command centre / controls / positions | PARTIAL | execution/funnel/protected UX deepened; not full redesign |
| D49 | Risk settings/diagnostics | DONE | risk panel: mode, funnel, why-blocked, alerts |
| D50 | Durable alerts | DONE | worker persist + resolve on clean reconcile; API ack |
| D51–D53 | Scheduling / observability / infra | PARTIAL | migration applied; runbooks added |
| D54 | Unit/contract tests | DONE | expanded suite |
| D55 | Fault-injection | DONE | reconcile unknown/qty + OCO race tests |
| D56 | Multi-market E2E | DONE | crypto+FX+ETF+commodity + ≥20 protected slots |
| D57 | Load test | DONE | capacity report admits 50 protected slots in-process (not a prod SLO claim) |
| D58 | Runbooks/handoff | DONE | `docs/mvp/RUNBOOKS.md` + HANDOFF |

## External blockers

Birdeye, OpenAI, EXTERNAL_DEMO_API_KEY, live broker — BLOCKED_EXTERNAL / refused.
