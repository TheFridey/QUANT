-- Audit H3 (B5): per-phase executor durations, recorded on every cycle.
ALTER TABLE "CycleRun" ADD COLUMN "executorTimings" JSONB;
