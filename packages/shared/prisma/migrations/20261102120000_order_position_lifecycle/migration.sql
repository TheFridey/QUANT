-- PCR-1 (APEX): fence pending exits to the units they were booked against.
--
-- Additive only:
--   * "Order"."positionLifecycleId"        TEXT NULL           lot id at booking (attribution + redundant fence)
--   * "Order"."positionBoughtQtyAtBooking" DECIMAL(38,8) NULL  Position.cumBoughtQty at booking
--   * "Position"."cumBoughtQty"            DECIMAL(38,8) NOT NULL DEFAULT 0, monotonic per position row
-- On PostgreSQL 11+ adding a column with a constant default is a metadata-only change (no table rewrite).
-- Existing rows: orders stay NULL (legacy: today's settle behaviour); positions start at 0. Only differences
-- of the counter are ever used, so a 0 start is exact for every exit booked after the deploy.
--
-- DEPLOY ORDER: apply this migration BEFORE starting a build whose Prisma client knows these columns.
-- A new client selects them on every Order/Position query and fails against the old schema. The previous
-- build ignores them (verified: the pre-change test suite passes against the migrated schema).
-- Rollback: redeploy the previous build; never drop these columns while a new build may still run.
--
-- No index: nothing queries by these columns (settle reads them from rows it already holds). If one is
-- needed later, add it in its own migration with CREATE INDEX CONCURRENTLY to avoid blocking writes.
ALTER TABLE "Order" ADD COLUMN "positionLifecycleId" TEXT;
ALTER TABLE "Order" ADD COLUMN "positionBoughtQtyAtBooking" DECIMAL(38,8);
ALTER TABLE "Position" ADD COLUMN "cumBoughtQty" DECIMAL(38,8) NOT NULL DEFAULT 0;
