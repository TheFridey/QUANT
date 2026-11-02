# PCR-1: fence pending exits to the units they were booked against (v2)

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

Integration tests (`apps/worker/src/executor/lifecycle-fence.integration.test.ts`, 14 tests). Positions are seeded in the state the patched fills produce:

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
- **Old code on the new schema.** The full `c3b23e9` suite against the migrated database gave 153 files and **822 passed**, 25 skipped, identical to the baseline. **Migrating first is safe** for the running build.
- **New code on the old schema.** All 13 PCR-1 integration tests fail with "The column `cumBoughtQty` does not exist". **The code must not run before the migration.**

The protected patch (`store-stamping.patch`) passes `git apply --check` on `c3b23e9` and on current `main`. It is not applied, and the patched build has not been executed; that happens after the unlock.

## 4. Protected change requested (for operator approval)

`docs/apex/pcr-1/store-stamping.patch`, `packages/trading-engine/src/store.ts` only:
- `currentLotStamp()`: stamps lot id and counter on pending SELLs (`commitProposedOrder`) and on exit remainders (`bookExitRemainder`, after the parent fill, same transaction).
- `boughtDelta()`: increments `cumBoughtQty` by the fill quantity on BUY fills in `fillExistingPending`, `fillCommittedOrder` and `applyExternalFill`, in the same position upsert.

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
