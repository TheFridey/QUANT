# PCR-2 rebased onto current `main` (`873bdd6`)

[`../PCR-2-MULTI-ASSET-EXECUTION.md`](../PCR-2-MULTI-ASSET-EXECUTION.md) was written at `b8cb0ce` (5 Nov 2026), before PCR-1 merged. This file supersedes its "today" descriptions and line numbers. The intent of each item is unchanged. **No protected file is changed by this branch.**

## What changed since the original

| Original statement | Current code | Effect on PCR-2 |
| --- | --- | --- |
| "PCR-1 … draft, not applied; changes `store.ts`/`strategy-allocations.ts`" | Merged in #77 (deployed in `2cc6627`). Stamps and counters are in `store.ts:37-40,52-83,147-203`; the fence itself is in `apps/worker/src/executor/settle.ts:69-129` and `packages/shared/src/position-lot.ts:76-146` | C3 must re-prove the fence in `position-lot.ts`, not only in `store.ts` |
| "No PCR-2 change may alter PCR-1's lock scope" | The lock is a row lock, `SELECT … FROM "PaperAccount" … FOR UPDATE` (`store.ts:43-45`), not an advisory lock. One `$transaction` holds lock → settle → consume plan → reconcile → admit (`stage-runner.ts:356-405`). The SANDBOX outbox runs outside it (`:409-411`) | Rule kept: PCR-2 adds no I/O inside the transaction. FX rates and quality come from observations already loaded |
| C1 "today: quotes are stamped DEMO and rejected `DATA_DEMO`" | Worse: they are dropped before persistence as `FIXTURE_SEQUENCE` (`observation-origin.ts:89-96`, `stage-runner.ts:576-579`) | The unprotected ingest fix (B1–B3) must land before C1 has anything to admit |
| C5 "`gateAndQuote` lines ~72-81" | `store.ts:98-139`; the DEMO check is at `115-118` | Line numbers only |
| (absent) | Pending orders need `eventTime ≥ eligibleAt` (`eligible-observation.ts:61-82`) | **New item C8**: keep the rule (no look-ahead), and document that a non-crypto fill needs a quote whose provider event time is after `eligibleAt` |
| C4 "pass `instrumentId`" is enough | The planner also rejects null liquidity (`plan.ts:803-813,913-916`), and sizing participation uses liquidity (`size.ts:28`) | C4 widens: non-crypto sizing must use an asset-class cap (`maxPositionPctEquity`, exposure) instead of DEX participation. It never invents liquidity |
| C6 "commodity 5 bps" | XAU 5/2, WTI 8/3 via `product-semantics.ts:56-76`; FX 1.5/0.5, ETF 2/1 (`:181-182`) | Floors stay as they are; observed half-spread is applied as `max()` |
| C2 accurate | `applyExternalFill` also takes `currency` and books the price unconverted (`store.ts:742,826`) | C2 scope includes the SANDBOX external-fill path, or refuses non-USD there |

## Items (rebased)

| Item | Protected path | Unprotected prerequisite (state) | Depends on |
| --- | --- | --- | --- |
| C1 freshness admission | `risk-engine/src/evaluate.ts:206-219,80-83` | `assessQuoteAdmission` (`packages/shared/src/quote-admission.ts`, **done** `78aa955`, 20 tests); persisted `QuoteQuality` (open, B3) | B1–B3 |
| C2 quote→USD | `trading-engine/src/fill.ts`, `store.ts`, `ledger.ts` | `fx-conversion.ts` exists with tests | C1 |
| C3 tick, lot, multiplier | `fill.ts`, `size.ts`, `money.ts`, `position-lot.ts` (shared; on the fence path, so reviewed as protected) | `precision.ts` exists with tests | PCR-1 fence proof |
| C4 planner consistency | `agent-core/src/plan.ts` (unprotected, order path) + `size.ts` (protected) | — | C3 (review together) |
| C5 one admission function | `store.ts:115-124` | same function as C1 | C1 |
| C6 observed spread | `cost-model.ts` | spread is in `QuoteQuality.spreadBps` | B3 |
| C7 OANDA practice venue | venue/broker files | — | **Out of scope.** Not requested, not authorised |
| C8 eligibility after latency | `eligible-observation.ts` | — | documentation and tests only; the rule is unchanged |

## F11-X interactions

| F11-X item | Interaction with PCR-2 | Decision |
| --- | --- | --- |
| Cumulative chain impact on `:remN` remainders | Remainders arise only when `applyDexImpact` (`fill.ts:64`), so non-crypto never produces one. C3 lot rounding can leave dust on exits; a full exit must sell the held quantity even when it is not a lot multiple | Independent of PCR-2. Not folded in |
| SANDBOX `applyExternalFill` without `lockAccount` (`store.ts:731-902`, caller `sandbox-execution.ts:244-256`) | C2 touches the same function (currency) | **Order:** F11-X lock fix first if both are approved, so C2 edits a locked path. Listed separately in `PROTECTED-APPROVAL.md` (A7) |
| CAP overwrites `Order.qty` | C3 changes quantities; the audit loss gets worse with lot rounding | Recommend approving `requestedQty` with C3 (A8) |

The protected scope is not expanded silently. A7 and A8 are separate line items that the operator may decline.
