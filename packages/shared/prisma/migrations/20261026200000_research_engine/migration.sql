-- AlterTable
ALTER TABLE "PaperAccount" ADD COLUMN "highWaterMarkUsd" DECIMAL(24,8);

-- AlterTable
ALTER TABLE "MarketObservation" ADD COLUMN "pairCreatedAt" TIMESTAMP(3),
ADD COLUMN "fdvUsd" DECIMAL(24,8),
ADD COLUMN "marketCapUsd" DECIMAL(24,8);

-- AlterTable
ALTER TABLE "AgentDecision" ADD COLUMN "inputSource" TEXT,
ADD COLUMN "durationMs" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "filledQty" DECIMAL(24,8) NOT NULL DEFAULT 0,
ADD COLUMN "observationId" TEXT,
ADD COLUMN "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "eligibleAt" TIMESTAMP(3),
ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_status_eligibleAt_idx" ON "Order"("status", "eligibleAt");

-- CreateTable
CREATE TABLE "WatchlistEntry" (
    "id" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "baseAddress" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "quoteAddress" TEXT NOT NULL,
    "quoteSymbol" TEXT NOT NULL,
    "dexId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "score" DECIMAL(16,6) NOT NULL,
    "rank" INTEGER NOT NULL,
    "reasonCodes" TEXT[],
    "observationId" TEXT,
    "cycleId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAssessment" (
    "id" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DECIMAL(8,6) NOT NULL,
    "reasonCodes" TEXT[],
    "mintAuthority" TEXT NOT NULL,
    "freezeAuthority" TEXT NOT NULL,
    "transferRestricted" BOOLEAN,
    "holderConcentrationTop10Pct" DECIMAL(16,6),
    "suspiciousDeployer" BOOLEAN,
    "liquidityFragile" BOOLEAN,
    "largeWalletMove" BOOLEAN,
    "fraudIndicators" TEXT[],
    "source" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "fields" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquitySnapshot" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT,
    "cashUsd" DECIMAL(24,8) NOT NULL,
    "equityUsd" DECIMAL(24,8),
    "unrealizedPnlUsd" DECIMAL(24,8),
    "realizedPnlUsd" DECIMAL(24,8) NOT NULL,
    "highWaterMarkUsd" DECIMAL(24,8),
    "exposureUsd" DECIMAL(24,8),
    "valuation" TEXT NOT NULL,
    "feesUsd" DECIMAL(24,8) NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchProposal" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "parameterPatch" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "walkForward" JSONB,
    "metrics" JSONB,
    "promoted" BOOLEAN NOT NULL DEFAULT false,
    "modelVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistEntry_pairAddress_key" ON "WatchlistEntry"("pairAddress");

-- CreateIndex
CREATE INDEX "WatchlistEntry_score_rank_idx" ON "WatchlistEntry"("score", "rank");

-- CreateIndex
CREATE INDEX "WatchlistEntry_observedAt_idx" ON "WatchlistEntry"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityAssessment_tokenAddress_key" ON "SecurityAssessment"("tokenAddress");

-- CreateIndex
CREATE INDEX "SecurityAssessment_category_updatedAt_idx" ON "SecurityAssessment"("category", "updatedAt");

-- CreateIndex
CREATE INDEX "EquitySnapshot_createdAt_idx" ON "EquitySnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "EquitySnapshot_cycleId_idx" ON "EquitySnapshot"("cycleId");

-- CreateIndex
CREATE INDEX "ResearchProposal_status_createdAt_idx" ON "ResearchProposal"("status", "createdAt");
