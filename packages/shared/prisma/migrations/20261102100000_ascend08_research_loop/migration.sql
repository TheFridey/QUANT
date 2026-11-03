-- ASCEND-08: bounded autonomous research loop. Additive only: four new tables, no change to existing ones.

-- CreateTable
CREATE TABLE "ResearchLoopControl" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxExperimentsPerDay" INTEGER NOT NULL DEFAULT 2,
    "maxConcurrentExperiments" INTEGER NOT NULL DEFAULT 2,
    "maxAttemptsPerExperiment" INTEGER NOT NULL DEFAULT 3,
    "tickRuntimeMs" INTEGER NOT NULL DEFAULT 120000,
    "leaseMs" INTEGER NOT NULL DEFAULT 600000,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ResearchLoopControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchExperiment" (
    "id" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OBSERVE',
    "blockedState" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchExperimentEvent" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "evidence" JSONB NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchExperimentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchApproval" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "ResearchApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchExperiment_state_leaseExpiresAt_idx" ON "ResearchExperiment"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ResearchExperiment_hypothesisId_idx" ON "ResearchExperiment"("hypothesisId");

-- CreateIndex
CREATE INDEX "ResearchExperiment_createdAt_idx" ON "ResearchExperiment"("createdAt");

-- CreateIndex
CREATE INDEX "ResearchExperimentEvent_experimentId_createdAt_idx" ON "ResearchExperimentEvent"("experimentId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchExperimentEvent_kind_createdAt_idx" ON "ResearchExperimentEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchApproval_experimentId_action_expiresAt_idx" ON "ResearchApproval"("experimentId", "action", "expiresAt");

-- AddForeignKey
ALTER TABLE "ResearchExperimentEvent" ADD CONSTRAINT "ResearchExperimentEvent_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "ResearchExperiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchApproval" ADD CONSTRAINT "ResearchApproval_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "ResearchExperiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ASCEND-08: bounds on the loop limits, enforced in the database as well as in the API.
ALTER TABLE "ResearchLoopControl" ADD CONSTRAINT "ResearchLoopControl_bounds" CHECK (
  "maxExperimentsPerDay" BETWEEN 0 AND 50
  AND "maxConcurrentExperiments" BETWEEN 1 AND 10
  AND "maxAttemptsPerExperiment" BETWEEN 1 AND 10
  AND "tickRuntimeMs" BETWEEN 70000 AND 600000
  AND "leaseMs" BETWEEN 140000 AND 3600000
  AND "leaseMs" >= 2 * "tickRuntimeMs"
);

ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_state_known" CHECK (
  "state" IN ('OBSERVE', 'HYPOTHESISE', 'FORGE', 'TEST', 'CHALLENGE', 'VALIDATE', 'PAPER', 'REVIEW',
              'REJECTED', 'FAILED', 'ABANDONED', 'BLOCKED_APPROVAL')
);

ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_blocked_state" CHECK (
  ("state" = 'BLOCKED_APPROVAL' AND "blockedState" IN ('FORGE', 'TEST', 'PAPER'))
  OR ("state" <> 'BLOCKED_APPROVAL' AND "blockedState" IS NULL)
);

ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_counters" CHECK (
  "attempts" >= 0 AND "version" >= 0
);

ALTER TABLE "ResearchApproval" ADD CONSTRAINT "ResearchApproval_action_known" CHECK (
  "action" IN ('forge_code', 'run_backtest', 'promote_paper')
);

ALTER TABLE "ResearchApproval" ADD CONSTRAINT "ResearchApproval_window" CHECK ("expiresAt" > "approvedAt");

ALTER TABLE "ResearchApproval" ADD CONSTRAINT "ResearchApproval_subject" CHECK ("subjectHash" ~ '^[a-f0-9]{64}$');

-- ASCEND-08: the transition log and operator approvals are append-only.
CREATE FUNCTION odin_research_loop_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (ASCEND-08)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchExperimentEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ResearchExperimentEvent"
  FOR EACH ROW EXECUTE FUNCTION odin_research_loop_append_only();

CREATE TRIGGER "ResearchApproval_append_only"
  BEFORE UPDATE OR DELETE ON "ResearchApproval"
  FOR EACH ROW EXECUTE FUNCTION odin_research_loop_append_only();

-- TRUNCATE bypasses row triggers, so it is refused separately (including via TRUNCATE … CASCADE).
CREATE TRIGGER "ResearchExperimentEvent_no_truncate"
  BEFORE TRUNCATE ON "ResearchExperimentEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_research_loop_append_only();

CREATE TRIGGER "ResearchApproval_no_truncate"
  BEFORE TRUNCATE ON "ResearchApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_research_loop_append_only();

CREATE TRIGGER "ResearchExperiment_no_truncate"
  BEFORE TRUNCATE ON "ResearchExperiment"
  FOR EACH STATEMENT EXECUTE FUNCTION odin_research_loop_append_only();

-- ASCEND-08: a terminal experiment is frozen (no column may change), and experiments are never deleted
-- (their events reference them). REVIEW may only be abandoned by the operator.
CREATE FUNCTION odin_research_experiment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ResearchExperiment rows are never deleted (ASCEND-08)';
  END IF;
  IF OLD."state" IN ('REJECTED', 'FAILED', 'ABANDONED') THEN
    RAISE EXCEPTION 'ResearchExperiment % is terminal (%) and frozen', OLD."id", OLD."state";
  END IF;
  IF OLD."state" = 'REVIEW' AND NEW."state" NOT IN ('REVIEW', 'ABANDONED') THEN
    RAISE EXCEPTION 'ResearchExperiment % in REVIEW may only be abandoned', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchExperiment_guard"
  BEFORE UPDATE OR DELETE ON "ResearchExperiment"
  FOR EACH ROW EXECUTE FUNCTION odin_research_experiment_guard();
