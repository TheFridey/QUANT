-- AlterTable
ALTER TABLE "Fill" ADD COLUMN     "brokerExecutionId" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "feeKnown" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'LOCAL_SIM',
ALTER COLUMN "observationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "brokerOrderId" TEXT,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "cancelState" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "intentId" TEXT,
ADD COLUMN     "lastBrokerStatus" TEXT,
ADD COLUMN     "lastBrokerSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastSubmitError" TEXT,
ADD COLUMN     "nextSyncAt" TIMESTAMP(3),
ADD COLUMN     "ownerScope" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "submissionState" TEXT NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "submitAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RiskReservation" ADD COLUMN     "intentId" TEXT,
ADD COLUMN     "strategyInstanceId" TEXT;

-- AlterTable
ALTER TABLE "StrategyAllocation" ADD COLUMN     "costBasisKnown" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "feesUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
ADD COLUMN     "ownership" TEXT NOT NULL DEFAULT 'STRATEGY',
ADD COLUMN     "reservedExitQty" DECIMAL(24,8) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TradeIntent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tradingEnvironment" TEXT NOT NULL,
    "executionMode" TEXT NOT NULL DEFAULT 'PAPER',
    "venue" TEXT NOT NULL DEFAULT 'PAPER',
    "source" TEXT NOT NULL,
    "strategyInstanceId" TEXT,
    "moduleRef" TEXT,
    "strategyVersion" TEXT,
    "configHash" TEXT,
    "artifactHash" TEXT,
    "sourceHash" TEXT,
    "instrumentId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "requestedQty" DECIMAL(24,8),
    "sizedQty" DECIMAL(24,8),
    "sizedNotionalUsd" DECIMAL(24,8),
    "observationId" TEXT,
    "observationAt" TIMESTAMP(3),
    "reasonCodes" TEXT[],
    "status" TEXT NOT NULL,
    "statusReason" TEXT,
    "eligibleAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "clientOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCase" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "pairAddress" TEXT,
    "strategyInstanceId" TEXT,
    "orderId" TEXT,
    "fillId" TEXT,
    "clientOrderId" TEXT,
    "detail" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "coverage" JSONB NOT NULL,
    "differences" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeIntent_idempotencyKey_key" ON "TradeIntent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TradeIntent_clientOrderId_key" ON "TradeIntent"("clientOrderId");

-- CreateIndex
CREATE INDEX "TradeIntent_accountId_createdAt_idx" ON "TradeIntent"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeIntent_cycleId_idx" ON "TradeIntent"("cycleId");

-- CreateIndex
CREATE INDEX "TradeIntent_accountId_status_createdAt_idx" ON "TradeIntent"("accountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TradeIntent_strategyInstanceId_createdAt_idx" ON "TradeIntent"("strategyInstanceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCase_dedupeKey_key" ON "RecoveryCase"("dedupeKey");

-- CreateIndex
CREATE INDEX "RecoveryCase_accountId_status_createdAt_idx" ON "RecoveryCase"("accountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RecoveryCase_kind_status_idx" ON "RecoveryCase"("kind", "status");

-- CreateIndex
CREATE INDEX "ReconciliationRun_accountId_scope_startedAt_idx" ON "ReconciliationRun"("accountId", "scope", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_orderId_brokerExecutionId_key" ON "Fill"("orderId", "brokerExecutionId");

-- CreateIndex
CREATE INDEX "Order_accountId_submissionState_idx" ON "Order"("accountId", "submissionState");

-- CreateIndex
CREATE INDEX "Order_intentId_idx" ON "Order"("intentId");

-- CreateIndex
CREATE INDEX "Order_brokerOrderId_idx" ON "Order"("brokerOrderId");

-- CreateIndex
CREATE INDEX "RiskReservation_accountId_strategyInstanceId_status_idx" ON "RiskReservation"("accountId", "strategyInstanceId", "status");

-- Legacy backfill (Stage 30): explicit ownership states, no fabricated history.
UPDATE "Order" SET "ownerScope" = 'STRATEGY' WHERE "strategyInstanceId" IS NOT NULL AND "strategyInstanceId" <> 'stratinst_unattributed';
UPDATE "Order" SET "ownerScope" = 'OPERATOR' WHERE "strategyInstanceId" IS NULL AND "intent" = 'OPERATOR';
UPDATE "Order" SET "ownerScope" = 'ACCOUNT_FLATTEN' WHERE "strategyInstanceId" IS NULL AND "intent" = 'FLATTEN';
UPDATE "Order" SET "ownerScope" = 'PROTECTION' WHERE "strategyInstanceId" IS NULL AND "clientOrderId" LIKE 'prot\_%';
-- Remainder rows created by the old repair helper booked qty at price 0: unknown cost basis, not strategy performance.
UPDATE "StrategyAllocation" SET "ownership" = 'UNATTRIBUTED', "costBasisKnown" = false WHERE "strategyInstanceId" = 'stratinst_unattributed';
