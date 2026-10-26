-- Quantitative research laboratory: versioned strategies, backtests, observability, ORACLE reviews.
-- No real-money venue; all simulation results remain paper-labelled.

CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parentId" TEXT,
    "config" JSONB NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StrategyVersion_name_version_key" ON "StrategyVersion"("name", "version");
CREATE INDEX "StrategyVersion_status_createdAt_idx" ON "StrategyVersion"("status", "createdAt");

CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "strategyVersionId" TEXT,
    "status" TEXT NOT NULL,
    "label" TEXT,
    "params" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "dataQuality" JSONB,
    "metrics" JSONB,
    "baselines" JSONB,
    "validation" JSONB,
    "releaseGate" JSONB,
    "equityCurve" JSONB,
    "reportHtml" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BacktestRun_status_createdAt_idx" ON "BacktestRun"("status", "createdAt");
CREATE INDEX "BacktestRun_strategyVersionId_idx" ON "BacktestRun"("strategyVersionId");

CREATE TABLE "BacktestTrade" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "qty" DECIMAL(24,8) NOT NULL,
    "priceUsd" DECIMAL(24,8) NOT NULL,
    "feeUsd" DECIMAL(24,8) NOT NULL,
    "slippageBps" DECIMAL(16,6) NOT NULL,
    "notionalUsd" DECIMAL(24,8) NOT NULL,
    "pnlUsd" DECIMAL(24,8),
    "eventAt" TIMESTAMP(3) NOT NULL,
    "observationId" TEXT,
    "reasonCodes" TEXT[],
    "meta" JSONB,

    CONSTRAINT "BacktestTrade_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BacktestTrade_runId_eventAt_idx" ON "BacktestTrade"("runId", "eventAt");
CREATE INDEX "BacktestTrade_pairAddress_eventAt_idx" ON "BacktestTrade"("pairAddress", "eventAt");

CREATE TABLE "ExperimentMetrics" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "proposalId" TEXT,
    "kind" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "observed" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentMetrics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExperimentMetrics_kind_createdAt_idx" ON "ExperimentMetrics"("kind", "createdAt");
CREATE INDEX "ExperimentMetrics_runId_idx" ON "ExperimentMetrics"("runId");

CREATE TABLE "ObservabilityEvent" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(24,8),
    "unit" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservabilityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ObservabilityEvent_category_createdAt_idx" ON "ObservabilityEvent"("category", "createdAt");
CREATE INDEX "ObservabilityEvent_name_createdAt_idx" ON "ObservabilityEvent"("name", "createdAt");

CREATE TABLE "OracleReview" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "proposalId" TEXT,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "weaknesses" JSONB NOT NULL,
    "suggestions" JSONB NOT NULL,
    "readiness" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelVersion" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OracleReview_status_createdAt_idx" ON "OracleReview"("status", "createdAt");
CREATE INDEX "OracleReview_runId_idx" ON "OracleReview"("runId");

ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExperimentMetrics" ADD CONSTRAINT "ExperimentMetrics_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OracleReview" ADD CONSTRAINT "OracleReview_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
