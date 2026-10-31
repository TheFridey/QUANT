-- Audit F1: one immutable plan per cycle. SENTINEL writes it once; later stages and the executor
-- read it. Updates are refused (deletes stay possible for retention and test resets).
CREATE TABLE "CyclePlan" (
    "cycleId" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "plan" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CyclePlan_pkey" PRIMARY KEY ("cycleId")
);

CREATE TRIGGER "CyclePlan_immutable"
  BEFORE UPDATE ON "CyclePlan"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();
