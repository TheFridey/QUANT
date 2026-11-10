/** Normal cadence is one cycle every 20 s, so five minutes without a completion is a stall, not a slow cycle. */
export const PIPELINE_STALL_MS = 300_000;

/**
 * Whether a RUNNING engine is actually completing cycles. Postgres and Redis can both be up while the
 * pipeline is stuck (9 Nov 2026: 18 hours of failed cycles behind an "ok" health check). Only cycle
 * completions count: the scheduler runs cycles whatever the engine status, so a resumed engine has recent
 * ones, and EngineControl.updatedAt is bumped by ordinary planning so it cannot start a grace window.
 * A database with no completed cycle yet has no history to judge, so it reads ok.
 */
export function pipelineHealth(input: {
  engineStatus: string | null;
  lastCompleteCycleAt: Date | null;
  now: Date;
  stallMs?: number;
}): "ok" | "stalled" {
  if (input.engineStatus !== "RUNNING" || input.lastCompleteCycleAt === null) return "ok";
  return input.now.getTime() - input.lastCompleteCycleAt.getTime() > (input.stallMs ?? PIPELINE_STALL_MS) ? "stalled" : "ok";
}
