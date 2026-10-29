-- Durable worker runtime state (fairness cursor, diagnostics) — separate from StrategyConfig.
ALTER TABLE "EngineControl" ADD COLUMN IF NOT EXISTS "runtimeState" JSONB;
