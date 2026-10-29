-- D29: indexes supporting bounded terminal snapshot / history queries
CREATE INDEX IF NOT EXISTS "Order_accountId_createdAt_idx" ON "Order"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentDecision_cycleId_agent_idx" ON "AgentDecision"("cycleId", "agent");
CREATE INDEX IF NOT EXISTS "Fill_createdAt_idx" ON "Fill"("createdAt");
