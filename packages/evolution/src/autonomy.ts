import {
  DEFAULT_AUTONOMY,
  autonomyPolicySchema,
  type AutonomyLevel,
  type AutonomyPolicy,
} from "@odin/shared";

export function parseAutonomyPolicy(value: unknown): AutonomyPolicy {
  if (!value || typeof value !== "object") return autonomyPolicySchema.parse(DEFAULT_AUTONOMY);
  return autonomyPolicySchema.parse({ ...DEFAULT_AUTONOMY, ...value, realMoneyExecutionEnabled: false, allowUnreviewedCodeDeploy: false });
}

export function describeAutonomy(level: AutonomyLevel): string {
  switch (level) {
    case 0:
      return "Manual only — operator triggers every research and paper step.";
    case 1:
      return "Assisted — system proposes hypotheses/experiments; human approves.";
    case 2:
      return "Bounded research — ORACLE may queue experiments within budgets; no deploy.";
    case 3:
      return "Research-autonomous — iterate forge/test/challenge within bounds; still no unreviewed deploy or risk mutation.";
    case 4:
      return "Disabled — would require approved real-money execution adapter (none).";
    default:
      return "Unknown";
  }
}

export function assertActionAllowed(
  policy: AutonomyPolicy,
  action:
    | "queue_experiment"
    | "forge_code"
    | "run_backtest"
    | "promote_paper"
    | "deploy_unreviewed"
    | "mutate_risk_limits"
    | "real_money_order",
): { allowed: boolean; reason: string } {
  if (action === "real_money_order" || action === "deploy_unreviewed") {
    return { allowed: false, reason: "Hard-disabled: no real-money adapter; unreviewed deploy forbidden" };
  }
  if (action === "mutate_risk_limits" && !policy.allowRiskLimitMutation) {
    return { allowed: false, reason: "Risk limit mutation disabled by autonomy policy" };
  }
  if (policy.level === 0 && action !== "queue_experiment") {
    return { allowed: false, reason: "Autonomy 0 requires manual operator initiation beyond queue listing" };
  }
  if (policy.level <= 1 && (action === "forge_code" || action === "run_backtest" || action === "promote_paper")) {
    return { allowed: true, reason: "Allowed with human approval gate (caller must record approval)" };
  }
  if (policy.level >= 2 && action === "queue_experiment") {
    return { allowed: true, reason: "Bounded research queue permitted" };
  }
  if (policy.level >= 3 && (action === "forge_code" || action === "run_backtest")) {
    return { allowed: true, reason: "Research autonomy within budget/iteration caps" };
  }
  if (action === "promote_paper" && policy.level >= 2) {
    return { allowed: true, reason: "Paper promotion still requires research-policy approval record" };
  }
  return { allowed: true, reason: "Permitted" };
}
