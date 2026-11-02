import {
  DEFAULT_AUTONOMY,
  autonomyPolicySchema,
  type AutonomyLevel,
  type AutonomyPolicy,
} from "@odin/shared";

/**
 * Real-money execution, unreviewed deploys and risk-limit mutation are forced off whatever the stored
 * row says. Research autonomy never modifies production risk controls (AGENTS.md; APEX §10.3), so a
 * stored `allowRiskLimitMutation: true` is not honoured.
 */
export function parseAutonomyPolicy(value: unknown): AutonomyPolicy {
  if (!value || typeof value !== "object") return autonomyPolicySchema.parse(DEFAULT_AUTONOMY);
  return autonomyPolicySchema.parse({
    ...DEFAULT_AUTONOMY,
    ...value,
    realMoneyExecutionEnabled: false,
    allowUnreviewedCodeDeploy: false,
    allowRiskLimitMutation: false,
  });
}

export function describeAutonomy(level: AutonomyLevel): string {
  switch (level) {
    case 0:
      return "Manual only — operator triggers every research and paper step.";
    case 1:
      return "Assisted — system proposes hypotheses/experiments; human approves.";
    case 2:
      return "Bounded research — ORACLE may queue experiments within budgets; forging and tests need approval; no deploy.";
    case 3:
      return "Research-autonomous — iterate forge/test/challenge within bounds; still no unreviewed deploy or risk mutation.";
    case 4:
      return "Disabled — would require approved real-money execution adapter (none).";
    default:
      return "Unknown";
  }
}

export type AutonomyAction =
  | "queue_experiment"
  | "forge_code"
  | "run_backtest"
  | "promote_paper"
  | "deploy_unreviewed"
  | "mutate_risk_limits"
  | "real_money_order";

export type AutonomyGate = {
  allowed: boolean;
  /** True when the caller must hold a recorded human approval before acting. */
  requiresApproval: boolean;
  reason: string;
};

/**
 * Explicit permission matrix. Anything not listed is denied (no default-allow fall-through).
 *
 * | action             | 0     | 1        | 2        | 3        | 4    |
 * | queue_experiment   | allow | allow    | allow    | allow    | deny |
 * | forge_code         | deny  | approval | approval | allow    | deny |
 * | run_backtest       | deny  | approval | approval | allow    | deny |
 * | promote_paper      | deny  | approval | approval | approval | deny |
 * | deploy_unreviewed, mutate_risk_limits, real_money_order: always denied |
 *
 * Level 4 is disabled (no real-money adapter exists), so it is denied everything rather than
 * treated as "more autonomous". Paper promotion always needs an approval record; the promotion
 * module enforces its own gates independently of this one.
 */
export function assertActionAllowed(policy: AutonomyPolicy, action: AutonomyAction): AutonomyGate {
  const deny = (reason: string): AutonomyGate => ({ allowed: false, requiresApproval: false, reason });
  const approval = (reason: string): AutonomyGate => ({ allowed: true, requiresApproval: true, reason });
  const allow = (reason: string): AutonomyGate => ({ allowed: true, requiresApproval: false, reason });

  if (action === "real_money_order" || action === "deploy_unreviewed") {
    return deny("Hard-disabled: no real-money adapter; unreviewed deploy forbidden");
  }
  if (action === "mutate_risk_limits") {
    return deny("Hard-disabled: research autonomy never modifies risk limits");
  }
  const level: number = policy.level;
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    return deny(`Autonomy level ${String(level)} is disabled`);
  }
  switch (action) {
    case "queue_experiment":
      return level >= 2
        ? allow("Bounded research queue permitted")
        : allow("Queue listing only; the operator initiates each research step");
    case "forge_code":
    case "run_backtest":
      if (level === 0) return deny("Autonomy 0 requires manual operator initiation beyond queue listing");
      if (level <= 2) return approval("Allowed with human approval gate (caller must record approval)");
      return allow("Research autonomy within budget/iteration caps");
    case "promote_paper":
      if (level === 0) return deny("Autonomy 0 requires manual operator initiation beyond queue listing");
      return approval("Paper promotion requires a recorded research-policy approval");
    default:
      return deny(`Unknown action ${String(action)}`);
  }
}
