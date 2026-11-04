-- GENESIS Phases 5 and 6: model registry and shadow predictions. Additive only: five new tables, no change
-- to any existing table, column or trigger. Every new table is append-only (UPDATE, DELETE and TRUNCATE are
-- refused by triggers). Lifecycle states are research evidence labels; none grants any trading authority.

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "trainingCutoff" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredBy" TEXT NOT NULL,
    "datasetHashes" TEXT[],
    "featureSetHash" TEXT NOT NULL,
    "labelSpecHash" TEXT NOT NULL,
    "codeCommit" TEXT NOT NULL,
    "hyperparameters" JSONB NOT NULL,
    "labelDefinition" JSONB NOT NULL,
    "trainingProtocol" JSONB NOT NULL,
    "validation" JSONB NOT NULL,
    "evidenceLinks" TEXT[],
    "artefact" TEXT NOT NULL,
    "artefactHash" TEXT NOT NULL,
    "hypothesisId" TEXT,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPaperApproval" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "ModelPaperApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelLifecycleEvent" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShadowPrediction" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "predictedAt" TIMESTAMP(3) NOT NULL,
    "decisionBarOpenTime" TIMESTAMP(3) NOT NULL,
    "decisionTime" TIMESTAMP(3) NOT NULL,
    "barMs" INTEGER NOT NULL,
    "horizonBars" INTEGER NOT NULL,
    "horizonEndsAt" TIMESTAMP(3) NOT NULL,
    "features" JSONB NOT NULL,
    "featureHash" TEXT NOT NULL,
    "probability" DOUBLE PRECISION,
    "expectedNetReturn" DOUBLE PRECISION,
    "confidenceBasis" TEXT NOT NULL,
    "estimatedCostBps" DOUBLE PRECISION NOT NULL,
    "abstainReasons" TEXT[],
    "inputHash" TEXT NOT NULL,
    "recordCanonical" TEXT NOT NULL,
    "recordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShadowPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShadowOutcome" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL,
    "hypotheticalFillAvailable" BOOLEAN NOT NULL,
    "realisedNetReturn" DOUBLE PRECISION,
    "positive" BOOLEAN,
    "mae" DOUBLE PRECISION,
    "mfe" DOUBLE PRECISION,
    "exitReason" TEXT,
    "costBpsApplied" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'HYPOTHETICAL_SHADOW',
    "barsHash" TEXT NOT NULL,
    "recordCanonical" TEXT NOT NULL,
    "recordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShadowOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersion_family_version_key" ON "ModelVersion"("family", "version");

-- CreateIndex
CREATE INDEX "ModelVersion_artefactHash_idx" ON "ModelVersion"("artefactHash");

-- CreateIndex
CREATE INDEX "ModelVersion_hypothesisId_idx" ON "ModelVersion"("hypothesisId");

-- CreateIndex
CREATE INDEX "ModelPaperApproval_modelVersionId_expiresAt_idx" ON "ModelPaperApproval"("modelVersionId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModelLifecycleEvent_modelVersionId_seq_key" ON "ModelLifecycleEvent"("modelVersionId", "seq");

-- CreateIndex
CREATE INDEX "ModelLifecycleEvent_toState_createdAt_idx" ON "ModelLifecycleEvent"("toState", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShadowPrediction_modelVersionId_instrumentKey_decisionBarOp_key" ON "ShadowPrediction"("modelVersionId", "instrumentKey", "decisionBarOpenTime");

-- CreateIndex
CREATE INDEX "ShadowPrediction_modelVersionId_decisionTime_idx" ON "ShadowPrediction"("modelVersionId", "decisionTime");

-- CreateIndex
CREATE INDEX "ShadowPrediction_status_horizonEndsAt_idx" ON "ShadowPrediction"("status", "horizonEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShadowOutcome_predictionId_key" ON "ShadowOutcome"("predictionId");

-- AddForeignKey
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "Hypothesis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelPaperApproval" ADD CONSTRAINT "ModelPaperApproval_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelLifecycleEvent" ADD CONSTRAINT "ModelLifecycleEvent_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelLifecycleEvent" ADD CONSTRAINT "ModelLifecycleEvent_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "ModelPaperApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowPrediction" ADD CONSTRAINT "ShadowPrediction_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowOutcome" ADD CONSTRAINT "ShadowOutcome_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "ShadowPrediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------------------------------------

ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_identity" CHECK (
  "family" ~ '^[A-Za-z0-9_.:-]{1,64}$'
  AND "version" ~ '^[A-Za-z0-9_.:+-]{1,64}$'
  AND "protocol" ~ '^ml-wf-[0-9]+\.[0-9]+\.[0-9]+$'
  AND length("registeredBy") BETWEEN 1 AND 200
);

ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_hashes" CHECK (
  "artefactHash" ~ '^[a-f0-9]{64}$'
  AND "featureSetHash" ~ '^[a-f0-9]{64}$'
  AND "labelSpecHash" ~ '^[a-f0-9]{64}$'
  AND "codeCommit" ~ '^[a-f0-9]{7,40}$'
  AND "datasetHashes" IS NOT NULL
  AND "evidenceLinks" IS NOT NULL
  AND cardinality("datasetHashes") BETWEEN 1 AND 64
  AND array_to_string("datasetHashes", ',') ~ '^[a-f0-9]{64}(,[a-f0-9]{64})*$'
);

-- The artefact is data (coefficients, trees, calibrator parameters). It is stored as its exact canonical JSON
-- text, not JSONB: a JSONB round trip through the Prisma engine can move a float by one ulp, which would
-- break hash re-verification. The database checks that the text is a JSON object of bounded size and that
-- artefactHash is the SHA-256 of exactly that text.
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_artefact_data" CHECK (
  octet_length("artefact") <= 8388608
  AND jsonb_typeof("artefact"::jsonb) = 'object'
  AND jsonb_typeof("hyperparameters") = 'object'
  AND jsonb_typeof("labelDefinition") = 'object'
  AND jsonb_typeof("trainingProtocol") = 'object'
  AND jsonb_typeof("validation") = 'object'
);

ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_artefact_hash" CHECK (
  encode(sha256(convert_to("artefact", 'UTF8')), 'hex') = "artefactHash"
);

ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_cutoff" CHECK ("trainingCutoff" <= "createdAt");

ALTER TABLE "ModelPaperApproval" ADD CONSTRAINT "ModelPaperApproval_operator" CHECK ("approvedBy" ~ '^operator:.+');

ALTER TABLE "ModelPaperApproval" ADD CONSTRAINT "ModelPaperApproval_window" CHECK (
  "expiresAt" > "approvedAt" AND "expiresAt" <= "approvedAt" + interval '7 days'
);

ALTER TABLE "ModelPaperApproval" ADD CONSTRAINT "ModelPaperApproval_subject" CHECK ("subjectHash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "ModelLifecycleEvent" ADD CONSTRAINT "ModelLifecycleEvent_state_known" CHECK (
  "toState" IN ('EXPERIMENTAL', 'REJECTED', 'HISTORICALLY_ELIGIBLE', 'SHADOW_CANDIDATE', 'SHADOW_VALIDATED',
                'PAPER_CANDIDATE', 'PAPER_APPROVED', 'RETIRED', 'FAILED')
  AND ("fromState" IS NULL OR "fromState" IN ('EXPERIMENTAL', 'REJECTED', 'HISTORICALLY_ELIGIBLE', 'SHADOW_CANDIDATE',
                'SHADOW_VALIDATED', 'PAPER_CANDIDATE', 'PAPER_APPROVED', 'RETIRED', 'FAILED'))
);

ALTER TABLE "ModelLifecycleEvent" ADD CONSTRAINT "ModelLifecycleEvent_sequence" CHECK (
  ("seq" = 0 AND "fromState" IS NULL AND "toState" = 'EXPERIMENTAL')
  OR ("seq" > 0 AND "fromState" IS NOT NULL)
);

-- PAPER_CANDIDATE and PAPER_APPROVED need an operator actor; PAPER_APPROVED also needs an approval record.
ALTER TABLE "ModelLifecycleEvent" ADD CONSTRAINT "ModelLifecycleEvent_operator_states" CHECK (
  ("toState" NOT IN ('PAPER_CANDIDATE', 'PAPER_APPROVED') OR "actor" ~ '^operator:.+')
  AND (("toState" = 'PAPER_APPROVED') = ("approvalId" IS NOT NULL))
);

ALTER TABLE "ModelLifecycleEvent" ADD CONSTRAINT "ModelLifecycleEvent_fields" CHECK (
  "evidenceHash" ~ '^[a-f0-9]{64}$' AND length("reason") BETWEEN 1 AND 2000 AND length("actor") BETWEEN 1 AND 200
);

ALTER TABLE "ShadowPrediction" ADD CONSTRAINT "ShadowPrediction_status" CHECK (
  "abstainReasons" IS NOT NULL
  AND (
    ("status" = 'PREDICTED' AND "probability" IS NOT NULL AND "probability" >= 0 AND "probability" <= 1
       AND cardinality("abstainReasons") = 0)
    OR ("status" = 'ABSTAINED' AND "probability" IS NULL AND "expectedNetReturn" IS NULL AND cardinality("abstainReasons") > 0)
  )
);

-- Timing: the decision bar has closed (decisionTime = open + one bar), the prediction is taken at or after
-- the decision time and at most min(one bar, one hour) later, and always before the horizon ends.
ALTER TABLE "ShadowPrediction" ADD CONSTRAINT "ShadowPrediction_timing" CHECK (
  "barMs" > 0
  AND "horizonBars" BETWEEN 1 AND 10000
  AND "decisionTime" = "decisionBarOpenTime" + "barMs" * interval '1 millisecond'
  AND "horizonEndsAt" = "decisionBarOpenTime" + ("horizonBars" + 1)::bigint * "barMs" * interval '1 millisecond'
  AND "predictedAt" >= "decisionTime"
  AND "predictedAt" <= "decisionTime" + LEAST("barMs", 3600000) * interval '1 millisecond'
  AND "predictedAt" < "horizonEndsAt"
);

ALTER TABLE "ShadowPrediction" ADD CONSTRAINT "ShadowPrediction_fields" CHECK (
  "featureHash" ~ '^[a-f0-9]{64}$'
  AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND "recordHash" ~ '^[a-f0-9]{64}$'
  AND "estimatedCostBps" >= 0 AND "estimatedCostBps" < 'Infinity'::float8
  AND ("expectedNetReturn" IS NULL OR ("expectedNetReturn" > '-Infinity'::float8 AND "expectedNetReturn" < 'Infinity'::float8))
  AND jsonb_typeof("features") = 'object'
  AND length("instrumentKey") BETWEEN 1 AND 200
);

-- recordCanonical is the exact canonical JSON the record hash covers (typed columns are for querying).
ALTER TABLE "ShadowPrediction" ADD CONSTRAINT "ShadowPrediction_record_hash" CHECK (
  encode(sha256(convert_to("recordCanonical", 'UTF8')), 'hex') = "recordHash"
);

-- Shadow outcomes are hypothetical and never mixed with paper fills.
ALTER TABLE "ShadowOutcome" ADD CONSTRAINT "ShadowOutcome_source" CHECK ("source" = 'HYPOTHETICAL_SHADOW');

ALTER TABLE "ShadowOutcome" ADD CONSTRAINT "ShadowOutcome_fill" CHECK (
  ("hypotheticalFillAvailable" AND "realisedNetReturn" IS NOT NULL AND "positive" IS NOT NULL
     AND "mae" IS NOT NULL AND "mfe" IS NOT NULL AND "mae" <= 0 AND "mae" > '-Infinity'::float8
     AND "mfe" >= 0 AND "mfe" < 'Infinity'::float8
     AND "realisedNetReturn" > '-Infinity'::float8 AND "realisedNetReturn" < 'Infinity'::float8
     AND "positive" = ("realisedNetReturn" > 0)
     AND "exitReason" IN ('HORIZON', 'STOP', 'TARGET'))
  OR (NOT "hypotheticalFillAvailable" AND "realisedNetReturn" IS NULL AND "positive" IS NULL
     AND "mae" IS NULL AND "mfe" IS NULL AND "exitReason" IS NULL)
);

ALTER TABLE "ShadowOutcome" ADD CONSTRAINT "ShadowOutcome_fields" CHECK (
  "costBpsApplied" >= 0 AND "costBpsApplied" < 'Infinity'::float8 AND "barsHash" ~ '^[a-f0-9]{64}$' AND "recordHash" ~ '^[a-f0-9]{64}$'
);

ALTER TABLE "ShadowOutcome" ADD CONSTRAINT "ShadowOutcome_record_hash" CHECK (
  encode(sha256(convert_to("recordCanonical", 'UTF8')), 'hex') = "recordHash"
);

-- ---------------------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------------------

CREATE FUNCTION odin_genesis_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (GENESIS)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModelVersion_append_only" BEFORE UPDATE OR DELETE ON "ModelVersion"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_append_only();
CREATE TRIGGER "ModelVersion_no_truncate" BEFORE TRUNCATE ON "ModelVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_genesis_append_only();

CREATE TRIGGER "ModelPaperApproval_append_only" BEFORE UPDATE OR DELETE ON "ModelPaperApproval"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_append_only();
CREATE TRIGGER "ModelPaperApproval_no_truncate" BEFORE TRUNCATE ON "ModelPaperApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_genesis_append_only();

CREATE TRIGGER "ModelLifecycleEvent_append_only" BEFORE UPDATE OR DELETE ON "ModelLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_append_only();
CREATE TRIGGER "ModelLifecycleEvent_no_truncate" BEFORE TRUNCATE ON "ModelLifecycleEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_genesis_append_only();

CREATE TRIGGER "ShadowPrediction_append_only" BEFORE UPDATE OR DELETE ON "ShadowPrediction"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_append_only();
CREATE TRIGGER "ShadowPrediction_no_truncate" BEFORE TRUNCATE ON "ShadowPrediction"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_genesis_append_only();

CREATE TRIGGER "ShadowOutcome_append_only" BEFORE UPDATE OR DELETE ON "ShadowOutcome"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_append_only();
CREATE TRIGGER "ShadowOutcome_no_truncate" BEFORE TRUNCATE ON "ShadowOutcome"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_genesis_append_only();

-- ---------------------------------------------------------------------------------------------------------
-- Insert guards. Every insert takes its createdAt from the database clock (UTC, as Prisma writes timestamps),
-- so a writer cannot backdate a row.
-- ---------------------------------------------------------------------------------------------------------

CREATE FUNCTION odin_genesis_now() RETURNS timestamp(3) AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
$$ LANGUAGE sql VOLATILE;

CREATE FUNCTION odin_genesis_model_version_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := odin_genesis_now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModelVersion_insert_guard" BEFORE INSERT ON "ModelVersion"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_model_version_insert();

-- An approval names the exact artefact it approves, and is dated by the database clock.
CREATE FUNCTION odin_genesis_paper_approval_insert() RETURNS trigger AS $$
DECLARE
  model_hash TEXT;
BEGIN
  NEW."approvedAt" := odin_genesis_now();
  SELECT "artefactHash" INTO model_hash FROM "ModelVersion" WHERE "id" = NEW."modelVersionId";
  IF model_hash IS NULL OR model_hash <> NEW."subjectHash" THEN
    RAISE EXCEPTION 'ModelPaperApproval subject does not match model % artefact', NEW."modelVersionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModelPaperApproval_insert_guard" BEFORE INSERT ON "ModelPaperApproval"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_paper_approval_insert();

-- Allowed lifecycle transitions; mirrors MODEL_TRANSITIONS in packages/evolution/src/genesis/model-lifecycle.ts.
CREATE FUNCTION odin_genesis_model_transition_allowed(from_state TEXT, to_state TEXT) RETURNS boolean AS $$
  SELECT (from_state, to_state) IN (
    ('EXPERIMENTAL', 'HISTORICALLY_ELIGIBLE'), ('EXPERIMENTAL', 'REJECTED'), ('EXPERIMENTAL', 'FAILED'), ('EXPERIMENTAL', 'RETIRED'),
    ('HISTORICALLY_ELIGIBLE', 'SHADOW_CANDIDATE'), ('HISTORICALLY_ELIGIBLE', 'REJECTED'), ('HISTORICALLY_ELIGIBLE', 'FAILED'), ('HISTORICALLY_ELIGIBLE', 'RETIRED'),
    ('SHADOW_CANDIDATE', 'SHADOW_VALIDATED'), ('SHADOW_CANDIDATE', 'REJECTED'), ('SHADOW_CANDIDATE', 'FAILED'), ('SHADOW_CANDIDATE', 'RETIRED'),
    ('SHADOW_VALIDATED', 'PAPER_CANDIDATE'), ('SHADOW_VALIDATED', 'REJECTED'), ('SHADOW_VALIDATED', 'FAILED'), ('SHADOW_VALIDATED', 'RETIRED'),
    ('PAPER_CANDIDATE', 'PAPER_APPROVED'), ('PAPER_CANDIDATE', 'REJECTED'), ('PAPER_CANDIDATE', 'FAILED'), ('PAPER_CANDIDATE', 'RETIRED'),
    ('PAPER_APPROVED', 'REJECTED'), ('PAPER_APPROVED', 'FAILED'), ('PAPER_APPROVED', 'RETIRED')
  );
$$ LANGUAGE sql IMMUTABLE;

-- Each event continues the model's chain: seq n+1 must start from the state seq n ended in. Two writers racing
-- on the same model collide on the (modelVersionId, seq) unique index, so at most one wins.
CREATE FUNCTION odin_genesis_lifecycle_insert() RETURNS trigger AS $$
DECLARE
  previous_state TEXT;
  approval RECORD;
  model_hash TEXT;
BEGIN
  NEW."createdAt" := odin_genesis_now();
  IF NEW."seq" > 0 THEN
    SELECT "toState" INTO previous_state FROM "ModelLifecycleEvent"
      WHERE "modelVersionId" = NEW."modelVersionId" AND "seq" = NEW."seq" - 1;
    IF previous_state IS NULL THEN
      RAISE EXCEPTION 'ModelLifecycleEvent seq % for % has no predecessor', NEW."seq", NEW."modelVersionId";
    END IF;
    IF previous_state <> NEW."fromState" THEN
      RAISE EXCEPTION 'ModelLifecycleEvent for % starts from % but the model is %', NEW."modelVersionId", NEW."fromState", previous_state;
    END IF;
    IF NOT odin_genesis_model_transition_allowed(NEW."fromState", NEW."toState") THEN
      RAISE EXCEPTION 'Model lifecycle transition % -> % is not allowed', NEW."fromState", NEW."toState";
    END IF;
  END IF;
  IF NEW."toState" = 'PAPER_APPROVED' THEN
    SELECT "artefactHash" INTO model_hash FROM "ModelVersion" WHERE "id" = NEW."modelVersionId";
    SELECT * INTO approval FROM "ModelPaperApproval" WHERE "id" = NEW."approvalId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAPER_APPROVED for % needs a current operator approval of this artefact', NEW."modelVersionId";
    END IF;
    IF approval."modelVersionId" <> NEW."modelVersionId"
       OR approval."approvedBy" <> NEW."actor"
       OR approval."subjectHash" <> model_hash
       OR NOT (approval."approvedAt" <= NEW."createdAt" AND NEW."createdAt" < approval."expiresAt") THEN
      RAISE EXCEPTION 'PAPER_APPROVED for % needs a current operator approval of this artefact', NEW."modelVersionId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModelLifecycleEvent_insert_guard" BEFORE INSERT ON "ModelLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_lifecycle_insert();

-- A prediction is recorded promptly (no backdating beyond five minutes, nothing dated in the future) and
-- strictly before its horizon ends, so its outcome cannot be known when it is written.
CREATE FUNCTION odin_genesis_prediction_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := odin_genesis_now();
  IF NEW."createdAt" >= NEW."horizonEndsAt" THEN
    RAISE EXCEPTION 'ShadowPrediction inserted at % after its horizon ended at %', NEW."createdAt", NEW."horizonEndsAt";
  END IF;
  IF NEW."predictedAt" > NEW."createdAt" + interval '5 seconds' THEN
    RAISE EXCEPTION 'ShadowPrediction predictedAt % is in the future', NEW."predictedAt";
  END IF;
  IF NEW."createdAt" > NEW."predictedAt" + interval '5 minutes' THEN
    RAISE EXCEPTION 'ShadowPrediction predictedAt % is backdated (inserted %)', NEW."predictedAt", NEW."createdAt";
  END IF;
  IF EXISTS (SELECT 1 FROM "ShadowOutcome" WHERE "predictionId" = NEW."id") THEN
    RAISE EXCEPTION 'ShadowPrediction % already has an outcome', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ShadowPrediction_insert_guard" BEFORE INSERT ON "ShadowPrediction"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_prediction_insert();

-- An outcome resolves a PREDICTED row, only once its horizon has ended in wall-clock time as well as in
-- the resolution data.
CREATE FUNCTION odin_genesis_outcome_insert() RETURNS trigger AS $$
DECLARE
  prediction RECORD;
BEGIN
  NEW."createdAt" := odin_genesis_now();
  SELECT "status", "horizonEndsAt" INTO prediction FROM "ShadowPrediction" WHERE "id" = NEW."predictionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ShadowOutcome for unknown prediction %', NEW."predictionId";
  END IF;
  IF prediction."status" <> 'PREDICTED' THEN
    RAISE EXCEPTION 'ShadowOutcome for % which abstained', NEW."predictionId";
  END IF;
  IF NEW."resolvedAt" < prediction."horizonEndsAt" OR NEW."createdAt" < prediction."horizonEndsAt" THEN
    RAISE EXCEPTION 'ShadowOutcome for % before its horizon ended at %', NEW."predictionId", prediction."horizonEndsAt";
  END IF;
  IF NEW."resolvedAt" > NEW."createdAt" + interval '5 seconds' THEN
    RAISE EXCEPTION 'ShadowOutcome resolvedAt % is in the future', NEW."resolvedAt";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ShadowOutcome_insert_guard" BEFORE INSERT ON "ShadowOutcome"
  FOR EACH ROW EXECUTE FUNCTION odin_genesis_outcome_insert();

-- Fire every guard even under session_replication_role = replica, so a session cannot bypass them by
-- switching to replica mode. Only the table owner or a superuser can still disable them explicitly.
ALTER TABLE "ModelVersion" ENABLE ALWAYS TRIGGER "ModelVersion_append_only";
ALTER TABLE "ModelVersion" ENABLE ALWAYS TRIGGER "ModelVersion_no_truncate";
ALTER TABLE "ModelVersion" ENABLE ALWAYS TRIGGER "ModelVersion_insert_guard";
ALTER TABLE "ModelPaperApproval" ENABLE ALWAYS TRIGGER "ModelPaperApproval_append_only";
ALTER TABLE "ModelPaperApproval" ENABLE ALWAYS TRIGGER "ModelPaperApproval_no_truncate";
ALTER TABLE "ModelPaperApproval" ENABLE ALWAYS TRIGGER "ModelPaperApproval_insert_guard";
ALTER TABLE "ModelLifecycleEvent" ENABLE ALWAYS TRIGGER "ModelLifecycleEvent_append_only";
ALTER TABLE "ModelLifecycleEvent" ENABLE ALWAYS TRIGGER "ModelLifecycleEvent_no_truncate";
ALTER TABLE "ModelLifecycleEvent" ENABLE ALWAYS TRIGGER "ModelLifecycleEvent_insert_guard";
ALTER TABLE "ShadowPrediction" ENABLE ALWAYS TRIGGER "ShadowPrediction_append_only";
ALTER TABLE "ShadowPrediction" ENABLE ALWAYS TRIGGER "ShadowPrediction_no_truncate";
ALTER TABLE "ShadowPrediction" ENABLE ALWAYS TRIGGER "ShadowPrediction_insert_guard";
ALTER TABLE "ShadowOutcome" ENABLE ALWAYS TRIGGER "ShadowOutcome_append_only";
ALTER TABLE "ShadowOutcome" ENABLE ALWAYS TRIGGER "ShadowOutcome_no_truncate";
ALTER TABLE "ShadowOutcome" ENABLE ALWAYS TRIGGER "ShadowOutcome_insert_guard";
