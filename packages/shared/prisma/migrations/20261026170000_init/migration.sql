-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineControl" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "status" TEXT NOT NULL,
    "flattenRequested" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "EngineControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperAccount" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "cashUsd" DECIMAL(24,8) NOT NULL,
    "startingBalanceUsd" DECIMAL(24,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketObservation" (
    "id" TEXT NOT NULL,
    "ingestJobId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "dexId" TEXT NOT NULL,
    "url" TEXT,
    "baseAddress" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "baseName" TEXT NOT NULL,
    "quoteAddress" TEXT NOT NULL,
    "quoteSymbol" TEXT NOT NULL,
    "priceUsd" DECIMAL(24,8),
    "liquidityUsd" DECIMAL(24,8),
    "volume24hUsd" DECIMAL(24,8),
    "volume5mUsd" DECIMAL(24,8),
    "priceChangeM5" DECIMAL(16,6),
    "priceChangeH1" DECIMAL(16,6),
    "priceChangeH24" DECIMAL(16,6),
    "txnsM5Buys" INTEGER,
    "txnsM5Sells" INTEGER,
    "freshness" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "dataState" TEXT NOT NULL,
    "error" TEXT,
    "operator" JSONB,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CycleRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDecision" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL DEFAULT '',
    "decision" TEXT NOT NULL,
    "confidence" DECIMAL(8,6) NOT NULL,
    "reasonCodes" TEXT[],
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "qty" DECIMAL(24,8) NOT NULL,
    "reasonCodes" TEXT[],
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" DECIMAL(24,8) NOT NULL,
    "priceUsd" DECIMAL(24,8) NOT NULL,
    "notionalUsd" DECIMAL(24,8) NOT NULL,
    "feeUsd" DECIMAL(24,8) NOT NULL,
    "slippageBps" DECIMAL(16,6) NOT NULL,
    "liquidityUsd" DECIMAL(24,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "baseQty" DECIMAL(24,8) NOT NULL,
    "avgCostUsd" DECIMAL(24,8) NOT NULL,
    "realizedPnlUsd" DECIMAL(24,8) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountUsd" DECIMAL(24,8) NOT NULL,
    "affectsCash" BOOLEAN NOT NULL,
    "orderId" TEXT,
    "fillId" TEXT,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "MarketObservation_pairAddress_receivedAt_idx" ON "MarketObservation"("pairAddress", "receivedAt");

-- CreateIndex
CREATE INDEX "MarketObservation_receivedAt_idx" ON "MarketObservation"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketObservation_ingestJobId_pairAddress_key" ON "MarketObservation"("ingestJobId", "pairAddress");

-- CreateIndex
CREATE INDEX "CycleRun_status_startedAt_idx" ON "CycleRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "CycleRun_startedAt_idx" ON "CycleRun"("startedAt");

-- CreateIndex
CREATE INDEX "AgentDecision_createdAt_idx" ON "AgentDecision"("createdAt");

-- CreateIndex
CREATE INDEX "AgentDecision_agent_createdAt_idx" ON "AgentDecision"("agent", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDecision_cycleId_agent_pairAddress_key" ON "AgentDecision"("cycleId", "agent", "pairAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_cycleId_idx" ON "Order"("cycleId");

-- CreateIndex
CREATE INDEX "Fill_pairAddress_createdAt_idx" ON "Fill"("pairAddress", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Position_accountId_pairAddress_key" ON "Position"("accountId", "pairAddress");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_type_createdAt_idx" ON "LedgerEntry"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PaperAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PaperAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PaperAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "PaperAccount" ADD CONSTRAINT "PaperAccount_cash_nonnegative" CHECK ("cashUsd" >= 0);
ALTER TABLE "Position" ADD CONSTRAINT "Position_qty_nonnegative" CHECK ("baseQty" >= 0);
