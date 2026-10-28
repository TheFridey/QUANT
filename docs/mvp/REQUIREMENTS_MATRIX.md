# QUANT MVP — Requirements Matrix

Status: `DONE` | `PARTIAL` | `BLOCKED_EXTERNAL` | `NOT_STARTED`

## Summary counts

| Status | Count |
| --- | --- |
| DONE | 28 |
| PARTIAL | 14 |
| BLOCKED_EXTERNAL | 4 |
| NOT_STARTED | 12 |

## Gate A (01–10) — DONE

All A01–A10 landed previously (see prior commit). A03/A04 remain depth-PARTIAL.

## Gate B (11–29)

| ID | Requirement | Status | Location / validation |
| --- | --- | --- | --- |
| B11 | Broaden crypto discovery | PARTIAL | universe limits raised; DexScreener still primary |
| B12 | FX data/instruments | PARTIAL | registry + DEMO stub ingest; live BLOCKED_EXTERNAL |
| B13 | Executable index ETF proxies | DONE | `etf:SPY`/`QQQ` + paper ingest |
| B14 | Equity/ETF/commodity | PARTIAL | ETF done; commodity not started |
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
| B26 | Risk hierarchy / breakers | PARTIAL | existing + entry suspension |
| B27 | Correlation budgeting | DONE | deterministic groups + tests |
| B28 | Activity-friendly presets | DONE | |
| B29 | Hard blocks vs advisories | PARTIAL | |

## Gate C (30–43)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| C30 | Common strategy interface | DONE | `strategy-library.ts` contract |
| C31 | Strategy library | DONE | pulse/fx/etf/mean-revert modules |
| C32 | Concurrent instances | PARTIAL | library supports multi-id |
| C33 | Opportunity allocation | PARTIAL | funnel stages |
| C34 | Backtest/runtime unify | PARTIAL | trailing/time on both; full unify TBD |
| C35 | Replay risk/pending | PARTIAL | |
| C36 | Data integrity | PARTIAL | evolution integrity exists |
| C37 | Net performance | PARTIAL | |
| C38 | Generated-strategy promotion drives decisions | PARTIAL | `evaluatePromotedStrategy` in PULSE when `activeStrategyId` set; default remains hard-coded PULSE |
| C39 | Bounded research | PARTIAL | |
| C40 | External demo adapter | BLOCKED_EXTERNAL | boundary refuses fake success |
| C41 | Reconciliation | DONE | `reconcile.ts` + unknown exposure suspend |
| C42 | Secure ops | PARTIAL | live gate |
| C43 | Versioned config | PARTIAL | strategyVersion on orders |

## Gate D (44–58)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| D44 | Opportunity funnel | PARTIAL | in-memory + Prisma table; API wiring TBD |
| D45–D48 | Command centre / controls / positions | PARTIAL | existing terminal; not redesigned |
| D49 | Risk settings/diagnostics | PARTIAL | |
| D50 | Durable alerts | PARTIAL | Prisma `DurableAlert` table |
| D51–D53 | Scheduling / observability / infra | PARTIAL | migration applied |
| D54 | Unit/contract tests | DONE | expanded suite |
| D55 | Fault-injection | PARTIAL | reconcile unknown exposure |
| D56 | Multi-market E2E | PARTIAL | `multi-market.e2e.test.ts` ≥3 classes + 20 protected slots |
| D57 | Load test | NOT_STARTED | |
| D58 | Runbooks/handoff | PARTIAL | docs/mvp |

## External blockers

Birdeye, OpenAI, EXTERNAL_DEMO_API_KEY, live broker — BLOCKED_EXTERNAL / refused.
