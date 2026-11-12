# F11 — economic trade identity and chunked-exit realism

Branch `integrity/phase-ii`. The analytics half is **FIXED**; the execution-model half touches protected paths and is **BLOCKED on operator approval**. An approval package is below.

## Defect

`apps/api/src/terminal.service.ts` and `apps/worker/src/stage-runner.ts` passed every `REALIZED_PNL` ledger entry to `performanceReport` as one closed trade. The trading engine writes one such entry per SELL fill, and an exit above `maxExitImpactBps` is split into a PENDING remainder order (`clientOrderId` = parent + `:remN`, possibly nested). The result: one economic exit counted as several trades, which distorts closed-trade count, wins/losses, win rate, average win/loss, expectancy and profit factor. The worker persists those figures in every `EquitySnapshot.metrics`.

## Semantic decision: economic exit identity

**Rule.** One economic trade = one **root exit order**: the `clientOrderId` with every trailing `:remN` removed. `exitRootKey` in `packages/analytics/src/economic-trades.ts` implements it, and the only writer of the suffix is `bookExitRemainder` in `packages/trading-engine/src/store.ts`.

**Cases the rule decides:**

| Case | Treatment |
| --- | --- |
| Partial fills / remainder chain | one trade; P&L is the exact Decimal sum of its chunks |
| Scale-outs, a stop then a later exit, take-profit, flatten, close then reopen | distinct root orders, so distinct trades. Trades are never merged by instrument or position |
| Strategy allocation | different owners' exits have different root orders and are never merged (tested) |
| Missing lineage (no `orderId`, or the order row is gone) | each entry is its own trade and is counted in `unlinkedEntries`, so the gap is visible, not guessed |
| Fees | untouched: `feesUsd` is still the all-time FEE ledger sum |

**What does not change:**

- Total realised P&L, cash, ledger rows, drawdown (from equity snapshots), `returnPct`, and lot reconciliation (`trade-lots.service.ts`, `lot-history.ts`).
- Metric definitions: win rate, averages, profit factor and expectancy are the same formulas, applied to economic trades.

**Window caveat.** Grouping happens inside the existing latest-N entry window (`SNAPSHOT_BOUNDS.closedTrades`, or 200 in the worker). The oldest exit in the window may be partial; the API window `method` text says so.

## Changes

- `packages/analytics/src/economic-trades.ts` (new): `exitRootKey`, `economicExits`.
- `apps/api/src/terminal.service.ts`:
  - resolves the window's exit orders (one bounded `findMany` by id) and feeds economic trades to `performanceReport`;
  - `analyticsWindows.closedTrades.economicTrades` reports `chunks`, `economicTrades`, `unlinkedEntries` and `totalRealizedUsd`.
- `apps/worker/src/stage-runner.ts`: same grouping. `EquitySnapshot.metrics` gains `tradeBasis: "ECONOMIC_EXIT"`, `realizedChunks` and `unlinkedRealizedEntries`. Historical snapshots keep their chunk-based figures. They are not rewritten, and the missing `tradeBasis` identifies them.

**Other readers checked:**

| Reader | Status |
| --- | --- |
| `apps/api/src/opportunities.service.ts` (`attributePnlByMarket`) | sums P&L by market and labels its count `entries`, not trades. Unchanged, with correct semantics. |
| `trade-lots.service.ts` | reconciles totals, not counts. Unchanged. |

## Tests

| Test | Result |
| --- | --- |
| `packages/analytics/src/economic-trades.test.ts` (8) | 8/8. Covers: suffix stripping; one exit over 3 chunks gives 1 trade (the old basis gave 3); a winning exit with a losing chunk and a losing exit with a winning chunk; distinct exits from one position, and reopen; missing lineage; total realised P&L identical before and after (expectancy × trades = net realised); fees and return unchanged; multiple strategy owners; golden comparison where one fill equals the same exit in chunks |
| Existing `apps/api/src/terminal*`, `apps/worker/src/stage-runner*` | 9 passed, 1 skipped (DB) |

## Protected execution increment: operator approval package (NOT implemented)

The original finding also covers execution realism. Each remainder is priced in `quoteFill` (`packages/trading-engine/src/fill.ts`) against the **current** quote's liquidity. Prior simulated sales in the same liquidation chain are not subtracted, so a long chain can sell more, at better prices, than one pool could absorb. Real pools do replenish, so "never replenishes" is also wrong. Any fix needs a declared liquidity model.

| Item | Path (protected) | Classification | Proposal |
| --- | --- | --- | --- |
| Cumulative chain impact | `packages/trading-engine/src/fill.ts`, `store.ts` (`bookExitRemainder`, settle) | **Confirmed modelling gap**, safety-sensitive | Track `chainSoldNotionalUsd` and `chainStartedAt` on the root exit. When quoting a remainder, reduce effective liquidity by the chain's prior sold notional, decayed with a declared replenishment half-life (config, disclosed in reports). Must never block or cap a risk-reducing exit beyond today's `maxExitImpactBps` behaviour; it only worsens the modelled price, or leaves more as remainder. Needs a migration (two nullable columns on `Order`) or derivation from fills by root key. |
| SANDBOX `applyExternalFill` without the account lock | `packages/trading-engine/src/store.ts:731`, caller `apps/worker/src/sandbox-execution.ts:245` | **Confirmed pre-existing defect** (F01 review residual); SANDBOX only, never PAPER live | Take the same per-account advisory lock as the PAPER fill path inside the caller's transaction. |
| CAP overwrites original `Order.qty` | `packages/trading-engine/src/store.ts` (PCR-1 settle cap) | **Separate technical debt**: audit trail loses the booked quantity; P&L is unaffected | Add nullable `Order.requestedQty`, set once at booking; the cap writes `qty` only. |
| Flatten exits unfenced | PCR-1 design | **Intentional behaviour** (account flatten must always be able to reduce), documented in `docs/apex/pcr-1/ANALYSIS.md` | none |
| Backtest end-of-run remainder valuation | `packages/backtest` | **Not a protected path**; not changed in this increment | Value an unfilled remainder at the last bar's modelled exit price including chain impact, consistent with paper. Follows the execution change so both use one model. |

Tests to accompany an approved change:

- one exit as many chunks versus one fill (golden), with cumulative impact;
- replenishment half-life of 0 and ∞;
- risk-reducing exit never rejected;
- multiple owners' exits on one pool;
- sandbox concurrent external fills serialised;
- original quantity preserved through a cap;
- an independent `quant-safety-reviewer` pass.

Approval scope requested: only the files named in the table, nothing else under the protected paths.

**Release impact.** The analytics fix is independent and releasable. Without the execution increment, paper results for large exits on thin pools remain optimistic. This is disclosed, not hidden.
