# PCR-AURUM-01: gold spread-bet execution (protected change request)

TITANIUM revision: C3/C10 details below are historical draft scope. The current exact approval package is [TITANIUM-APPROVAL-PACKAGE.md](TITANIUM-APPROVAL-PACKAGE.md): registered composite ownership replaces the insufficient `accountId <> primary` check; rollback after financial records is forward-only; global emergency stop is separate from account commands; no partial-entry lifecycle is implied. No protected implementation approved or performed.

- **Status:** DRAFT, not approved.
- **This is not an unlock request yet.** Each item below is approved separately.
- **Activation:** every new capability ships inactive and default-deny. Activation is a separate operator act, after review.
- **Review of PCR-2:** PCR-2 was a generic multi-asset spot design (`docs/horizon/PCR-2-MULTI-ASSET-EXECUTION.md`, `phase-ii/PCR-2-REBASED.md`). Its quote-admission work (A1 classifier, mandatory spread cap) is reused here as C2. Its spot sizing, precision and FX-conversion items (A4, A5) are **not** needed for AURUM, because spread betting does not book spot notional or convert P&L currency. PCR-2 stays unimplemented.

## Items

| # | Change | Protected files / functions | Today | Proposed | Gate broadened? | Replacement constraint | Migration | Tests | Rollback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Gold-only admission | `apps/worker/src/executor/admit.ts` `admitPlannedOrders` (unprotected, on the order path); new AURUM settle entry in `packages/trading-engine/src/` | no AURUM path | every AURUM order route (planner, manual terminal, protection, flatten, promotion, sandbox) calls `assessAurumOrderScope` first | **No**: new path, default-deny | profile `active:false`; legacy `primary` refused | none | integration test: crypto, FX, ETF, energy and index observations fed through the real admit/settle with the profile active → 0 AURUM orders | set `active:false` |
| C2 | Quote provenance and admission | `packages/risk-engine/src/evaluate.ts` (`evaluateRisk` freshness for AURUM only); new `packages/trading-engine/src/spread-quote.ts` | DEMO refused, DELAYED refused | for the AURUM path only: `assessQuoteAdmission` (mandatory cap, LIVE/DEMO dataState) then `deriveSpreadBetQuote`; the legacy path is unchanged | **Yes, for AURUM:** admits OANDA practice DEMO dealer quotes | quote age ≤ 45 s, spread cap, session OPEN, provider tradeable, no future timestamps; settle re-evaluates and never reuses the risk verdict | none | admission matrix (stale, crossed, one-sided, future, closed session, wide spread); legacy DEMO BUY still refused | remove the AURUM branch |
| C3 | Spread-bet tables | `packages/shared/prisma/schema.prisma` (additive) | none | `SpreadBetOrder` (action, clientOrderId unique, stake, stop, limit, eligibleAt, expiresAt, lifecycleId, stakeAtBooking), `SpreadBetFill` (unique (orderId, seq), price, stake, quoteId, scenario), `SpreadBetPosition` (direction, stake, avgEntry, state, lifecycleId), `MarginReservation`, `SpreadBetLedgerEntry` (GBP, Decimal(24,2) for booked amounts, Decimal(24,8) for prices) | No | FKs to the AURUM `PaperAccount` only; check constraint `accountId <> 'primary'` | **additive migration** | `migration-schema.test.ts`; DB constraint tests | drop the new tables (they are empty until activation) |
| C4 | Product semantics | new `packages/trading-engine/src/spread-fill.ts` using `spread-bet.ts` | — | entry at ask/bid; exit at bid/ask; no second spread deduction | No | spec validated on every call | none | already-written unit tests plus fill tests | revert file |
| C5 | Stake sizing | new `packages/risk-engine/src/spread-size.ts` wrapping `sizeStake` | spot `sizeFromStopDistance` | stake from GBP risk and stop; reject below minimum | No | riskFraction ≤ the configured value (≤ 0.5%); hard ceiling 2% in code | none | min-stake, max-stake, margin, wrong-side, NaN | revert |
| C6 | Margin accounting | new settle and ledger functions | — | reserve on open; release on reduce/close; equity = cash + unrealised | No | utilisation ceiling (proposed 30%); closeout (proposed 50%) | C3 | invariant tests (SPREAD-BET-ACCOUNTING §4) | revert |
| C7 | Fill simulation and protective exits | `packages/trading-engine/src/eligible-observation.ts` (reuse `findEligibleFillObservation` semantics); `apps/worker/src/executor/protect.ts` | spot | pending fill at the first admitted quote ≥ eligibleAt; stops fill through gaps; exits allowed while inactive | No | no fills in closed sessions; flat before the 17:00 ET break | none | gap, delayed fill, partial, session close, weekend reopen | revert |
| C8 | Lifecycle and transaction ordering | new `settleSpreadBetOrder` in `store.ts` style | — | lock the AURUM account row (`lockAccount`), then the position, then the order; one transaction per fill; PCR-1-style lifecycle fence on stake | No | idempotent on clientOrderId and fill seq | C3 | concurrent settle, duplicate fill, crash mid-settle, deterministic replay | revert |
| C9 | AEGIS states for AURUM | `packages/risk-engine/src/evaluate.ts` (`evaluateCircuitBreaker`) | daily, total and circuit latches in USD | GBP states HEALTHY, ENTRY_RESTRICTED, EXIT_ONLY, DATA_UNAVAILABLE, MARGIN_RESTRICTED, DAILY_LOSS_LATCHED, TOTAL_DRAWDOWN_LATCHED, EMERGENCY_STOPPED, per account | No; new limits are tighter (2% daily, 10% total) | latches never auto-clear; ML/autonomy cannot write them | none | each state forces exit-only or blocks entries | revert |
| C10 | Account isolation | `packages/shared/src/execution-context.ts` (pinned guard), `environments.ts`, `EngineControl` reads in `stage-runner.ts` / `settle.ts`; `packages/shared/src/strategy.ts` **not** changed | one engine config, `primary*` only | per-account `AccountRiskConfig` (additive table); `ExecutionContext.accountId` explicit; guard accepts registered accounts only | No for `primary`; adds a second, tighter account | `DEFAULT_STRATEGY` untouched; AURUM config cannot be looser than its approved hash | additive | cross-account contamination tests (risk, HWM, daily loss, flatten) | revert; `primary` unaffected |

## Activation controls

1. The migration (C3, C10) is deployed with the profile inactive. It must cause no change to `primary` behaviour, verified by the regression suite and a production canary that reads `primary` equity and decisions.
2. Operator creates the `aurum` account (£10,000 simulated, GBP) with experiment id and config hash.
3. Operator sets `active: true` for shadow-only operation first (AURUM orders computed, not settled).
4. Paper settlement is enabled only after M5 evidence and an operator activation request (ROLLOUT M7).

## Independent review requirements

Before each item is reported done:
- `quant-safety-reviewer` (execution and accounting);
- `regression-reviewer`;
- `db-migration-reviewer` (C3, C10).

A REJECT blocks the item. A post-fix re-review is mandatory: the PR #81 gap is not repeated.

## Exact approvals requested (when ready; not now)

The operator creates `.claude/protected-edits.unlock` for one item at a time, starting with **C3 + C10** (additive schema and isolation, no behaviour change). The agent then implements, tests and gets the reviews, and the operator removes the unlock.
