-- ASCEND-09: point-in-time trade memory. One row per fill (ENTRY at lot open, ADD, EXIT for each
-- reducing fill), written by the worker after the executor transaction commits. Additive only: no
-- existing table, column or trigger is changed.
CREATE TABLE "TradeLotSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "entryFillId" TEXT NOT NULL,
    "fillId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "lifecycleId" TEXT,
    "lifecycleIdSource" TEXT,
    "strategyInstanceId" TEXT,
    "strategyVersion" TEXT,
    "configHash" TEXT,
    "view" JSONB NOT NULL,
    "viewHash" TEXT NOT NULL,
    "builderVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeLotSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeLotSnapshot_fillId_key" ON "TradeLotSnapshot"("fillId");

-- CreateIndex
CREATE INDEX "TradeLotSnapshot_accountId_asOf_idx" ON "TradeLotSnapshot"("accountId", "asOf");

-- CreateIndex
CREATE INDEX "TradeLotSnapshot_accountId_entryFillId_idx" ON "TradeLotSnapshot"("accountId", "entryFillId");

-- CreateIndex
CREATE INDEX "TradeLotSnapshot_accountId_phase_asOf_idx" ON "TradeLotSnapshot"("accountId", "phase", "asOf");

-- Snapshots are evidence: updates and deletes are rejected (TRUNCATE remains possible for test resets).
CREATE TRIGGER "TradeLotSnapshot_append_only"
  BEFORE UPDATE OR DELETE ON "TradeLotSnapshot"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();
