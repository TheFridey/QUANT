-- Durable reservation authority, protection lifecycle, environment isolation, strategy instances.

ALTER TABLE "PaperAccount" ADD COLUMN IF NOT EXISTS "tradingEnvironment" TEXT NOT NULL DEFAULT 'MARKET_DATA_PAPER';

-- RiskReservation: expand for remaining amounts + mode-scoped uniqueness
ALTER TABLE "RiskReservation" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'PAPER';
ALTER TABLE "RiskReservation" ADD COLUMN IF NOT EXISTS "remainingCashUsd" DECIMAL(24, 8) NOT NULL DEFAULT 0;
ALTER TABLE "RiskReservation" ADD COLUMN IF NOT EXISTS "remainingExposureUsd" DECIMAL(24, 8) NOT NULL DEFAULT 0;
ALTER TABLE "RiskReservation" ADD COLUMN IF NOT EXISTS "remainingRiskUsd" DECIMAL(24, 8) NOT NULL DEFAULT 0;
ALTER TABLE "RiskReservation" ADD COLUMN IF NOT EXISTS "remainingSlots" INTEGER NOT NULL DEFAULT 0;

-- Backfill remaining from original amounts for HELD/CONSUMED rows
UPDATE "RiskReservation"
SET
  "remainingCashUsd" = "cashUsd",
  "remainingExposureUsd" = "exposureUsd",
  "remainingRiskUsd" = "riskUsd",
  "remainingSlots" = "slots"
WHERE "status" IN ('HELD', 'CONSUMED');

-- Replace clientOrderId-only unique with account+mode+clientOrderId
DROP INDEX IF EXISTS "RiskReservation_clientOrderId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "RiskReservation_accountId_mode_clientOrderId_key"
  ON "RiskReservation"("accountId", "mode", "clientOrderId");

CREATE TABLE IF NOT EXISTS "RiskReservationEvent" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskReservationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RiskReservationEvent_accountId_createdAt_idx" ON "RiskReservationEvent"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "RiskReservationEvent_reservationId_createdAt_idx" ON "RiskReservationEvent"("reservationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "RiskReservationEvent"
    ADD CONSTRAINT "RiskReservationEvent_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "RiskReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'LONG';
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "protectedQty" DECIMAL(24, 8) NOT NULL DEFAULT 0;
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "remainingQty" DECIMAL(24, 8) NOT NULL DEFAULT 0;
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "extremePriceUsd" DECIMAL(24, 8);
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "claimWorkerId" TEXT;
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "strategyInstanceId" TEXT;
CREATE INDEX IF NOT EXISTS "ProtectionOrder_status_updatedAt_idx" ON "ProtectionOrder"("status", "updatedAt");

CREATE TABLE IF NOT EXISTS "ProtectionIntent" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "ocoGroupId" TEXT NOT NULL,
  "legId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retryAfter" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProtectionIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProtectionIntent_status_retryAfter_idx" ON "ProtectionIntent"("status", "retryAfter");
CREATE INDEX IF NOT EXISTS "ProtectionIntent_ocoGroupId_idx" ON "ProtectionIntent"("ocoGroupId");

CREATE TABLE IF NOT EXISTS "StrategyInstance" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "instrumentIds" TEXT[],
  "timeframe" TEXT NOT NULL DEFAULT 'M5',
  "params" JSONB NOT NULL,
  "budgetUsd" DECIMAL(24, 8) NOT NULL,
  "health" TEXT NOT NULL DEFAULT 'HEALTHY',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "artifactHash" TEXT,
  "sourceHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyInstance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StrategyInstance_accountId_status_idx" ON "StrategyInstance"("accountId", "status");
CREATE INDEX IF NOT EXISTS "StrategyInstance_status_updatedAt_idx" ON "StrategyInstance"("status", "updatedAt");
