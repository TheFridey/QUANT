# PCR-1: fence pending exits to their position lot

Status: **reproduced, fix prepared, protected half awaiting operator approval.** Branch `apex/pcr-1-lifecycle-fence` (from `main` `c3b23e9`; independent of PR #44). PAPER-only; no risk default, entry control or live-money path changes.

## 1. Defect

A pending SELL is booked for one position lot. If that lot closes by another path and a new lot opens on the same pair before the SELL settles, the SELL sells the **new** lot.

`Order` has no reference to the lot it was booked for (`schema.prisma`, model `Order`). Settle (`apps/worker/src/executor/settle.ts`) cancels a pending SELL only while the pair is **flat** (ASCEND-00 F5, `EXIT_SUPERSEDED`). Pending orders settle in `submittedAt` order, so an earlier-submitted pending BUY on the same pair fills first and reopens the pair. The F5 check then sees a non-flat position and lets the stale SELL settle.

### Reachable sequence (current code)

1. Lot L1 is open on pair P (owner: strategy X).
2. T0: a BUY on P becomes PENDING (paper latency, default 1 s). This is allowed while L1 is open: entry de-duplication is per strategy instance and pair (`INSTANCE_ALREADY_OWNS`, `PENDING_ENTRY_IN_FLIGHT` in `packages/agent-core/src/plan.ts`), so a second instance can enter P, and operator tickets may add to a held pair.
3. T1 > T0: the planner books a protective NET_CLOSE for L1, PENDING. `pendingNetCloseByPair` defers further *exits* on P, not entries.
4. Same cycle, protect phase: protection fills and closes L1. The pair is flat and L1's id is cleared.
5. Next cycle, settle, in `submittedAt` order: the BUY (T0) fills and opens lot L2 with fresh protection. Then the NET_CLOSE (T1) sees qty > 0, passes F5, and **sells L2**.

### Evidence (executed 2 Nov 2026, local Postgres 16, code at `c3b23e9`)

`apps/worker/src/executor/lifecycle-fence.integration.test.ts` seeds exactly that state and calls the real `settlePendingPaperOrders` / `settlePendingOrder`. On unpatched code, the stale NET_CLOSE was `FILLED`, the new lot went back to 0 with its lifecycle cleared, realised P&L was −$0.69 on a $100 lot (fees + spread for an unintended round trip), and two fills were booked.

### Severity

**Medium.** The ledger stays consistent (cash equals the ledger), and exposure never exceeds what was admitted. The defect closes a position that the operator or another strategy deliberately opened, pays a round trip in costs, and removes protection armed for the new lot. It affects PAPER accounting and strategy attribution, and could distort research on live-paper results.

Out of scope: SANDBOX orders already at the broker (`applyExternalFill`). A broker-side stale SELL cannot be cancelled locally once submitted. That is a separate, existing outbox concern.

## 2. Fix

| Part | File | Protected? | State on the branch |
| --- | --- | --- | --- |
| Nullable `Order.positionLifecycleId` (no index: nothing queries by it) | `packages/shared/prisma/schema.prisma`, migration `20261102120000_order_position_lifecycle` | No; **production migration needs approval** | Implemented |
| Reason code `EXIT_LIFECYCLE_MISMATCH` | `packages/shared/src/reasons.ts` | No | Implemented |
| Fence: cancel a stamped SELL whose lot is not the pair's open lot, releasing reservations exactly as F5 does; flatten exits exempt; unstamped rows unchanged | `apps/worker/src/executor/settle.ts` | No | Implemented |
| Stamp the lot on every pending SELL and on exit remainders | `packages/trading-engine/src/store.ts` | **Yes** | Patch only: [`store-stamping.patch`](store-stamping.patch). `git apply --check` passes against `c3b23e9`; not applied |

The two *code* halves are safe in either order: the fence is a no-op until rows are stamped (null → today's behaviour), so deploying the fence without the stamping changes nothing in behaviour.

**The migration must go first.** A build whose Prisma client knows `positionLifecycleId` selects it on every `Order` read. Against a schema without the column, the whole executor would fail, including exits (risk review, MEDIUM). Old builds ignore the column, so migrate, then deploy. On rollback, redeploy the previous build and keep the column.

### Design choices

- **Stamp at booking, not at decision.** The stamp is read inside the account-locked transaction that writes the order (`currentLotId`). The book cannot change between the read and the insert.
- **Remainders inherit the parent's lot.** After a partial SELL the lot is still open, so `ensurePositionLifecycleOnOpen` returns the same id, and `bookExitRemainder` receives it.
- **Flatten exits are exempt** (`ownerScope = ACCOUNT_FLATTEN` or `intent = FLATTEN`). A flatten means "be flat now". When the engine is halted, settle already cancels pending ENTRY/OPERATOR BUYs before they can reopen the pair.
- **Operator reduces are fenced.** An operator SELL booked against L1 is cancelled if L2 has replaced L1; the operator can resubmit against L2. This is the conservative reading: never sell a lot the order was not for.
- **Fence location.** In the settle loop beside F5, with the same release path (`releasePendingExitReservation` clamps at zero; `releaseInTx` is a no-op without a HELD reservation). It runs before the eligibility check, so a stale exit that is not yet eligible is also cancelled.
- **Rejected alternatives.**
  - A timestamp heuristic (compare `submittedAt` with the lot's first fill). It needs no migration, but Prisma's `now()` and the shared transaction timestamps make it ambiguous within one cycle.
  - A database trigger that stamps on insert. It avoids touching `store.ts`, but it hides trading behaviour in SQL and sidesteps the protected-path review the change deserves.

### What it cannot weaken

- **Entries:** untouched.
- **Risk limits:** untouched.
- **Exits for the open lot:** settle exactly as before (control test).
- **Protection:** `ProtectionIntent` retries already have their own lifecycle fence (D07). An exit cancelled by the fence leaves the open lot with the protection armed by its own BUY fill (`armProtectionForFill`), and the planner can plan a fresh exit against it next cycle.

## 3. Regression tests (`apps/worker/src/executor/lifecycle-fence.integration.test.ts`)

| Test | Before fix | Fence only (branch) | With stamping patch |
| --- | --- | --- | --- |
| Stale protective NET_CLOSE does not sell the new lot | **fails** (reproduces the defect) | pass | expected pass |
| Control: SELL for the still-open lot fills | pass | pass | expected pass |
| Flatten exit fills whichever lot is open | pass | pass | expected pass |
| Legacy unstamped SELL keeps today's behaviour | pass | pass | expected pass |
| OPERATOR reduce for a closed lot is fenced even before it is eligible | n/a | pass | expected pass |
| Fenced STRATEGY exit releases its reserved exit qty, clamped at zero | n/a | pass | expected pass |
| Booking stamps a pending SELL with the open lot, and a BUY with none | n/a | **fails** (needs `store.ts`) | expected pass; **not executed** (requires the unlock) |

"Before fix" for the first row was executed against `c3b23e9` (the reproduction in §1). The fence tests seed stamped rows; they prove the fence logic, not reachability, which §1 shows separately.

Branch-wide, executed: `pnpm test` gives 828 passed, 1 failed (the stamping test above), 25 skipped (bubblewrap). `pnpm typecheck` and `pnpm lint` are clean. Existing settle F5 unit tests pass.

Still to add with the unlock (from the risk review):
- a store-level test that a partial exit's remainder carries the parent's lot (`store.exit-policy.integration.test.ts`, protected package);
- an end-to-end executor test: admit, then `evaluateProtections`, then the next settle, building the sequence without seeded rows.

## 4. Rollout (after approval)

1. Unlock; apply `store-stamping.patch`; run the full suite (all 5 PCR-1 tests must pass) and the quant-safety review.
2. PR with CI green.
3. Deploy, in this order: back up; **apply the migration first** (metadata-only on PostgreSQL 16, no rewrite and no index build); then rebuild packages and worker, and restart the worker. Rollback: redeploy the previous build; keep the column.
4. Watch `EXIT_LIFECYCLE_MISMATCH` cancellations (expected rare) beside `EXIT_SUPERSEDED`.

## 5. Independent risk review

See [`RISK_REVIEW.md`](RISK_REVIEW.md).
