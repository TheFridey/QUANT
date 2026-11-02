# ASCEND-09: point-in-time trade memory, lot histories and reconciled attribution

Branch `apex/ascend-09-trade-memory` from `bff5000` (the PR #44 head, since merged to `main` as `4331e99`). Code commit `49f11e0`. Not pushed. PAPER only: nothing here touches order admission, fills, risk, engine config or promotion, and no protected path was edited.

## What was there before

`TradeMemory` is written per **fill** by `persistTradeReconstruction` (`apps/worker/src/stage-runner.ts`): a BEFORE, DURING and AFTER row, all stamped with the fill time, where AFTER (`postExit: true`) carries an `outcome` guessed from the intent. It has no lot identity, exit rationale, MAE/MFE, config hash or cost estimate, and it only sees orders created in the cycle itself, so fills settled in a later cycle (pending orders, sandbox outbox) are missed. It is left unchanged; ASCEND-09 adds a separate, lot-keyed record next to it.

## Design

| Piece | Where | Role |
| --- | --- | --- |
| Lot reconstruction | `packages/analytics/src/lot-history.ts` | Pure. Rebuilds lots from fills; reconciles them with the ledger; summarises attribution |
| Point-in-time views | `packages/analytics/src/entry-view.ts` | Pure. Builds the ENTRY / ADD / EXIT view of a fill from candidate rows, keeping only rows at or before the fill |
| Snapshot table | `TradeLotSnapshot`, migration `20261102150000_trade_lot_snapshot` | One row per fill (unique `fillId`), append-only trigger |
| Writer | `apps/worker/src/trade-lot-memory.ts`, called from the ARCHIVIST stage | Reads trading tables, inserts snapshots |
| API | `apps/api/src/trade-lots.{controller,service}.ts` | Read-only endpoints |

### Lots

- A lot opens on a BUY that takes the reconstructed position of an (account, pair) from 0 to positive and closes on the SELL that returns it to 0. Fills are ordered by `createdAt`, then `id`. Events are `ENTRY`, `ADD`, `REDUCE`, `EXIT`.
- **Boundaries always come from the fill sequence** (`boundaryMethod: "FILL_SEQUENCE"`): fills have no lifecycle column, and `Position.lifecycleId` holds only the current open lot. Recorded lifecycle ids only **label** lots, in priority order: `TRADE_LOT_SNAPSHOT` (written by this feature against the entry fill), `POSITION` (open position, labels the single open lot), `PROTECTION_ORDER` (labels the lot whose window contains the protection's `createdAt`). Each lot reports `identityMethod` (`LIFECYCLE_ID` or `FILL_SEQUENCE`) and `lifecycleIdSource`; disagreeing labels raise `LIFECYCLE_ID_CONFLICT`, one id on two lots raises `LIFECYCLE_ID_SPANS_LOTS`. The stable lot key is the entry fill id.
- Arithmetic is the paper ledger's (`trading-engine/src/ledger.ts`, read only): average cost includes fees, 8 dp ROUND_HALF_UP; SELL realised = `notional − fee − avgCost × qty`. Each lot carries quantities, average entry/exit price, average cost, realised P&L, fees, slippage (USD implied by `slippageBps`), holding time (`OPEN_TO_CLOSE` or `OPEN_TO_ASOF`), and per event the intent, `ownerScope`, reason codes and an exit reason (`REASON_CODE` or a labelled `INTENT_FALLBACK`).
- A SELL with no open lot is an **orphan fill**, never folded into a lot. A SELL larger than the reconstructed position is flagged `SELL_EXCEEDS_RECONSTRUCTED_POSITION`.
- **MAE/MFE** use only marks with `receivedAt` in `[openedAt, closedAt]`, both ends inclusive; an OPEN lot's window ends at `asOf` and says so (`windowEndIsAsOf`). The reference is the entry fill price. No marks gives `null` excursions; an open lot without a mark has `unrealizedPnlUsd: null`. Missing marks are never zero.

### Attribution per strategy instance

Each fill is attributed the way `settleFillByOwnerScope` books `StrategyAllocation` (mirrored, not called): STRATEGY BUY to its instance, OPERATOR BUY to `stratinst_manual`, other BUYs to `stratinst_unattributed` (cost basis unknown); STRATEGY SELL to its owner; NET_CLOSE / PROTECTION / ACCOUNT_FLATTEN / un-owned OPERATOR / FLATTEN sells pro rata over current holders with the same floor-and-remainder rule. Two figures per instance:

- `realizedPnlUsd`: each sell fill's ledger-basis realised P&L split by attributed quantity. Instances (plus `unresolved`) sum exactly to the lot total.
- `allocationBasisRealizedPnlUsd`: on the instance's own average cost, as `StrategyAllocation` books it; `null` when the cost basis is unknown. Compared with the stored rows separately (`allocationStatus`).

Quantity no allocation owns is attributed to `unresolved` and flagged `ALLOCATION_SHORTFALL`; holdings left when a lot closes raise `ALLOCATION_RESIDUAL_AT_CLOSE`.

### Point-in-time snapshots

The worker writes one row per fill: `ENTRY` at lot open, `ADD`, and `EXIT` for each reducing fill. The ENTRY view holds the decision and fill observations, the cycle's agent decisions for the pair (and cycle-wide `""` rows), quote freshness (observation age at order and at fill), the estimated cost from the stored `CyclePlan` plus numeric cost fields of the EXECUTOR decision, realised fee and slippage of the fill itself, strategy instance and version, and the config hash. EXIT views add the exit reason and the excursion to date over `[openedAt, exit fill]`.

The writer runs in `archivist()` after `persistTradeReconstruction`, i.e. after the executor stage and its transaction have committed. It never runs inside order admission, inserts only into `TradeLotSnapshot`, and is wrapped in `try/catch` so a failure is logged (`trade lot snapshot write failed`) and never fails the cycle. Candidates are the account's fills without a snapshot, oldest first, 200 per cycle, starting 10 minutes before the newest snapshot, so fills settled in another cycle and history from before this feature are filled in on later cycles. `createMany(skipDuplicates)` on the unique `fillId` makes it idempotent.

## Temporal-boundary guarantees

For a snapshot anchored to fill F with `asOf = F.createdAt`:

1. **Query filter.** Every read that feeds the view is bounded: observations `receivedAt <= asOf`; decisions `createdAt <= asOf`; `CyclePlan.plannedAt <= asOf`; `CycleRun.startedAt <= asOf`; config revisions `createdAt <= asOf`; marks `receivedAt` in `[openedAt, asOf]`.
2. **Builder filter.** `buildPointInTimeView` re-applies the same bounds to whatever it is given (an observation with a later `eventTime` is also dropped), so a caller that passes later rows cannot leak them. Mutable rows: a `StrategyInstance` updated after `asOf` is omitted (`UPDATED_AFTER_ASOF_OMITTED`) rather than shown as it is now.
3. **No forward-dated free text.** Decision `input`/`output` JSON and observation `raw` payloads are never copied (the EXECUTOR output carries `expiresAt`); only whitelisted numeric cost fields are. The view never records how many rows were excluded, since that count would itself depend on the future.
4. **Guard before write.** `assertNoPostAsOfTimestamps` walks every ISO timestamp in the view and the writer skips (never writes) a view with any timestamp after `asOf`.
5. **Lot classification is causal.** A fill's event kind, quantities before/after, `openedAt`, entry price and realised P&L depend only on earlier fills (sequential rebuild); the test compares a prefix with prefix + later fills.
6. `lifecycleId` / `lifecycleIdSource` are columns outside `view` and `viewHash`: they are identity labels resolved at write time (Position or ProtectionOrder), not information used by the view.

`entryView(source)` is `buildPointInTimeView` at the lot's entry fill and refuses any other fill. The API returns the **stored** ENTRY snapshot with `integrity` (stored view re-hashes to `viewHash`) and `temporalBoundary` (no timestamp after `asOf`); a lot without one yet reports `entryViewState: "NOT_RECORDED_YET"`. The API never rebuilds an entry view from current rows.

## Reconciliation rules

`reconcileLotsWithLedger` (and `GET /api/terminal/lots/attribution`) is `RECONCILED` only when all hold:

- `|Σ REALIZED_PNL ledger rows − Σ lot realised P&L| ≤ 1e-8`;
- `|Σ −FEE ledger rows − Σ fill fees| ≤ 1e-8`;
- no itemised discrepancy: `LEDGER_ROW_WITHOUT_FILL`, `FILL_WITHOUT_LEDGER_ROW`, `FILL_AMOUNT_MISMATCH` (per fill, also a REALIZED_PNL row on a BUY), `DUPLICATE_LEDGER_ROWS`, `ORPHAN_FILL`, `POSITION_QTY_MISMATCH` (reconstructed open quantity vs `Position.baseQty`).

Otherwise it is `UNRECONCILED` and reports `unreconciledUsd` for realised P&L and fees, with every item. Lot totals always come from the fills; a difference is never absorbed into them. The API reports `INCOMPLETE` if the account has more than 50 000 fills (the read cap). The `StrategyAllocation` comparison (`MATCH` / `MISMATCH` / `NOT_COMPARABLE` per instance and pair) is reported as `allocationStatus` and does not change the ledger status.

## API (read-only, authenticated by the global JWT guard, scoped to `TerminalService.activeAccountId()`)

- `GET /api/terminal/lots?status=OPEN|CLOSED&pair=&limit=&offset=`: lots newest first, with excursion and, for OPEN lots, valuation.
- `GET /api/terminal/lots/:lotKey` (entry fill id or lifecycle id): events, excursion, stored snapshots with integrity checks, entry view, merged timeline.
- `GET /api/terminal/lots/attribution`: per-instance summary, reconciliation and rules.

The only change to existing API code is that `TerminalService.activeAccountId()` is no longer `private`.

## Evidence (this session, local Postgres 16 `odin_test_a09`, Redis 7)

All commands ran with `DATABASE_URL` and `DATABASE_URL_TEST` set to `postgresql://odin:odin@127.0.0.1:5432/odin_test_a09`.

| Check | Command | Result |
| --- | --- | --- |
| Migration | `pnpm db:deploy` | `20261102150000_trade_lot_snapshot` applied |
| Lot unit tests | `pnpm vitest run packages/analytics/src/lot-history.test.ts` | 12 passed |
| View unit tests | `pnpm vitest run packages/analytics/src/entry-view.test.ts` | 9 passed |
| Worker + DB | `pnpm vitest run apps/worker/src/trade-lot-memory.integration.test.ts` | 5 passed |
| API + DB | `pnpm vitest run apps/api/src/trade-lots.integration.test.ts` | 4 passed |
| Whole suite | `pnpm test` | 163 files passed, 4 skipped; **914 passed, 25 skipped** (skips: sandbox tests, no bubblewrap here, as at baseline) |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |

What the tests cover: lot boundaries (open, add, partial reduce, close, reopen); lifecycle labels and conflicts; multi-instance attribution including pro-rata protection exits and an unowned exit; reconciliation equal to ledger rows produced by the real `applyFill`, and a corrupted ledger (altered amount, row without fill, missing row, orphan sell, position mismatch) reported as `UNRECONCILED`; prefix invariance of the entry view under later observations, decisions, config revisions and fills; no timestamp in an entry view after the entry fill; MAE/MFE window ends (1 ms either side, other pair, null price, open lot to `asOf`); null marks; the append-only trigger rejecting Prisma and raw `UPDATE`/`DELETE`; the snapshot write leaving `Order`, `Fill`, `Position`, `LedgerEntry`, `StrategyAllocation`, `PaperAccount`, `RiskReservation` and `ProtectionOrder` md5 row hashes unchanged after a real paper cycle; archivist idempotency; a DB prefix-invariance rebuild (truncate, add later rows, rewrite: same `viewHash`).

### Mutation checks (each run, then reverted; reverts confirmed by grep before the final suite)

| Mutant | Killed by |
| --- | --- |
| Builder time filter always true (post-entry rows admitted) | 3 unit tests: prefix invariance, no-late-timestamp, drop-late-rows. The DB test survived it alone because the SQL `<= asOf` filters are an independent barrier |
| Same, plus the writer's decision query without `createdAt <= asOf` | DB prefix-invariance test (the guard refused to write the leaking view), plus 2 dependent tests |
| MAE/MFE window without its upper bound | 2 excursion tests |
| Reconciliation skips ledger rows without a fill | unit corrupted-ledger test and API corrupted-ledger test |

## Limitations

- Fill order within the same millisecond falls back to `id`. A fill committed later with an earlier `createdAt` (a concurrent operator order, for example) could be classified against a sequence that later gains an earlier fill; the lot API then disagrees with the stored `eventKind`, and reconciliation still uses the full ledger.
- `AgentDecision` rows are upserted and have no `updatedAt`: a decision created before the fill and updated after it would show its later content. The writer runs right after commit, which narrows but does not close this. `Order.reasonCodes` is likewise read as stored (the fill itself appends `FILLED`).
- Config hash: the cycle's pinned revision when its `engineUpdatedAt` matches `CycleRun.configRevision`, else the latest revision at or before the fill (`method` says which). `EngineControl.updatedAt` also moves on non-config writes, so the pinned match can miss.
- `allocationBasisRealizedPnlUsd` mirrors `settleFillByOwnerScope`. Allocation repairs and recovery paths outside fills are not modelled, so `allocationStatus` can be `MISMATCH` while the ledger reconciles; that is reported, not hidden.
- Excursions use the entry fill price as reference, not a mid; slippage USD is implied from `slippageBps`.
- Backfilled snapshots for history before this feature are built with the same filters but were captured late (`createdAt` much later than `asOf`).
- The writer caps at 200 fills per cycle and 20 000 fills per pair; the API reads at most 50 000 fills per account (beyond that: `INCOMPLETE`).
- Not run here: browser e2e, production deployment (no VPS access), sandbox tests (no bubblewrap). No independent safety review was run: this session has no subagent tool, and no protected path changed.
- The legacy per-fill `TradeMemory` writer is unchanged.
