# HORIZON Phase II: incremental rollout

> **Superseded (17 Nov 2026)** by OPERATION AURUM (gold-only spread-bet simulation): see [`docs/aurum/README.md`](../../aurum/README.md). Kept as history; the multi-market execution roadmap is not being pursued.

Each step needs its own operator approval and is reversible by a flag. No step deploys, activates or changes limits without that approval. PAPER throughout.

## 0. Before anything (operator decisions)

1. **Account drawdown latch (B15).** `primary` is at 30.13% drawdown against a 30% limit, so every new BUY is refused. The agent will not loosen the limit. Options for the operator:
   - (a) leave it latched, so Solana stays exit-only in practice;
   - (b) open a fresh paper account or re-base for a new evaluation period, through the existing paper-balance path, keeping the history;
   - (c) run non-crypto evaluation on a separate isolated paper account so its results never mix with Solana's.

   Recommended: (c), plus a decision on (a)/(b) for Solana.
2. **Retention (O1).** The database grows about 0.75 GB a day; 49 GB is free. Decide a policy, e.g. archive `AgentDecision` older than 30 days to dumps, before adding non-crypto ingest.
3. **Legacy trial declaration (F03-H).** Answer the questionnaire before any Phase II campaign.

## Steps

| Step | What | Paths | Approval | Flag / rollback | Exit criterion |
| --- | --- | --- | --- | --- | --- |
| R0 | Merge this branch (pure functions, session fixes, docs) | unprotected | merge approval | revert | CI green |
| R1 | Registry: add XAG, AUD/USD, USD/CAD, Brent CFD, DIA, IWM as `enabledByDefault: false` and research-only; set real provider ids; a CFD product kind | `instruments.ts`, `product-semantics.ts`, `gateway.ts` | merge | revert | scanner shows them at REGISTERED/CONFIGURED |
| R2 | **Shadow ingest.** One batched OANDA pricing call and one Alpaca latest-quotes call per cycle, behind the circuit breaker. Persist rows with `dataOrigin = PROVIDER_REALTIME`, the `QuoteQuality` descriptor in `raw` and `dataState` unchanged (DEMO). Entries stay impossible. Read `multiMarketPaperIngest` for real, or replace it | worker, `observation-origin.ts`, `held-refresh.ts` | merge + operator flag | flag off | 7 days: zero non-crypto orders; per-instrument qualified-quote rate and spread distribution reported; DB growth measured |
| R3 | Data backfill and the campaigns in `RESEARCH-PLAN.md` | CLI | operator runs | none needed | campaign results recorded, whatever they are |
| R4 | Protected A3, A1+A2 (merge inert, `paperEntryInstruments = []`) | protected | **protected approval** | list empty | safety review APPROVE |
| R5 | Protected A7, A4+A8, A6 | protected | **protected approval** | list empty | Solana replay byte-identical |
| R6 | Isolated paper account: deterministic forced-signal lifecycle per asset class **in the test database only** | tests | merge | — | acceptance matrix rows 1–19 PASS |
| R7 | Enable EUR/USD paper entries on the isolated account, **only if** a campaign produced a validated candidate and shadow evidence met its bar | config | **activation approval** | remove from list | 30 days soak; costs and P&L reconciled |
| R8 | SPY/QQQ (RTH only), then XAU; USD/JPY after A5 and the weekend decision | config / protected A5 | per instrument | remove from list | as R7 |

If R3 yields no candidate, the rollout stops at R6. QUANT is then *capable* of multi-asset paper trading, and correctly abstains.
