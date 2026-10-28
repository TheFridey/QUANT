# QUANT MVP — Requirements Matrix

Status: `DONE` | `PARTIAL` | `BLOCKED_EXTERNAL` | `NOT_STARTED`

Never mark external adapter complete from fixture alone.

## Summary counts

| Status | Count |
| --- | --- |
| DONE | 14 |
| PARTIAL | 12 |
| BLOCKED_EXTERNAL | 4 |
| NOT_STARTED | 28 |

## Gate A (01–10)

| ID | Requirement | Status | Location | Validation | Remaining |
| --- | --- | --- | --- | --- | --- |
| A01 | Baseline SHA + architecture map + test inventory | DONE | `docs/mvp/EVIDENCE.md` | HEAD baseline `0689e33` | — |
| A02 | MVP capability matrix | DONE | this file | manual | keep updated |
| A03 | Integration strategy notes | PARTIAL | DECISIONS + EVIDENCE | — | deepen provider docs |
| A04 | Freeze domain contracts | PARTIAL | `packages/shared` | `pnpm typecheck` | evolve carefully |
| A05 | Instrument registry (FX, ETF proxies, indices research-only) | DONE | `instruments.ts` | `instruments.test.ts` | live FX feed BLOCKED_EXTERNAL |
| A06 | Monetary / FX accounting helpers | DONE | `money.ts` `convertToUsd` | `money.test.ts` | more currencies |
| A07 | Fix $100/$5/5% deadlock; no round-up through risk | DONE | `strategy.ts` `size.ts` `plan.ts` | `gate-a.regression` `size.test` | — |
| A08 | Discovery ≠ held monitoring; flatten survival | DONE | `stage-runner.ts` | `gate-a.regression` | — |
| A09 | Observation history latest window + eligibility event time | DONE | `stage-runner` `store.ts` | regression + pending tests | — |
| A10 | Freshness + market sessions | DONE | `sessions.ts` | `sessions.test.ts` | holiday calendar |

## Gate B (11–29)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| B11 | Broaden crypto discovery | PARTIAL | still DexScreener-centred; limits raised |
| B12 | FX data/instruments | PARTIAL | FX registry + stub DEMO feed; live BLOCKED_EXTERNAL |
| B13 | Executable index products (ETF proxies) | DONE | `etf:SPY` `etf:QQQ` PAPER_SPOT; indices RESEARCH_ONLY |
| B14 | Equity/ETF/commodity registry | PARTIAL | ETF done; commodity stub not started |
| B15 | Market-data gateway | PARTIAL | provider interface + FX/index/external adapters |
| B16 | Durable order lifecycle | PARTIAL | PENDING/eligible/expire + identity columns |
| B17 | Paper latency/expiry | PARTIAL | planner+store honour eligibleAt |
| B18 | Realistic costs | PARTIAL | existing fee/spread/impact |
| B19 | Atomic risk reservations | NOT_STARTED | |
| B20 | Exposure / daily loss accounting | PARTIAL | sessionStartEquity column + equity delta; midnight/HWM TBD |
| B21 | Protective stops | PARTIAL | stop/TP/trailing/time on PULSE path |
| B22 | Venue-native protection + fallback | NOT_STARTED | |
| B23 | TP / OCO | NOT_STARTED | |
| B24 | Trailing / breakeven / time exits | PARTIAL | trailing+time on runtime; breakeven TBD |
| B25 | Operating controls | PARTIAL | engine machine + live gate |
| B26 | Risk hierarchy / breakers | PARTIAL | existing circuit breaker |
| B27 | Correlation budgeting | NOT_STARTED | |
| B28 | Activity-friendly presets | DONE | $10k start, 8 pos, 24 universe, min $25 |
| B29 | Hard blocks vs advisories | PARTIAL | AEGIS + live gate |

## Gate C (30–43)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| C30–C39 | Strategy interface / library / promotion / research | PARTIAL / NOT_STARTED | promotion loads config params; decision code still hard-coded PULSE |
| C40 | External demo adapter boundary | BLOCKED_EXTERNAL | `external-demo.ts` refuses without creds; no fake success |
| C41 | Reconciliation | NOT_STARTED | |
| C42 | Secure ops boundary | PARTIAL | models can't submit live; gate enforced |
| C43 | Versioned config | PARTIAL | strategyVersion stamped on orders |

## Gate D (44–58)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| D44–D58 | Funnel, UX, E2E ≥20 pos / 3 classes, load, runbooks | NOT_STARTED / PARTIAL docs | |

## External blockers

| Item | Status | Setup |
| --- | --- | --- |
| Birdeye | BLOCKED_EXTERNAL | `BIRDEYE_API_KEY` |
| Hosted LLM | BLOCKED_EXTERNAL | `OPENAI_API_KEY` / Hermes |
| External FX/broker sandbox | BLOCKED_EXTERNAL | `EXTERNAL_DEMO_API_KEY` (+ base URL) |
| Live money | intentionally refused | no broker adapter in MVP |

## Regression scenarios (progress)

| # | Scenario | Status |
| --- | --- | --- |
| 1 | Min-order vs risk cap | DONE (`size.test` / gate-a) |
| 2 | Held exit off discovery | DONE |
| 3 | History latest window | DONE (stage-runner) |
| 4 | Pending eligibility | DONE (plan + store) |
| 5 | In-cycle capacity release | DONE |
| 6 | Trailing / time parity | DONE (pulse) |
| 7 | Live gate server-side | DONE (`execution-gate.test`) |
| 8 | FX conversion fail-closed | DONE (`money.test`) |
| 9 | Index not executable | DONE (instruments) |
| 10 | Session/weekend | DONE (`sessions.test`) |
| 11 | No fake external success | DONE (`fx-feed.test`) |
| 12–28 | Remaining suite | NOT_STARTED |
