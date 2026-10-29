-- AlterTable
ALTER TABLE "ExperimentReport" ADD COLUMN     "artifactHash" TEXT,
ADD COLUMN     "backtestRunId" TEXT,
ADD COLUMN     "configHash" TEXT,
ADD COLUMN     "datasetHash" TEXT,
ADD COLUMN     "provenance" TEXT NOT NULL DEFAULT 'LEGACY_INCOMPLETE',
ADD COLUMN     "sourceHash" TEXT;

-- CreateTable
CREATE TABLE "StrategyArtifact" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "moduleRef" TEXT,
    "moduleVersion" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "runtimeLoadable" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionApproval" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "reportContentHash" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyPromotion" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "validationStatus" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "provenance" TEXT NOT NULL,
    "reportId" TEXT,
    "approvalId" TEXT,
    "artifactId" TEXT,
    "strategyId" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "moduleRef" TEXT,
    "moduleVersion" TEXT,
    "sourceHash" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "activeStrategy" JSONB,
    "previousPromotionId" TEXT,
    "previousActiveStrategy" JSONB,
    "previousConfig" JSONB NOT NULL,
    "rollbackOfId" TEXT,
    "deploymentEligible" BOOLEAN NOT NULL DEFAULT false,
    "liveEligible" BOOLEAN NOT NULL DEFAULT false,
    "operator" TEXT NOT NULL,
    "label" TEXT,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForwardPaperResult" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "closedTradeCount" INTEGER NOT NULL,
    "netPnlUsd" TEXT,
    "returnPct" TEXT,
    "closedPnls" JSONB NOT NULL,
    "method" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForwardPaperResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StrategyArtifact_artifactHash_key" ON "StrategyArtifact"("artifactHash");

-- CreateIndex
CREATE INDEX "StrategyArtifact_moduleRef_idx" ON "StrategyArtifact"("moduleRef");

-- CreateIndex
CREATE INDEX "PromotionApproval_reportId_createdAt_idx" ON "PromotionApproval"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "PromotionApproval_artifactHash_configHash_idx" ON "PromotionApproval"("artifactHash", "configHash");

-- CreateIndex
CREATE INDEX "StrategyPromotion_createdAt_idx" ON "StrategyPromotion"("createdAt");

-- CreateIndex
CREATE INDEX "StrategyPromotion_artifactHash_configHash_idx" ON "StrategyPromotion"("artifactHash", "configHash");

-- CreateIndex
CREATE INDEX "ForwardPaperResult_artifactHash_configHash_createdAt_idx" ON "ForwardPaperResult"("artifactHash", "configHash", "createdAt");

-- CreateIndex
CREATE INDEX "ForwardPaperResult_promotionId_idx" ON "ForwardPaperResult"("promotionId");

-- CreateIndex
CREATE INDEX "ExperimentReport_artifactHash_configHash_idx" ON "ExperimentReport"("artifactHash", "configHash");

-- Evidence immutability (Stage 28). Row triggers do not fire on TRUNCATE, so test resets still work.
CREATE OR REPLACE FUNCTION odin_reject_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EVIDENCE_IMMUTABLE: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION odin_guard_experiment_report() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EVIDENCE_IMMUTABLE: experiment reports are never deleted (id=%)', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
    OR NEW."signature" IS DISTINCT FROM OLD."signature"
    OR NEW."hypothesisId" IS DISTINCT FROM OLD."hypothesisId"
    OR NEW."strategyModuleId" IS DISTINCT FROM OLD."strategyModuleId"
    OR NEW."strategyVersion" IS DISTINCT FROM OLD."strategyVersion"
    OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
    OR NEW."sourceHash" IS DISTINCT FROM OLD."sourceHash"
    OR NEW."artifactHash" IS DISTINCT FROM OLD."artifactHash"
    OR NEW."configHash" IS DISTINCT FROM OLD."configHash"
    OR NEW."datasetHash" IS DISTINCT FROM OLD."datasetHash"
    OR NEW."backtestRunId" IS DISTINCT FROM OLD."backtestRunId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'EVIDENCE_IMMUTABLE: experiment report evidence columns cannot change (id=%)', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExperimentReport_evidence_immutable"
  BEFORE UPDATE OR DELETE ON "ExperimentReport"
  FOR EACH ROW EXECUTE FUNCTION odin_guard_experiment_report();

CREATE TRIGGER "StrategyArtifact_append_only"
  BEFORE UPDATE OR DELETE ON "StrategyArtifact"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();

CREATE TRIGGER "PromotionApproval_append_only"
  BEFORE UPDATE OR DELETE ON "PromotionApproval"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();

CREATE TRIGGER "StrategyPromotion_append_only"
  BEFORE UPDATE OR DELETE ON "StrategyPromotion"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();

CREATE TRIGGER "ForwardPaperResult_append_only"
  BEFORE UPDATE OR DELETE ON "ForwardPaperResult"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();

CREATE TRIGGER "LifecycleAudit_append_only"
  BEFORE UPDATE OR DELETE ON "LifecycleAudit"
  FOR EACH ROW EXECUTE FUNCTION odin_reject_evidence_mutation();
