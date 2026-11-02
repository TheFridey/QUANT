# PCR-1 independent risk review

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
