-- PCR-1 (APEX): fence pending exits to the position lot they were booked against.
-- Additive and nullable: existing rows stay NULL and keep today's settle behaviour; code that does not
-- know the column ignores it, so this migration is safe to apply before the code that uses it.
ALTER TABLE "Order" ADD COLUMN "positionLifecycleId" TEXT;

CREATE INDEX "Order_positionLifecycleId_idx" ON "Order"("positionLifecycleId");
