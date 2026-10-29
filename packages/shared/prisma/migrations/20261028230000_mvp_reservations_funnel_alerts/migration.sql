-- Risk reservations, protection OCO legs, opportunity funnel, durable alerts.
CREATE TABLE IF NOT EXISTS "RiskReservation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "cashUsd" DECIMAL(24, 8) NOT NULL,
  "exposureUsd" DECIMAL(24, 8) NOT NULL,
  "slots" INTEGER NOT NULL,
  "riskUsd" DECIMAL(24, 8) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RiskReservation_clientOrderId_key" ON "RiskReservation"("clientOrderId");
CREATE INDEX IF NOT EXISTS "RiskReservation_accountId_status_idx" ON "RiskReservation"("accountId", "status");

CREATE TABLE IF NOT EXISTS "ProtectionOrder" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "positionKey" TEXT NOT NULL,
  "ocoGroupId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "triggerPriceUsd" DECIMAL(24, 8),
  "trailPct" DECIMAL(16, 6),
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProtectionOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProtectionOrder_ocoGroupId_idx" ON "ProtectionOrder"("ocoGroupId");
CREATE INDEX IF NOT EXISTS "ProtectionOrder_positionKey_status_idx" ON "ProtectionOrder"("positionKey", "status");

CREATE TABLE IF NOT EXISTS "OpportunityFunnelEvent" (
  "id" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "pairAddress" TEXT NOT NULL,
  "instrumentId" TEXT,
  "stage" TEXT NOT NULL,
  "reasonCodes" TEXT[],
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpportunityFunnelEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OpportunityFunnelEvent_cycleId_idx" ON "OpportunityFunnelEvent"("cycleId");
CREATE INDEX IF NOT EXISTS "OpportunityFunnelEvent_stage_createdAt_idx" ON "OpportunityFunnelEvent"("stage", "createdAt");

CREATE TABLE IF NOT EXISTS "DurableAlert" (
  "id" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'INFO',
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "acked" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ackedAt" TIMESTAMP(3),
  CONSTRAINT "DurableAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DurableAlert_acked_createdAt_idx" ON "DurableAlert"("acked", "createdAt");
