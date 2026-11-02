# Protected change requests

Changes APEX needs in protected paths (`AGENTS.md`). None has been made. Each needs the operator to create `.claude/protected-edits.unlock` by hand, tests alongside the change, and an independent safety review before it is reported done. Items marked *migration* also need operator approval to migrate production.

Nothing here weakens an entry control to make an exit pass.

## PCR-1 Fence pending exits to their position lifecycle (ASCEND-00)

- **Problem (confirmed in code, 2 Nov 2026).** `Order` has no lifecycle column (`packages/shared/prisma/schema.prisma`, model `Order`). A PENDING reduce order (`EXIT_PARTIAL_REMAINDER`, or a NET_CLOSE awaiting paper latency) is settled against whatever position exists for the pair when it becomes eligible. If the position closed and a new lot opened in between, the old exit can reduce the new lot. The planner's pending-net-close guard makes this unlikely, but it is not enforced at settlement.
- **Change.** *Migration*: add nullable `Order.positionLifecycleId` with an index. `packages/trading-engine/src/store.ts`: stamp it on every SELL created against an open lifecycle; in `settlePendingOrder`, cancel a pending SELL whose `positionLifecycleId` is not the position's current lifecycle with `EXIT_LIFECYCLE_MISMATCH`, releasing its reservations exactly as `EXIT_SUPERSEDED` does (`apps/worker/src/executor/settle.ts:73`). Legacy rows (null) keep today's behaviour.
- **Tests.** An integration test: open lot A, create a pending remainder, close A by protection, open lot B, settle → the remainder is cancelled and B is untouched; reservations are released; the cash and ledger invariants hold.
- **Risk.** Reducing risk is never blocked: the mismatch cancel applies only when the lot the order was meant for no longer exists.

## PCR-2 Correct the chunked-exit liquidity bias (ASCEND-00 / 06)

- **Problem.** Each exit remainder is quoted against fresh pool liquidity that ignores earlier paper sells in the same chain, so a large exit split into chunks is modelled more favourably than one constant-product exit (ARCHITECTURE, "Known bias"). Backtests share it.
- **Change.** In the exit fill path (`packages/trading-engine`), quote a remainder against the reserve after subtracting the cumulative notional already sold in the chain within a recovery window (for example `orderExpiryMs`), so a chain of chunks never fills better than a single trade of the same total size. Apply the same rule in `packages/backtest` replay (not protected) at the same time so paper and backtest stay at parity (`parity.test.ts`).
- **Tests.** A property test: for any split of a total quantity into k chunks inside the window, the total proceeds are ≤ those of one trade of the whole quantity (constant product), and equal when k = 1.
- **Risk.** This makes exits more conservative (worse modelled prices). It does not reject exits, so it cannot trap a position.

## PCR-3 Position protection amendments (ASCEND-00 §2.2, UI 9/11)

- **Problem.** Stops and targets come only from strategy config. There is no amend endpoint, history or per-order protection.
- **Change.** *Migration*: an append-only `ProtectionAmendment` table (position lifecycle, old/new stop and target, actor, reason, created at). An `ADMIN` endpoint that, inside the account `FOR UPDATE` transaction:
  - accepts **tightening** a stop (moving it toward the price) or moving a target unconditionally;
  - accepts **loosening** a stop only if the new stop-out risk, added to the open stop risk of all other positions, still fits the daily-loss headroom and `maxRiskPerTradePct`. Otherwise it refuses with the binding limit named. It never resizes or adds exposure;
  - rejects a stop at or above the current mark (it would fire immediately; use Close instead);
  - is idempotent on a client amendment id, and fenced on the lifecycle (PCR-1).
  Worker protection reads the latest amendment for the lifecycle. Web: an edit dialog with a review step showing the resulting stop risk and headroom.
- **Tests.** Unit tests of the validation matrix (tighten, loosen within headroom, loosen beyond headroom, invalid levels); an integration test with two concurrent amendments (one wins, one sees the new version); an e2e test of the dialog.

## PCR-4 Financial invariant property tests (ASCEND-00 §2.3)

- **Problem.** Fill, fee and ledger arithmetic is covered by example-based unit and integration tests but not by property tests.
- **Change.** Test-only, in `packages/trading-engine/src/*.property.test.ts`: generated sequences of buys, partial sells, fees and marks must keep cash equal to the sum of cash-affecting ledger rows, quantities non-negative and rounded down to 8 dp, realised plus unrealised P&L equal to equity change net of fees, and fills monotone in notional (constant product). No production code change. It sits in a protected package, so it still needs the unlock.

## PCR-5 CI: release-gate job for research reproducibility (ASCEND-11)

- **Change.** `.github/workflows/ci.yml`: a job that runs the research CLIs on committed, labelled fixture datasets and compares their JSON output against a checked-in snapshot (replay determinism), plus the restore drill (`scripts/restore-verify.mjs`) against a dump of the CI database. Actions stay pinned by SHA with `contents: read` (`ci-workflow.test.ts`).
