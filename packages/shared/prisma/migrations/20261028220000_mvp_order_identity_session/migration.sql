-- Order identity through lifecycle + session equity for daily loss accounting.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "executionMode" TEXT NOT NULL DEFAULT 'PAPER';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "venue" TEXT NOT NULL DEFAULT 'PAPER';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "instrumentId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "strategyVersion" TEXT;

ALTER TABLE "PaperAccount" ADD COLUMN IF NOT EXISTS "sessionStartEquityUsd" DECIMAL(24, 8);
ALTER TABLE "PaperAccount" ADD COLUMN IF NOT EXISTS "sessionStartedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Order_executionMode_venue_idx" ON "Order"("executionMode", "venue");
