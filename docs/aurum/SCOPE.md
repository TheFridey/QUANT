# AURUM scope: GOLD_ONLY profile and legacy preservation

This document also serves as LEGACY-PRESERVATION; the two are merged to avoid duplication.

## 1. GOLD_ONLY profile (`packages/shared/src/aurum-scope.ts`)

- **State:** pure, unwired, `active: false`. Nothing in the order path calls it yet (PCR-AURUM-01 C1).
- **Admission is default-deny.** `assessAurumOrderScope` allows an order only when all of the following hold:
  - the instrument id is exactly `commodity:XAUUSD` (case-sensitive, no trimming);
  - the product id is the configured spread-bet product (`aurum-generic-gold-dfb-gbp-v1`);
  - the account is the profile's AURUM account. It is never `primary` or `primary:<env>`;
  - the action is one of `OPEN_LONG | OPEN_SHORT | REDUCE_LONG | REDUCE_SHORT | CLOSE_LONG | CLOSE_SHORT | CANCEL_ORDER`. A bare `BUY` or `SELL` is refused as `UNKNOWN_ACTION`;
  - for an opening action, the profile is active.
- **Exits and cancels stay available while inactive,** so a position can always be closed.
- **The profile validates itself.** Any of the following makes it `INVALID_PROFILE`, which refuses everything:
  - a second TRADEABLE instrument, including via the role table;
  - gold listed with a non-tradeable role;
  - a legacy account id;
  - a non-boolean `active`.

| Role | Meaning | Instruments (initial) |
| --- | --- | --- |
| TRADEABLE | may create AURUM positions (when active) | `commodity:XAUUSD` only |
| OBSERVATIONAL_ONLY | context for research and features; never executable | EUR/USD, GBP/USD, USD/JPY, SPY, QQQ, WTI |
| RESEARCH_ONLY | historical research, no live context | SPX, NDX, FTSE, DJI index levels |
| ARCHIVED | history preserved; nothing new in AURUM | Solana universe (all DEX pairs) |
| DISABLED | everything not listed (default) | Solana pair addresses, unknown ids |

Negative test (`aurum-scope.test.ts`): every combination of the 12 non-gold registry ids or Solana pair addresses with any of the 7 actions is refused with `INSTRUMENT_NOT_TRADEABLE`.

This test covers the decision function only. The integration proof, that the planner, admit and settle cannot create a non-gold AURUM order, needs the wiring in PCR-AURUM-01 and is **not done**.

**Hidden routes to close when wiring:**
- manual operator orders (API terminal);
- protection/flatten paths;
- the research-to-paper promotion path;
- the external-demo/sandbox venue;
- the contextual-data pipeline, whose observations must never carry an AURUM product id.

Each of these must call the same function; PCR-AURUM-01 C1 lists them.

## 2. What the AURUM profile turns off (proposed, not yet implemented)

These items are worker scheduling under the AURUM profile. None of them deletes code or data.

| Workload | Under AURUM | Reason |
| --- | --- | --- |
| DexScreener Solana discovery and polling | off | about 103 k observation rows per day for an archived scope |
| Crypto strategy instances (`pulse-momentum-v1*`, `mean-revert-fade-v1`) | not scheduled | not gold |
| Frankfurter FX, Alpaca ETF polling | off unless a pre-registered MACRO/Family J study needs them | no observational value without a study |
| OANDA XAU | shadow ingest (M1) | AURUM FEED |
| Legacy `primary` protective exits | **kept** | `primary` has 0 open positions (recorded 17 Nov); exits must stay possible if that changes |

Turning off Solana ingest changes what `primary` sees. Because `primary` is latched at 30.13% drawdown with no open positions, this is an operator decision, not an agent default (STATUS, decision D3).

## 3. Legacy account preservation

`primary` is the record of a failed experiment and stays visible.

**Never:**
- reset its HWM;
- delete or rewrite its orders, fills or ledger;
- top up its cash;
- clear its drawdown;
- reuse its ledger for AURUM;
- combine its results with AURUM in one aggregate.

Retention (STORAGE-PLAN) keeps every order, fill, position, ledger entry, equity snapshot and safety state, plus any decision, plan or observation tied to an order or intent.

**The AURUM account** is proposed below, pending approval. It is not created.

| Parameter | Proposed |
| --- | --- |
| Account id | `aurum` |
| Experiment id | immutable, e.g. `aurum-exp-001`, bound to the product spec id and the risk-config hash |
| Currency | GBP |
| Simulated starting equity | £10,000 |
| Risk per trade | 0.25% (≤ 0.5%) |
| Daily loss limit | 2% |
| Maximum drawdown | 10% (latching; no automatic reset) |
| Overnight and weekend exposure | disabled; flat before the 17:00 ET break and the Friday close |
| Instruments | gold only; long and short |
| Execution | internal simulation only |

**Restart rule:** a breach of the 10% drawdown ends the experiment, and the account stays visible. A new account needs a new experiment id, a written reason and operator approval. A new account is never a way to clear losses.
