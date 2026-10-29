-- Release 1 correctness: position lifecycle, fill observation provenance,
-- account-scoped safety state (ACK ≠ resolve), observation origin/event time.

-- Position lot lifecycle (R01): reopen must not inherit prior opened-at/peak/protection.
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "lifecycleId" TEXT;
CREATE INDEX IF NOT EXISTS "Position_accountId_lifecycleId_idx"
  ON "Position"("accountId", "lifecycleId");

-- Protection legs keyed to the open lot (R01).
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "lifecycleId" TEXT;
CREATE INDEX IF NOT EXISTS "ProtectionOrder_lifecycleId_status_idx"
  ON "ProtectionOrder"("lifecycleId", "status");

-- Decision vs fill observation (R04): preserve both; fill uses eligible event.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "decisionObservationId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "fillObservationId" TEXT;

-- Observation provenance for FX/delayed vs fixture isolation (R09) + env scope (R03).
ALTER TABLE "MarketObservation" ADD COLUMN IF NOT EXISTS "dataOrigin" TEXT;
ALTER TABLE "MarketObservation" ADD COLUMN IF NOT EXISTS "tradingEnvironment" TEXT;
ALTER TABLE "MarketObservation" ADD COLUMN IF NOT EXISTS "eventTime" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "MarketObservation_pairAddress_eventTime_idx"
  ON "MarketObservation"("pairAddress", "eventTime");
CREATE INDEX IF NOT EXISTS "MarketObservation_tradingEnvironment_receivedAt_idx"
  ON "MarketObservation"("tradingEnvironment", "receivedAt");

-- Alert rows may be scoped; ACK still does not resolve safety (R06).
ALTER TABLE "DurableAlert" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
CREATE INDEX IF NOT EXISTS "DurableAlert_accountId_acked_createdAt_idx"
  ON "DurableAlert"("accountId", "acked", "createdAt");

-- Independent safety control store: ACK of DurableAlert never clears these (R06).
CREATE TABLE IF NOT EXISTS "AccountSafetyState" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "detail" JSONB,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountSafetyState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountSafetyState_accountId_code_key"
  ON "AccountSafetyState"("accountId", "code");
CREATE INDEX IF NOT EXISTS "AccountSafetyState_accountId_status_idx"
  ON "AccountSafetyState"("accountId", "status");
