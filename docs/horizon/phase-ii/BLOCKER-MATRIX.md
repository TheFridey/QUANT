# HORIZON Phase II: blocker matrix

Every blocker between a provider quote and a completed non-crypto paper trade, with type and owner. Citations are in [`CURRENT-STATE.md`](CURRENT-STATE.md) §3.

The **#** column matches the numbered list in CURRENT-STATE.md §3; B15 and B16 are added in this table.

**Types:**

- `UNPROTECTED`: the agent may change it, with tests.
- `PROTECTED`: needs the operator's unlock and approval, then an independent review.
- `ACTIVATION`: operator flag or config.
- `EXTERNAL`: provider or account.
- `EVIDENCE`: a research result, not code.
- `OPERATOR`: an operator decision.

| # | Blocker | Type | Owner | State after this branch |
| --- | --- | --- | --- | --- |
| B1 | No ingest path for OANDA/Alpaca quotes into `MarketObservation`; `multiMarketPaperIngest` unread | UNPROTECTED (worker) + ACTIVATION | agent, then operator | Open. Design in `ROLLOUT-PLAN.md` step R2 (shadow ingest, entries off) |
| B2 | Provider quotes classified `FIXTURE_SEQUENCE` and dropped | UNPROTECTED (`observation-origin.ts`, `held-refresh.ts`) | agent | Open. Fix together with B1: set an explicit `dataOrigin = PROVIDER_REALTIME` and persist the quality descriptor. Do **not** map it to `LIVE` |
| B3 | `QuoteQuality` not persisted | UNPROTECTED (worker; `raw` JSON needs no migration) | agent | Open, with B1 |
| B4 | Null liquidity, volume and change fields: SENTINEL hard-rejects, PULSE `INSUFFICIENT_DATA` | UNPROTECTED (`agent-core`) | agent | Open. Needs asset-class-aware SENTINEL rules that never fabricate DEX liquidity (`RESEARCH-PLAN.md` §3) |
| B5 | Planner liquidity gates and DEX-model `quoteFill` (C4) | UNPROTECTED path on the order route (`plan.ts`) plus PROTECTED `size.ts` | agent + operator | Open. Reviewed together with C3; see `PCR-2-REBASED.md` |
| B6 | Risk freshness refuses non-LIVE BUYs | PROTECTED (`risk-engine`) | operator | Decision function ready (`assessQuoteAdmission`, `78aa955`); wiring in `PROTECTED-APPROVAL.md` A1 |
| B7 | Settlement DEMO rule disagrees with risk | PROTECTED (`store.ts`) | operator | A2 |
| B8 | Pending fills need `eventTime ≥ eligibleAt` | PROTECTED (`eligible-observation.ts`) | operator | A3 (keeps the no-look-ahead rule; needs a fresh quote after `eligibleAt`) |
| B9 | 8 dp fills; tick, lot and multiplier unused | PROTECTED (`fill.ts`, `size.ts`, `money.ts`) | operator | A4 |
| B10 | No quote→USD conversion (USD/JPY books JPY as USD) | PROTECTED (`fill.ts`, `store.ts`, `ledger.ts`) | operator | A5 |
| B11 | Fixed spread estimates | PROTECTED (`cost-model.ts`) | operator | A6 |
| B12 | Missing non-crypto mark blocks every BUY account-wide | UNPROTECTED ingest (B1/B2) + PROTECTED valuation | operator | No change to the fail-closed rule. Mitigated by B1 making marks available |
| B13 | Universal 2% M5 threshold | UNPROTECTED (agent-core instance params) but `DEFAULT_STRATEGY` is protected | agent (research), operator (activation) | Research configs already per-market (`packages/backtest/src/research/market-config.ts:77-187`); paper modules unchanged |
| B14 | No validated positive edge after costs on any non-crypto market | EVIDENCE | research | NO_SKILL is the current, valid result |
| B15 | Account `primary` at 30.13% drawdown (limit 30%) | OPERATOR | operator | Every new BUY is refused. Not loosened. Options in `ROLLOUT-PLAN.md` §0 |
| B16 | Historical datasets end 30 Oct–6 Nov | UNPROTECTED (operator runs backfill) | operator | Refresh commands in `RESEARCH-PLAN.md` §4 |
| E1 | Alpaca IEX is single venue; SIP needs a paid plan | EXTERNAL | operator (purchase) | IEX quotes are honest `SINGLE_VENUE`; spread cap and session rules apply |
| E2 | OANDA practice transient network failures and 504s | EXTERNAL | — | Circuit breaker ready (`7bb86dd`), not wired |
| O1 | Retention for `AgentDecision`, `MarketObservation`, `CyclePlan` | OPERATOR + UNPROTECTED | operator decides policy | Open. Disk is 49 GB free; the database grows about 0.75 GB a day. Adding non-crypto ingest increases growth |

## Shortest path to a first non-crypto paper fill (EUR/USD, internal paper)

```
B1+B2+B3 (ingest, shadow)  →  B4 (SENTINEL rules)  →  A1+A2 (admission)  →  A3 (eligibility)
  →  A4+A6 (precision, costs)  →  B5/C4 (planner)  →  B14 evidence  →  B15 decision  →  operator flag
```

USD/JPY additionally needs A5 and a weekend-valuation decision. XAU/USD and WTI need A4 plus the CFD semantics (multiplier 1, spot proxy, never futures). SPY and QQQ need RTH-only entry plus the IEX spread cap.
