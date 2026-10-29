-- Protection desired vs confirmed ack state; REPLAY isolation on funnel/equity metrics.

ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "confirmedTriggerPriceUsd" DECIMAL(24, 8);
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "desiredTriggerPriceUsd" DECIMAL(24, 8);
ALTER TABLE "ProtectionOrder" ADD COLUMN IF NOT EXISTS "ackState" TEXT NOT NULL DEFAULT 'ACKED';

-- Backfill confirmed from live trigger for existing armed/confirmed rows
UPDATE "ProtectionOrder"
SET
  "confirmedTriggerPriceUsd" = COALESCE("confirmedTriggerPriceUsd", "triggerPriceUsd"),
  "desiredTriggerPriceUsd" = COALESCE("desiredTriggerPriceUsd", "triggerPriceUsd")
WHERE "triggerPriceUsd" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ProtectionOrder_accountId_status_idx"
  ON "ProtectionOrder"("accountId", "status");

ALTER TABLE "OpportunityFunnelEvent" ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT 'primary';
CREATE INDEX IF NOT EXISTS "OpportunityFunnelEvent_accountId_createdAt_idx"
  ON "OpportunityFunnelEvent"("accountId", "createdAt");

ALTER TABLE "EquitySnapshot" ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT 'primary';
CREATE INDEX IF NOT EXISTS "EquitySnapshot_accountId_createdAt_idx"
  ON "EquitySnapshot"("accountId", "createdAt");
