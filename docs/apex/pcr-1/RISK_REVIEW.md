# PCR-1 independent risk reviews

## Review 2 (v2, head `a550c23`)

The reviewer worked in a separate context and modified nothing. It ran:
- the PCR-1 tests: 33/34, the 1 being the expected booking-stamp failure
- `git apply --check`
- a `prisma migrate diff`: no Order or Position drift
- pure `exitFence` scenarios

It verified by grep that there are exactly three `Position.baseQty` write paths and that each one is patched, and that every stamp is taken under the account lock.

Verdicts:
- **non-protected half: APPROVE WITH NOTES**
- **protected patch: APPROVE WITH NOTES**. Before merge it requires: remainder-stamp inheritance; the multi-owner cancellation accepted or fixed; the added tests; and a second review of the applied diff.

| Severity | Finding | Disposition (v3) |
| --- | --- | --- |
| MEDIUM | Pair-wide FIFO ignores ownership. Instance A's buys and sells can cancel B's legitimate exit, and an owner's own re-buy after a pro-rata reduction could be sold by its old exit | **Fixed.** Each `StrategyAllocation` has its own monotonic counter, and STRATEGY exits fence per owner. Unit tests, integration tests and a per-owner property test cover it; disabling the branch fails 4 tests. Pair-level scopes keep pair FIFO, and the residual is documented: conservative, re-planned next cycle |
| LOW | Remainders were re-stamped after the parent fill instead of inheriting, so a remainder could sell a post-booking unit | **Fixed in the patch.** `settlePendingOrder` passes the parent's stamps and `bookExitRemainder` inherits them. An immediate parent is unchanged, since its stamp equals its booking state |
| LOW | Flatten is exempt from the cap and is rejected `SELL_EXCEEDS_POSITION` after a partial reduction (pre-existing) | **Fixed.** Capped at the quantity held (`EXIT_CAPPED_TO_POSITION`); integration test |
| LOW | CAP test reservation equals the order quantity, so the clamp could hide a double release | **Fixed.** A CAP-then-expiry test with an extra 0.5 reservation passes |
| LOW | Stamp taken at insert, not at decision (`paperLatencyMs = 0`, same plan) | Documented (ANALYSIS §6). Such a SELL fills immediately and is never fenced |
| LOW | SANDBOX external fills run unlocked (pre-existing) | Documented. The counter increment is atomic |
| LOW | Re-deploy after a rollback can under-fence stamps from before the rollback | Runbook note (ANALYSIS §6) |
| LOW | Protection: resolved legs are marked FILLED; a crash replay never resolves (pre-existing) | Documented; out of scope |
| Tests after unlock | Each patched upsert increments its counter (including `applyExternalFill` and the allocation); CAP then fill or reject; remainder inheritance; the end-to-end admit → `evaluateProtections` → settle path | Listed in ANALYSIS §4. They require the unlock |

## Review 1 (v1)

A reviewer in a separate context read the analysis, the branch diff, the protected patch (not applied) and the real code paths. It ran the fence tests and `git apply --check` and modified nothing. Branch head reviewed: `9450483`.

## Verdicts

- **Non-protected half** (migration, reason code, settle fence): **APPROVE WITH NOTES**
- **Protected stamping patch** (`store-stamping.patch`): **APPROVE WITH NOTES**. Apply only after the operator unlock; then confirm every PCR-1 test passes and add the remainder-inheritance test.

## Findings and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| MEDIUM | Deploy order is not independent. A worker built with the new Prisma client fails every `Order` read against the old schema, including exits. The analysis said "either order" | **Fixed in docs.** ANALYSIS §2 and §4 and the migration header now say: migrate first, and keep the column on rollback |
| LOW | Non-concurrent `CREATE INDEX` on a large `Order` table blocks writes, and nothing queries by the column | **Fixed.** The index was removed from the schema and the migration; re-applied cleanly on the local test database |
| LOW | The cross-cycle T0 < T1 sequence needs the BUY to survive a full settle without an eligible fill observation (overstated) | Accepted. A second path exists within one cycle, where equal `submittedAt` order is arbitrary. With stamping, both orders are handled: F5 cancels the SELL if it is processed while flat, and the fence cancels it if the BUY reopened the pair first. No tie-break is needed once stamping lands |
| LOW | Protection retry in `apps/worker/src/executor/protect.ts:41-48` reads the lot fence outside the account lock, then fills immediately (pre-existing; immediate fills are not covered by PCR-1) | Recorded as follow-up **F-PCR1-a** in the ledger. Separate change |
| LOW | A stale exit against a lot reduced then re-increased keeps the same lifecycle id, so it is not fenced (pre-existing semantics: same lot) | Recorded as follow-up **F-PCR1-b**. It needs a lot *version*, not just an id. Out of scope |
| LOW | SANDBOX SELLs would be stamped but nothing reads the stamp | Documented. SANDBOX orders are outside the local settle loop by design (F01) |
| Test gap | Seeded rows only; missing STRATEGY reservation, OPERATOR scope, not-yet-eligible, remainder inheritance, end-to-end executor path | STRATEGY, OPERATOR and not-yet-eligible tests **added and passing**. Remainder inheritance and the end-to-end path are listed for the unlocked change |

## Confirmed by the reviewer

- **Release path.** Identical to F5. SELLs hold no `RiskReservation`, so `releaseInTx` does nothing. `releaseExitQty` clamps at zero, and the stale SELL is cancelled before any new plan could reserve against the new lot.
- **Protection.** The new lot is armed by `armProtectionForFill` in the same settle loop. The old lot's legs were cancelled when it went flat.
- **Scopes and states.**
  - Flatten exits are exempt.
  - When halted, pending BUYs are cancelled before they can reopen the pair.
  - Legacy positions with a null lot are never stamped.
  - Replays skip.
- **Stamping coverage.** Production code inserts orders only in `store.ts` (remainder, pending, filled, rejected). The patch stamps both pending inserts, under the account lock, after the in-transaction re-plan.
