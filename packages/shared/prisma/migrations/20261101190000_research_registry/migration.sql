-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "codeVersion" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasons" TEXT[],
    "evidence" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchTrial" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "fold" INTEGER,
    "params" JSONB NOT NULL,
    "startT" TIMESTAMP(3) NOT NULL,
    "endT" TIMESTAMP(3) NOT NULL,
    "bars" INTEGER NOT NULL,
    "trades" INTEGER NOT NULL,
    "netReturn" DOUBLE PRECISION NOT NULL,
    "sharpe" DOUBLE PRECISION,
    "perBarSharpe" DOUBLE PRECISION,

    CONSTRAINT "ResearchTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchHoldoutAccess" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchHoldoutAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchRun_strategyId_createdAt_idx" ON "ResearchRun"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRun_datasetId_createdAt_idx" ON "ResearchRun"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRun_verdict_idx" ON "ResearchRun"("verdict");

-- CreateIndex
CREATE INDEX "ResearchTrial_runId_idx" ON "ResearchTrial"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchHoldoutAccess_strategyId_strategyVersion_datasetId_key" ON "ResearchHoldoutAccess"("strategyId", "strategyVersion", "datasetId");

-- AddForeignKey
ALTER TABLE "ResearchTrial" ADD CONSTRAINT "ResearchTrial_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ASCEND-03: research evidence is append-only. Failed trials stay, so later deflation counts them.
CREATE TRIGGER "ResearchRun_immutable"
  BEFORE UPDATE OR DELETE ON "ResearchRun"
  FOR EACH ROW EXECUTE FUNCTION odin_historical_immutable();

CREATE TRIGGER "ResearchTrial_immutable"
  BEFORE UPDATE OR DELETE ON "ResearchTrial"
  FOR EACH ROW EXECUTE FUNCTION odin_historical_immutable();

CREATE TRIGGER "ResearchHoldoutAccess_immutable"
  BEFORE UPDATE OR DELETE ON "ResearchHoldoutAccess"
  FOR EACH ROW EXECUTE FUNCTION odin_historical_immutable();
