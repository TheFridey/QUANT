/**
 * Live-money execution is disabled by default and must be explicitly enabled
 * server-side. Models and clients cannot bypass this gate.
 */
export type ExecutionMode = "PAPER" | "SANDBOX" | "LIVE";

export function resolveExecutionMode(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
  const raw = (env.EXECUTION_MODE ?? "PAPER").trim().toUpperCase();
  if (raw === "LIVE") return "LIVE";
  if (raw === "SANDBOX") return "SANDBOX";
  return "PAPER";
}

export function assertPaperOrSandboxOnly(env: NodeJS.ProcessEnv = process.env): {
  ok: true;
  mode: ExecutionMode;
} | {
  ok: false;
  mode: "LIVE";
  reason: string;
} {
  const mode = resolveExecutionMode(env);
  const liveEnabled = env.LIVE_MONEY_ENABLED === "true" && env.LIVE_MONEY_CONFIRM === "I_UNDERSTAND_LIVE_RISK";
  if (mode === "LIVE" && !liveEnabled) {
    return {
      ok: false,
      mode: "LIVE",
      reason: "LIVE execution refused: set LIVE_MONEY_ENABLED=true and LIVE_MONEY_CONFIRM=I_UNDERSTAND_LIVE_RISK only after operator approval. Default remains PAPER.",
    };
  }
  if (mode === "LIVE" && liveEnabled) {
    // Even with flags, this MVP has no live broker route — refuse submission.
    return {
      ok: false,
      mode: "LIVE",
      reason: "LIVE mode flags set but no live broker adapter exists in this MVP. Refusing order submission.",
    };
  }
  return { ok: true, mode };
}
