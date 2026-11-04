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
3. **Settle** (`settleReservation`): only when every attempt of the call succeeded **and** its usage row was persisted is the `RESERVED` row deleted (`DELETE … WHERE id = :id AND "costKind" = 'RESERVED'`); the actual usage rows are then the record. Otherwise the reservation is **kept** at its full worst case, its `error` is set to `RETAINED for research experiment <id>: <reason>`, and the tick result lists it (`reservationsRetained`, logged by the worker):
   - `FAILED_ATTEMPT`: a TIMEOUT/UPSTREAM attempt is recorded by the router at prompt-only cost, but the provider may bill up to the token limit and may keep running after the client timeout (review L1);
   - `USAGE_NOT_PERSISTED`: `onUsage` failed to write the usage row, so the reservation is the only record of a possibly billed call (review M2);
   - `CALL_THREW` and `SETTLE_FAILED`: the call or the delete threw (review L3).
   The router caps each recorded completion estimate at 2 × the token limit, the bound the reservation covers, so a settled call never records more than it reserved (review L2).

Properties:
- Reservations of concurrent loop processes are serialised by the lock and each sees the others' committed reservations, so their combined worst case never exceeds the cap.
- The API pipeline (which reads the same sum) sees loop reservations, so it is also more conservative; it does not take the lock itself (its own in-process serialisation, M-2, is unchanged).
- **Fail closed**: a process that crashes between reserve and settle leaves its `RESERVED` row counted until the UTC day ends. It is never reaped automatically, because the provider may have charged the call before the crash.
- A refused reservation is `BUDGET_EXHAUSTED: RESERVATION_REFUSED …`: the lease is released, attempts are unchanged, and a `HELD` event is written when the reason changes.

**Residuals (not fixed here):**
- **API + loop can still exceed the cap together.** The operator-initiated API pipeline (`apps/api/src/evolution.service.ts`, `researchBudgetWindow`, lines 85–93) reads the same daily sum, so it sees loop reservations, but it does not take lock 8080802 or reserve before calling. A loop call and an API pipeline call at the same moment can therefore still overshoot (the accepted M-2 residual, unchanged). Fixing it means routing API pipeline calls through `reserveResearchBudget`.
- **Pre-PR experiments become eligible again.** Terminal experiments created before this change have no pinned `context.dataset`, so the task scorer treats any versioned dataset of their hypothesis as new evidence and may queue the hypothesis once more (subject to the daily and concurrency caps, the redundancy guard and the holdout registry).

Remaining limits: costs are still router estimates, not provider-billed amounts; the calendar-day window still allows about 2 × the cap across UTC midnight; `RESERVED` rows are visible in usage listings while in flight (provider `reservation`).

## Tests

- Unit (`research-phase8.test.ts`): worst-case estimate; refusal when spent + reserve > cap; unreadable spend refused.
- Integration (`research-loop.integration.test.ts`, only with `DATABASE_URL_TEST` naming an `*odin_test*` database): two connections reserving concurrently, only one fits; an orphaned reservation keeps the next tick from calling a model (`HELD`, once); a successful call leaves no `RESERVED` row; a failed attempt keeps its reservation and reports it.
