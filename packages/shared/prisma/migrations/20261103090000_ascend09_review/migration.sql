-- ASCEND-09 review fixes. Additive only: one new column, two new triggers.

-- M2: AgentDecision rows are upserted (content overwritten, createdAt kept), so a point-in-time view
-- needs the time of the last write. Existing rows get the migration time: their update history is
-- unknown, so views treat them as possibly changed after any earlier fill (never as unchanged).
ALTER TABLE "AgentDecision" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Raw SQL updates bypass Prisma's @updatedAt: never let updatedAt stay behind the actual write time.
-- Columns are UTC timestamps without time zone, as Prisma writes them.
CREATE OR REPLACE FUNCTION odin_agent_decision_touch() RETURNS trigger AS $$
DECLARE
  written TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  NEW."updatedAt" := GREATEST(COALESCE(NEW."updatedAt", written), written);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AgentDecision_touch_updatedAt"
  BEFORE UPDATE ON "AgentDecision"
  FOR EACH ROW EXECUTE FUNCTION odin_agent_decision_touch();

-- L4: TradeLotSnapshot already rejects UPDATE and DELETE; reject TRUNCATE as well.
CREATE TRIGGER "TradeLotSnapshot_no_truncate"
  BEFORE TRUNCATE ON "TradeLotSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_reject_evidence_mutation();
