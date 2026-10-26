-- PROJECT EVOLUTION schema (multi-market, research pipeline, memory, autonomy)

CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "tickSize" TEXT NOT NULL,
    "lotSize" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerSymbol" TEXT NOT NULL,
    "executionCapabilities" TEXT[],
    "enabledByDefault" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketSelection" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSelection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Hypothesis" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "instrumentIds" TEXT[],
    "conditions" TEXT NOT NULL,
    "claimedAdvantage" TEXT NOT NULL,
    "entryRules" TEXT NOT NULL,
    "exitRules" TEXT NOT NULL,
    "riskRules" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "successCriteria" TEXT NOT NULL,
    "failureModes" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hypothesis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LifecycleAudit" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExperimentReport" (
    "id" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "strategyModuleId" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradeMemory" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "postExit" BOOLEAN NOT NULL DEFAULT false,
    "context" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelUsageLog" (
    "id" TEXT NOT NULL,
    "agentOrTask" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "promptTokensEst" INTEGER NOT NULL,
    "completionTokensEst" INTEGER NOT NULL,
    "costUsdEst" DECIMAL(16,8) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchQueueItem" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "hypothesisId" TEXT,
    "strategyId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "budgetUsd" DECIMAL(16,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchQueueItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutonomyControl" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "level" INTEGER NOT NULL DEFAULT 1,
    "realMoneyExecutionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowUnreviewedCodeDeploy" BOOLEAN NOT NULL DEFAULT false,
    "allowRiskLimitMutation" BOOLEAN NOT NULL DEFAULT false,
    "maxResearchIterations" INTEGER NOT NULL DEFAULT 8,
    "maxResearchBudgetUsd" DECIMAL(16,8) NOT NULL DEFAULT 5,
    "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AutonomyControl_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Instrument_assetClass_venue_idx" ON "Instrument"("assetClass", "venue");
CREATE INDEX "Instrument_providerId_idx" ON "Instrument"("providerId");
CREATE UNIQUE INDEX "MarketSelection_instrumentId_key" ON "MarketSelection"("instrumentId");
CREATE INDEX "Hypothesis_status_createdAt_idx" ON "Hypothesis"("status", "createdAt");
CREATE INDEX "Hypothesis_market_idx" ON "Hypothesis"("market");
CREATE INDEX "LifecycleAudit_strategyId_createdAt_idx" ON "LifecycleAudit"("strategyId", "createdAt");
CREATE INDEX "LifecycleAudit_toState_createdAt_idx" ON "LifecycleAudit"("toState", "createdAt");
CREATE INDEX "ExperimentReport_hypothesisId_createdAt_idx" ON "ExperimentReport"("hypothesisId", "createdAt");
CREATE INDEX "ExperimentReport_contentHash_idx" ON "ExperimentReport"("contentHash");
CREATE INDEX "TradeMemory_tradeId_phase_idx" ON "TradeMemory"("tradeId", "phase");
CREATE INDEX "TradeMemory_pairAddress_capturedAt_idx" ON "TradeMemory"("pairAddress", "capturedAt");
CREATE INDEX "TradeMemory_postExit_capturedAt_idx" ON "TradeMemory"("postExit", "capturedAt");
CREATE INDEX "ModelUsageLog_agentOrTask_createdAt_idx" ON "ModelUsageLog"("agentOrTask", "createdAt");
CREATE INDEX "ModelUsageLog_tier_createdAt_idx" ON "ModelUsageLog"("tier", "createdAt");
CREATE INDEX "ResearchQueueItem_status_priority_idx" ON "ResearchQueueItem"("status", "priority");
CREATE INDEX "ResearchQueueItem_createdAt_idx" ON "ResearchQueueItem"("createdAt");

ALTER TABLE "MarketSelection" ADD CONSTRAINT "MarketSelection_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
