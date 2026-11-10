/** Normal cadence is one cycle every 20 s, so five minutes without a completion is a stall, not a slow cycle. */
export const PIPELINE_STALL_MS = 300_000;

/**
 * Whether a RUNNING engine is actually completing cycles. Postgres and Redis can both be up while the
 * pipeline is stuck (9 Nov 2026: 18 hours of failed cycles behind an "ok" health check). The engine's
 * own updatedAt starts the clock, so starting or resuming it gets a full window before it can read stalled.
 */
export function pipelineHealth(input: {
  engineStatus: string | null;
  engineUpdatedAt: Date | null;
  lastCompleteCycleAt: Date | null;
  now: Date;
  stallMs?: number;
}): "ok" | "stalled" {
  if (input.engineStatus !== "RUNNING") return "ok";
  const latest = Math.max(input.lastCompleteCycleAt?.getTime() ?? 0, input.engineUpdatedAt?.getTime() ?? 0);
  return input.now.getTime() - latest > (input.stallMs ?? PIPELINE_STALL_MS) ? "stalled" : "ok";
}
