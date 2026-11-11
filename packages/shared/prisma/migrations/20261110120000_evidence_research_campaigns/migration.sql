-- CreateTable
CREATE TABLE "ResearchCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specVersion" TEXT NOT NULL,
    "specCanonical" TEXT NOT NULL,
    "specHash" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchCampaignRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "codeVersion" TEXT NOT NULL,
    "versions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchCampaignRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchCampaignRunState" (
    "runId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelRequestedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchCampaignRunState_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "ResearchCampaignUnit" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "datasetKey" TEXT NOT NULL,
    "hypothesisKind" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "plannedTrials" INTEGER NOT NULL,
    "unitSpecHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchCampaignUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchCampaignResult" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasons" TEXT[],
    "walkForwardPassed" BOOLEAN NOT NULL,
    "holdoutStatus" TEXT NOT NULL,
    "trialCount" INTEGER NOT NULL,
    "priorTrials" INTEGER NOT NULL,
    "dataset" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "detailCanonical" TEXT NOT NULL,
    "resultHash" TEXT NOT NULL,
    "runtimeMs" INTEGER NOT NULL,
    "peakRssMb" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchCampaignResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchCampaignEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "unitId" TEXT,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchCampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchTrialLedger" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unitId" TEXT,
    "trials" INTEGER NOT NULL,
    "priorTrials" INTEGER,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchTrialLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchHoldoutLedger" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "lineageKey" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "barMs" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "resultHash" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchHoldoutLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchCampaign_specHash_key" ON "ResearchCampaign"("specHash");

-- CreateIndex
CREATE INDEX "ResearchCampaign_createdAt_idx" ON "ResearchCampaign"("createdAt");

-- CreateIndex
CREATE INDEX "ResearchCampaignRun_createdAt_idx" ON "ResearchCampaignRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchCampaignRun_campaignId_runNumber_key" ON "ResearchCampaignRun"("campaignId", "runNumber");

-- CreateIndex
CREATE INDEX "ResearchCampaignRunState_state_idx" ON "ResearchCampaignRunState"("state");

-- CreateIndex
CREATE INDEX "ResearchCampaignUnit_state_leaseExpiresAt_idx" ON "ResearchCampaignUnit"("state", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchCampaignUnit_runId_seq_key" ON "ResearchCampaignUnit"("runId", "seq");

-- CreateIndex
CREATE INDEX "ResearchCampaignResult_verdict_idx" ON "ResearchCampaignResult"("verdict");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchCampaignResult_unitId_phase_key" ON "ResearchCampaignResult"("unitId", "phase");

-- CreateIndex
CREATE INDEX "ResearchCampaignEvent_runId_createdAt_idx" ON "ResearchCampaignEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchCampaignEvent_unitId_createdAt_idx" ON "ResearchCampaignEvent"("unitId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchTrialLedger_kind_idx" ON "ResearchTrialLedger"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchTrialLedger_unitId_kind_key" ON "ResearchTrialLedger"("unitId", "kind");

-- CreateIndex
CREATE INDEX "ResearchHoldoutLedger_instrumentKey_barMs_lineageKey_idx" ON "ResearchHoldoutLedger"("instrumentKey", "barMs", "lineageKey");

-- CreateIndex
CREATE INDEX "ResearchHoldoutLedger_unitId_kind_idx" ON "ResearchHoldoutLedger"("unitId", "kind");

-- AddForeignKey
ALTER TABLE "ResearchCampaignRun" ADD CONSTRAINT "ResearchCampaignRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchCampaignRunState" ADD CONSTRAINT "ResearchCampaignRunState_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchCampaignRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchCampaignUnit" ADD CONSTRAINT "ResearchCampaignUnit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchCampaignRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchCampaignResult" ADD CONSTRAINT "ResearchCampaignResult_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ResearchCampaignUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchCampaignEvent" ADD CONSTRAINT "ResearchCampaignEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchCampaignRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------
-- OPERATION EVIDENCE guards. Additive only: new tables, no change to any existing table.
-- ---------------------------------------------------------------------------------------------------------

-- A consume intent and a closing row (RESULT_RECORDED or RESULT_LOST) exist at most once per unit, so two
-- executors can never both read one holdout and a retry can never read it again.
CREATE UNIQUE INDEX "ResearchHoldoutLedger_one_intent_per_unit" ON "ResearchHoldoutLedger"("unitId") WHERE "kind" = 'CONSUME_INTENT';
CREATE UNIQUE INDEX "ResearchHoldoutLedger_one_close_per_unit" ON "ResearchHoldoutLedger"("unitId") WHERE "kind" IN ('RESULT_RECORDED', 'RESULT_LOST');

ALTER TABLE "ResearchCampaign" ADD CONSTRAINT "ResearchCampaign_spec_hash" CHECK (
  "specHash" = encode(sha256(convert_to("specCanonical", 'UTF8')), 'hex')
);
ALTER TABLE "ResearchCampaignRun" ADD CONSTRAINT "ResearchCampaignRun_number" CHECK ("runNumber" >= 1 AND length(btrim("reason")) > 0);
ALTER TABLE "ResearchCampaignRunState" ADD CONSTRAINT "ResearchCampaignRunState_state" CHECK (
  "state" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED')
);
ALTER TABLE "ResearchCampaignUnit" ADD CONSTRAINT "ResearchCampaignUnit_state" CHECK (
  "state" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'REFUSED', 'FAILED', 'ABANDONED', 'CANCELLED')
  AND "hypothesisKind" IN ('STRATEGY', 'ML2')
  AND "plannedTrials" >= 0 AND "attempts" >= 0 AND "seq" >= 0
  AND "unitSpecHash" ~ '^[a-f0-9]{64}$'
);
ALTER TABLE "ResearchCampaignResult" ADD CONSTRAINT "ResearchCampaignResult_fields" CHECK (
  "phase" IN ('DATA_REFUSAL', 'WALK_FORWARD', 'HOLDOUT')
  AND "holdoutStatus" IN ('NOT_REACHED', 'WITHHELD', 'ALREADY_CONSUMED', 'EVALUATED', 'CONSUMED_RESULT_LOST')
  AND "trialCount" >= 0 AND "priorTrials" >= 0
  AND "resultHash" ~ '^[a-f0-9]{64}$'
  -- Only the HOLDOUT phase may claim an evaluated (or lost) holdout; a walk-forward result never does.
  AND ("phase" = 'HOLDOUT' OR "holdoutStatus" NOT IN ('EVALUATED', 'CONSUMED_RESULT_LOST'))
);
ALTER TABLE "ResearchTrialLedger" ADD CONSTRAINT "ResearchTrialLedger_fields" CHECK (
  "kind" IN ('LEGACY_DECLARED', 'RESERVED', 'SETTLED')
  AND "trials" >= 0
  AND (("kind" = 'LEGACY_DECLARED' AND "unitId" IS NULL AND length(btrim(coalesce("note", ''))) > 0)
    OR ("kind" = 'RESERVED' AND "unitId" IS NOT NULL AND "priorTrials" IS NOT NULL AND "priorTrials" >= 0)
    OR ("kind" = 'SETTLED' AND "unitId" IS NOT NULL))
);
ALTER TABLE "ResearchHoldoutLedger" ADD CONSTRAINT "ResearchHoldoutLedger_fields" CHECK (
  "kind" IN ('AUTHORIZED', 'CONSUME_INTENT', 'RESULT_RECORDED', 'RESULT_LOST')
  AND "periodStart" < "periodEnd" AND "barMs" > 0
  AND "subjectHash" ~ '^[a-f0-9]{64}$'
  AND ("kind" <> 'AUTHORIZED' OR ("actor" ~ '^operator:.+' AND "expiresAt" IS NOT NULL AND "expiresAt" > "createdAt"))
  AND ("kind" <> 'RESULT_RECORDED' OR "resultHash" ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION odin_evidence_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (EVIDENCE)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchCampaign_append_only" BEFORE UPDATE OR DELETE ON "ResearchCampaign"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignRun_append_only" BEFORE UPDATE OR DELETE ON "ResearchCampaignRun"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignResult_append_only" BEFORE UPDATE OR DELETE ON "ResearchCampaignResult"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignEvent_append_only" BEFORE UPDATE OR DELETE ON "ResearchCampaignEvent"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchTrialLedger_append_only" BEFORE UPDATE OR DELETE ON "ResearchTrialLedger"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchHoldoutLedger_append_only" BEFORE UPDATE OR DELETE ON "ResearchHoldoutLedger"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_append_only();

CREATE TRIGGER "ResearchCampaign_no_truncate" BEFORE TRUNCATE ON "ResearchCampaign"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignRun_no_truncate" BEFORE TRUNCATE ON "ResearchCampaignRun"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignRunState_no_truncate" BEFORE TRUNCATE ON "ResearchCampaignRunState"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignUnit_no_truncate" BEFORE TRUNCATE ON "ResearchCampaignUnit"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignResult_no_truncate" BEFORE TRUNCATE ON "ResearchCampaignResult"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchCampaignEvent_no_truncate" BEFORE TRUNCATE ON "ResearchCampaignEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchTrialLedger_no_truncate" BEFORE TRUNCATE ON "ResearchTrialLedger"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();
CREATE TRIGGER "ResearchHoldoutLedger_no_truncate" BEFORE TRUNCATE ON "ResearchHoldoutLedger"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_evidence_append_only();

-- Units and run states are mutable execution state: rows are never deleted, and the identity of a unit never changes.
CREATE FUNCTION odin_evidence_unit_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted (EVIDENCE)', TG_TABLE_NAME;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."runId" <> OLD."runId" OR NEW."seq" <> OLD."seq" OR NEW."datasetKey" <> OLD."datasetKey"
     OR NEW."hypothesisKind" <> OLD."hypothesisKind" OR NEW."hypothesisId" <> OLD."hypothesisId"
     OR NEW."plannedTrials" <> OLD."plannedTrials" OR NEW."unitSpecHash" <> OLD."unitSpecHash" THEN
    RAISE EXCEPTION 'ResearchCampaignUnit identity is immutable (EVIDENCE)';
  END IF;
  -- A terminal unit stays terminal: evidence is never re-opened in place. A rerun is a new run.
  IF OLD."state" IN ('SUCCEEDED', 'REFUSED', 'FAILED', 'ABANDONED', 'CANCELLED') AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'ResearchCampaignUnit % is terminal (%); start a new run instead (EVIDENCE)', OLD."id", OLD."state";
  END IF;
  IF NEW."attempts" < OLD."attempts" OR NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'ResearchCampaignUnit attempts and version never decrease (EVIDENCE)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchCampaignUnit_guard" BEFORE UPDATE OR DELETE ON "ResearchCampaignUnit"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_unit_guard();

CREATE FUNCTION odin_evidence_run_state_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted (EVIDENCE)', TG_TABLE_NAME;
  END IF;
  IF NEW."runId" <> OLD."runId" THEN
    RAISE EXCEPTION 'ResearchCampaignRunState.runId is immutable (EVIDENCE)';
  END IF;
  IF OLD."cancelRequestedAt" IS NOT NULL AND NEW."cancelRequestedAt" IS DISTINCT FROM OLD."cancelRequestedAt" THEN
    RAISE EXCEPTION 'a cancellation request cannot be withdrawn or re-dated (EVIDENCE)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchCampaignRunState_guard" BEFORE UPDATE OR DELETE ON "ResearchCampaignRunState"
  FOR EACH ROW EXECUTE FUNCTION odin_evidence_run_state_guard();
