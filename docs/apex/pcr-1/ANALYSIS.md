# PCR-1: fence pending exits to the units they were booked against (v3, applied in v4)

**v4 (12 Nov 2026, OPERATION INTEGRITY F01).** The operator approved the protected edits in chat. Branch `integrity/f01-pcr1-fence` merges the v3 branch onto current `main` and applies `store-stamping.patch` unchanged (`git apply --check` clean; `store.ts` and `strategy-allocations.ts` unchanged since `c3b23e9`).
- Every quantity-increasing Position/StrategyAllocation write was re-checked on current `main`: the three `store.ts` upserts and the allocation BUY upsert. The other writers decrease qty, set reservations, or set lot ids only.
- Two end-to-end tests now drive real fills through the patched store (flat → reopen; reduce → add in one lot). With the protected patch reversed, they and the booking-stamp test fail; re-applied, the file passes 19/19.
- The migration keeps its original name `20261102120000`. It sorts before `main`'s later migrations, and `prisma migrate deploy` applies it as pending. Renaming it would break any database that already applied it from this branch, because plain `ADD COLUMN` fails on columns that already exist.
- `quant-safety-reviewer` on the applied diff: **APPROVE WITH NOTES**. Its notes are listed below.

**Deploy preconditions (v4):**
1. Back up the database and verify the restore.
2. Check `_prisma_migrations` for `20261102120000_order_position_lifecycle` on every environment. If it is present, the columns already exist and the migration is skipped.
3. **Drain or cancel pending PAPER SELLs** at deploy and at any redeploy after a rollback. Unstamped legacy SELLs stay unfenced, and BUYs filled by an old build are not counted.
4. Migrate before the new code starts. New code on the old schema fails; old code on the new schema is safe.

**Residuals from the v4 safety review:**
- SANDBOX `applyExternalFill` books without `lockAccount` (`apps/worker/src/sandbox-execution.ts`). This predates PCR-1. The counter uses an atomic increment, but SANDBOX SELLs are not fenced, so the invariants hold for PAPER only.
- A CAP overwrites `Order.qty`. The original booked quantity survives only as the reason code. Reservation release is still exactly once.
- Flatten exits are deliberately unfenced. They are capped only above the held quantity.


**v3 (after the independent v2 review, `RISK_REVIEW.md`):**
- **STRATEGY exits are fenced per owner.** Each `StrategyAllocation` has its own monotonic counter (`cumBoughtQty`), stamped at booking (`Order.allocationBoughtQtyAtBooking`). Another instance's trades never cancel or cap an owner's exit, and an owner's own re-buy after a pro-rata reduction is never sold by its old exit. This fixes the v2 review MEDIUM.
- **Exit remainders inherit** their pending parent's stamps.
- **Oversized flatten exits are capped** at the quantity held (`EXIT_CAPPED_TO_POSITION`) instead of being rejected.

The sections below describe the design including these changes.

Status: **design complete and tested; the protected half awaits operator approval.** Branch `apex/pcr-1-lifecycle-fence`, draft PR #45. PAPER-only. No risk default, entry control or live-money path changes. The protected file is unchanged, and the unlock file has not been created.

v1 fenced on the lot id only. The independent review (`RISK_REVIEW.md`) and the operator asked for two remaining issues to be resolved first:
- **F-PCR1-a:** the protection retry read the position identity outside the account lock.
- **F-PCR1-b:** a lot that is reduced and then increased keeps its id, so an old exit could reach new units.

v2 resolves both.

## 1. Defects

### D1: stale pending exit sells a reopened lot (reproduced)

A pending SELL is booked for lot L1. Protection closes L1, and an earlier-submitted pending BUY reopens the pair as L2 in the next settle loop: settle runs in `submittedAt` order, and F5 only cancels while the pair is flat. The stale SELL then sells L2.

Evidence: on `c3b23e9`, the integration reproduction filled the stale NET_CLOSE against a fresh $100 lot (−$0.69 round trip; the lot's new protection was lost).

Reachability:
- Entry de-duplication is per instance and pair, so a second strategy instance or an operator ticket can have a pending BUY on a held pair.
- `pendingNetCloseByPair` defers exits, not entries.

### D2: reduce then add within one lot (F-PCR1-b)

Suppose the exit is booked for 2 units, another exit sells 1, and an add buys 1. The lot id is unchanged, so a lot-id fence lets the old exit sell 2, which includes the unit bought after it was booked.

### D3: protection retry decides outside the lock (F-PCR1-a; reproduced)

`apps/worker/src/executor/protect.ts` read the leg, position, lot fence and quantity before `lockAccount`, then sold that quantity inside the lock. A concurrent close and reopen between the two slips past the fence.

Evidence: a deterministic race test holds the account lock in another transaction while it swaps the lot. On the old code the retry **sold the new lot** (1 filled SELL). On the new code it sells nothing and resolves the stale intent.

## 2. Design: a transaction-safe unit identity

| Element | Definition | Written |
| --- | --- | --- |
| `Position.cumBoughtQty` | Monotonic: total quantity ever bought on the row. Every BUY fill adds its quantity; it never decreases or resets, even across lots | In the same upsert, in the same account-locked transaction, that applies each fill (all three fill paths) |
| `Order.positionBoughtQtyAtBooking` | The counter's value when a SELL is booked | In the account-locked transaction that writes the pending SELL, and for exit remainders right after the parent fill in the same transaction |
| `Order.positionLifecycleId` | The lot id at booking | Same. Used for attribution and as a redundant fence |
| `StrategyAllocation.cumBoughtQty` (v3) | Monotonic per owner (instance × pair) | In the only allocation-increasing write, the BUY upsert in `applyAllocationFill`, inside the fill's transaction |
| `Order.allocationBoughtQtyAtBooking` (v3) | The owner's counter when a STRATEGY SELL is booked | With the other stamps. Remainders inherit their parent's stamps |

**STRATEGY exits** apply the same formula to the owner's allocation: `allowed = allocQty − (allocCum(now) − stamp)`. This is first-in first-out *within the owner*. **Pair-level exits** (NET_CLOSE, PROTECTION, OPERATOR, LEGACY) use FIFO across the pair. In a pair held by several owners, that can cancel a pair-level exit an ownership-aware reading would allow. That outcome is conservative: the planner re-plans the next cycle and protection stays armed. A STRATEGY row without an owner stamp (legacy) falls back to the pair level.

At settlement (`exitFence`, `packages/shared/src/position-lot.ts`, pure):

```
added   = cumBoughtQty(now) − stamp        (≥ 0 by monotonicity; < 0 ⇒ inconsistent ⇒ cancel)
allowed = qty(now) − added
allowed ≤ 0          → CANCEL  EXIT_LIFECYCLE_MISMATCH   (no booked unit survives; covers reopen)
allowed < order qty  → CAP     EXIT_CAPPED_TO_BOOKED_LOT (sell only the surviving booked units)
otherwise            → PROCEED
```

Under first-in first-out unit accounting, `allowed` is exactly the number of booked units still held. Units bought after booking are consumed only once every booked unit is gone. So a capped exit can never sell a unit acquired after it was booked. This is proven against an independent unit-level model (§3).

Unchanged behaviour:
- **Flat pair:** cancels every pending SELL (F5, `EXIT_SUPERSEDED`).
- **Flatten exits** (`ACCOUNT_FLATTEN` or `FLATTEN`): never capped, because they mean "be flat now".
- **Unstamped legacy rows:** proceed as today. A lot-only stamp still fences a different lot.

Applying a decision happens in the worker settle loop, under the same lock:
- **CANCEL** releases reservations exactly as F5 does.
- **CAP** shrinks `Order.qty` and releases only the excess STRATEGY reserved exit quantity.

**Protection retry.** It reads every input under the lock and fences on the lot id. Lot-wide protection is the existing design: legs are rescaled to the whole lot on adds (`armProtectionForFill`). A retry for the open lot therefore protects the whole lot, while a retry for a closed lot never touches a reopened one.

### Coverage of the lifecycle events the operator listed

| Event | Mechanism | Evidence |
| --- | --- | --- |
| Initial fill (open) | The counter rises; the lot id is minted | patch; property model |
| Addition | The counter rises; the lot id is kept | unit and integration tests (cap) |
| Reduction | Neither changes; the existing exit cap applies | unit (cap at survivors) |
| Closure | Qty 0 → F5 cancel | unit; v1 tests |
| Reopening | Counter delta ≥ new qty → cancel; the lot id also differs | reproduction test; unit; property |
| Pending orders | Stamp at booking; fence at every settle, including before eligibility | integration (OPERATOR before eligibility; STRATEGY cap persisted) |
| Retries | Protection retry under the lock with the lot fence; exit remainders stamped in the parent's transaction | race test; patch |
| Concurrent events | Everything is read and written under `lockAccount` (`FOR UPDATE`). Two concurrent settles release a reservation exactly once | integration (concurrent settles; race test) |
| Worker recovery | Stamps and counters are durable. Re-running settle from a fresh client after a restart is idempotent | integration (recovery) |

## 3. Evidence (executed 2 Nov 2026, local Postgres 16)

Unit and property tests (`packages/shared/src/position-lot.test.ts`, 14 tests):
- Lifecycle cases, plus a property test against an independent FIFO unit model: 3,000 random sequences of buys, reductions, bookings and settlements, with more than 5,000 settlement checks. It asserts exact agreement and that no sold unit was bought after booking.
- **Mutation:** making the fence ignore the counter (v1 behaviour) fails 6 tests.

v3 additions, all passing:
- 5 unit tests, including the review's multi-owner scenario and a **per-owner property test**: 2,000 runs with two owners trading independently, more than 3,000 checks. Each STRATEGY decision must equal that owner's own FIFO survivors. Mutation: disabling the per-owner branch fails 4 tests.
- 4 integration tests:
  - another owner's trades do not cancel B's exit
  - an owner's re-buy after a pro-rata reduction is not sold
  - CAP then expiry releases exactly the original reservation, checked with an extra 0.5 reservation so the clamp cannot hide a double release
  - an oversized flatten is capped and fills

Branch-wide at v3: `pnpm test` gives **922 passed, 1 failed (the booking stamp, by design), 25 skipped**. `pnpm typecheck` and lint are clean (lint excludes local agent worktrees).

Integration tests (`apps/worker/src/executor/lifecycle-fence.integration.test.ts`, 18 at v3; listed below are those from v2). Positions are seeded in the state the patched fills produce:

| Test | Result |
| --- | --- |
| Stale NET_CLOSE after reopen is cancelled (reproduction, D1) | pass. **Fails on `c3b23e9`** |
| Same-lot exit fills (control) | pass |
| Flatten exempt | pass |
| Legacy unstamped row unchanged | pass |
| OPERATOR reduce fenced before eligibility | pass |
| Fenced STRATEGY exit releases its reservation, clamped | pass |
| Reduce-then-add caps to the surviving booked units (D2) | pass |
| Two exits from one booking cannot oversell the survivors | pass |
| Capped STRATEGY exit releases only the excess reservation | pass |
| Concurrent settles release exactly once | pass |
| Recovery: re-run from a fresh client is idempotent | pass |
| Protection retry racing close and reopen never sells the new lot (D3) | pass. **Fails on the old `protect.ts`** |
| Booking stamps lot and counter on a pending SELL, none on a BUY | **fails by design**: needs the protected patch |

Migration order (`packages/shared/src/pcr1-migration.test.ts` plus two executed experiments):
- **Static test.** The migration contains only `ADD COLUMN` statements: nullable, or `NOT NULL DEFAULT 0`. No drop, rename, retype, rewrite or index.
- **Old code on the new schema.** The full `c3b23e9` suite against the migrated database gave 153 files and **822 passed**, 25 skipped, identical to the baseline. **Migrating first is safe** for the running build. Re-run against the **v3** migration (five columns, including `StrategyAllocation.cumBoughtQty`) gave the same result: 822 passed, 25 skipped.
- **New code on the old schema.** All 13 PCR-1 integration tests fail with "The column `cumBoughtQty` does not exist". **The code must not run before the migration.**

The protected patch (`store-stamping.patch`) passes `git apply --check` on `c3b23e9` and on current `main`. It is not applied, and the patched build has not been executed; that happens after the unlock.

## 4. Protected change requested (for operator approval)

`docs/apex/pcr-1/store-stamping.patch` covers two protected files and passes `git apply --check` on current `main`.

`packages/trading-engine/src/store.ts`:
- `currentLotStamp()` stamps three things on pending SELLs (`commitProposedOrder`): the lot id, the pair counter, and for STRATEGY the owner's allocation counter.
- Exit remainders (`bookExitRemainder`) **inherit** the pending parent's stamps, which `settlePendingOrder` passes through. An immediate parent is stamped in the transaction of its own fill, which equals its state at booking.
- `boughtDelta()` increments `Position.cumBoughtQty` on BUY fills in `fillExistingPending`, `fillCommittedOrder` and `applyExternalFill`, in the same position upsert.

`packages/trading-engine/src/strategy-allocations.ts`:
- `applyAllocationFill` (BUY upsert) increments `StrategyAllocation.cumBoughtQty`. Repository-wide grep confirms this is the only allocation-increasing write.

After the unlock:
1. Apply the patch.
2. Run the full suite; all 14 PCR-1 integration tests must pass.
3. Add the store-level remainder test and an end-to-end executor test (admit, then `evaluateProtections`, then the next settle).
4. Run `quant-safety-reviewer`.
5. Keep the PR in draft until review.

## 5. Rollout (after approval)

1. Back up, then verify the restore with `scripts/restore-verify.mjs`.
2. **Apply the migration first.** It is metadata-only on PostgreSQL 16: no rewrite, no index build. The running build keeps working (experiment above).
3. Rebuild packages and worker, then restart the worker and the API.
4. Smoke: health; `EXECUTION_MODE=PAPER`; cycles advancing; there may be `EXIT_LIFECYCLE_MISMATCH` and `EXIT_CAPPED_TO_BOOKED_LOT` reasons, and they should be rare.
5. Rollback: redeploy the previous build and keep the columns. Never drop them while a new build may run.

## 6. Residuals

- The FIFO interpretation is a choice. The ledger itself is average-cost and fungible. FIFO is the strictest reading that guarantees "never sells newer units"; it can cancel or shrink an exit that a looser reading would allow. The planner re-plans the next cycle, and protection remains armed.
- SANDBOX orders already at the broker are outside the local settle loop. They are stamped, but nothing reads the stamp.
- Positions open at deploy time start the counter at 0. Only differences are used, so this is exact for every exit booked after the deploy.
- **Re-deploy after a rollback.** BUYs filled while an old build ran are not counted, so stamps taken before the rollback can under-fence a reduce-then-add. The lot-id fence still catches a reopen. After a rollback, re-deploy only once there are no pending SELLs, or cancel pending pair-level SELLs at re-deploy.
- **Stamp at insert, not at decision** (LOW). With `paperLatencyMs = 0`, an earlier immediate BUY in the same plan raises the counter before a same-pair SELL is stamped. Such a SELL fills immediately, so the fence does not apply to it. Its *exit-policy remainder*, however, is pending and is stamped after that BUY, so the remainder may sell units from the same-plan BUY (re-review LOW). Closing this needs stamps taken from the plan's book snapshot, which is a planner change and out of scope.
- **Over-attributed allocations** (re-review LOW, fixed): a STRATEGY exit is also capped at the pair's quantity (`EXIT_CAPPED_TO_POSITION`), so an allocation larger than the position cannot cause a `SELL_EXCEEDS_POSITION` reject.
- **SANDBOX external fills** run without the account lock (pre-existing; `sandbox-execution.ts`). The counter increments atomically, so it stays monotonic.
- **Pre-existing, LOW:** a resolved protection leg is marked FILLED even when nothing sold, and a crash-replayed retry returns `IDEMPOTENT_REPLAY` without resolving.
