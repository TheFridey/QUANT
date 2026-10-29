-- §7 explicit module binding; §8 order/fill/position ownership + internal allocations

ALTER TABLE "StrategyInstance" ADD COLUMN IF NOT EXISTS "moduleRef" TEXT;
CREATE INDEX IF NOT EXISTS "StrategyInstance_moduleRef_idx" ON "StrategyInstance"("moduleRef");

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "strategyInstanceId" TEXT;
CREATE INDEX IF NOT EXISTS "Order_strategyInstanceId_idx" ON "Order"("strategyInstanceId");

ALTER TABLE "Fill" ADD COLUMN IF NOT EXISTS "strategyInstanceId" TEXT;
CREATE INDEX IF NOT EXISTS "Fill_strategyInstanceId_idx" ON "Fill"("strategyInstanceId");

ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "strategyInstanceId" TEXT;
CREATE INDEX IF NOT EXISTS "Position_strategyInstanceId_idx" ON "Position"("strategyInstanceId");

CREATE TABLE IF NOT EXISTS "StrategyAllocation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "strategyInstanceId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "lifecycleId" TEXT,
    "qty" DECIMAL(24,8) NOT NULL,
    "avgCostUsd" DECIMAL(24,8) NOT NULL,
    "realizedPnlUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "committedCapitalUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "pendingCapitalUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StrategyAllocation_accountId_strategyInstanceId_pairAddress_key"
  ON "StrategyAllocation"("accountId", "strategyInstanceId", "pairAddress");
CREATE INDEX IF NOT EXISTS "StrategyAllocation_accountId_pairAddress_idx"
  ON "StrategyAllocation"("accountId", "pairAddress");
CREATE INDEX IF NOT EXISTS "StrategyAllocation_strategyInstanceId_idx"
  ON "StrategyAllocation"("strategyInstanceId");

-- Backfill moduleRef for known default seed names (display rename must not change this later).
UPDATE "StrategyInstance"
SET "moduleRef" = 'mean-revert-fade-v1'
WHERE "moduleRef" IS NULL AND ("name" = 'mean-revert-fade-v1' OR "name" LIKE 'mean-revert%');

UPDATE "StrategyInstance"
SET "moduleRef" = 'breakout-hold-v1'
WHERE "moduleRef" IS NULL AND ("name" LIKE 'breakout%' OR "name" LIKE '%breakout%');

UPDATE "StrategyInstance"
SET "moduleRef" = 'pulse-momentum-v1'
WHERE "moduleRef" IS NULL;
