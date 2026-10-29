-- Gate A (D01/D07): pin cycle execution context; type/scope protection intents.

ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "tradingEnvironment" TEXT;
ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "dataMode" TEXT;
ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "configRevision" TEXT;
ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "strategyRevision" TEXT;
ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "riskRevision" TEXT;
ALTER TABLE "CycleRun" ADD COLUMN IF NOT EXISTS "pinnedContext" JSONB;

CREATE INDEX IF NOT EXISTS "CycleRun_accountId_startedAt_idx" ON "CycleRun"("accountId", "startedAt");
CREATE INDEX IF NOT EXISTS "CycleRun_tradingEnvironment_startedAt_idx" ON "CycleRun"("tradingEnvironment", "startedAt");

ALTER TABLE "ProtectionIntent" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'EXIT_RETRY';
ALTER TABLE "ProtectionIntent" ADD COLUMN IF NOT EXISTS "lifecycleId" TEXT;
ALTER TABLE "ProtectionIntent" ADD COLUMN IF NOT EXISTS "instrumentId" TEXT;

CREATE INDEX IF NOT EXISTS "ProtectionIntent_accountId_status_retryAfter_idx"
  ON "ProtectionIntent"("accountId", "status", "retryAfter");
CREATE INDEX IF NOT EXISTS "ProtectionIntent_kind_status_idx"
  ON "ProtectionIntent"("kind", "status");
