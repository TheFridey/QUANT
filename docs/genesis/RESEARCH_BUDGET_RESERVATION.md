# Research budget reservation (GENESIS Phase 8)

Status: **implemented for research-loop model calls, no migration.** Code: `reserveResearchBudget` in `packages/evolution/src/research-loop.ts`; pure parts (`reservationEstimateUsd`, `reservationDecision`, `RESEARCH_BUDGET_LOCK`) in `packages/evolution/src/budget-store.ts`. Spending limits are unchanged (the cap is still `AutonomyControl.maxResearchBudgetUsd`); the check is stricter than before.

## Problem (accepted residual, ASCEND-08 "Budget race across processes" / M-2)

Each model call re-read the UTC-day sum of `ModelUsageLog.costUsdEst` and then called the provider. Two processes reading at the same moment could each spend one call past the cap, and a single call could overshoot the remaining budget by its own cost (L5).

## Design: reservation, then settle, on the existing `ModelUsageLog`

1. **Reserve** (one short transaction):
   ```sql
   SELECT pg_advisory_xact_lock(8080802);            -- RESEARCH_BUDGET_LOCK, serialises reservations
   SELECT sum("costUsdEst") FROM "ModelUsageLog"
    WHERE "createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC');  -- settled usage + every RESERVED row
   -- refuse unless spent + worst_case <= cap (fail closed on unreadable values)
   INSERT INTO "ModelUsageLog" (..., "provider", "model", "costUsdEst", "costKind", "provenance", "error")
   VALUES (..., 'reservation', 'RESERVATION', :worst_case, 'RESERVED', 'RESERVATION', 'RESERVED for research experiment <id>');
   COMMIT;                                           -- the lock is released; the row is now visible to every reader
   ```
   Worst case = every endpoint in the assignment chain × 2 attempts (the router's one retry) × (prompt tokens + 2 × the completion limit) at the configured per-1k prices.
2. **Call** the model outside the lock. `onUsage` writes each actual usage row as before.
3. **Settle**: delete the `RESERVED` row by id (`DELETE … WHERE id = :id AND "costKind" = 'RESERVED'`). The actual usage rows remain the record.

Properties:
- Reservations of concurrent loop processes are serialised by the lock and each sees the others' committed reservations, so their combined worst case never exceeds the cap.
- The API pipeline (which reads the same sum) sees loop reservations, so it is also more conservative; it does not take the lock itself (its own in-process serialisation, M-2, is unchanged).
- **Fail closed**: a process that crashes between reserve and settle leaves its `RESERVED` row counted until the UTC day ends. It is never reaped automatically, because the provider may have charged the call before the crash.
- A refused reservation is `BUDGET_EXHAUSTED: RESERVATION_REFUSED …`: the lease is released, attempts are unchanged, and a `HELD` event is written when the reason changes.

Remaining limits: costs are still router estimates, not provider-billed amounts; the calendar-day window still allows about 2 × the cap across UTC midnight; `RESERVED` rows are visible in usage listings while in flight (provider `reservation`).

## Tests

- Unit (`research-phase8.test.ts`): worst-case estimate; refusal when spent + reserve > cap; unreadable spend refused.
- Integration (`research-loop.integration.test.ts`, only with `DATABASE_URL_TEST` naming an `*odin_test*` database): two connections reserving concurrently, only one fits; an orphaned reservation keeps the next tick from calling a model (`HELD`, once); a successful call leaves no `RESERVED` row.
