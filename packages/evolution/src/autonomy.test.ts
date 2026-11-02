import { DEFAULT_AUTONOMY, type AutonomyPolicy } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { assertActionAllowed, parseAutonomyPolicy, type AutonomyAction } from "./autonomy.js";

const policy = (level: number): AutonomyPolicy => ({ ...DEFAULT_AUTONOMY, level });
const ACTIONS: AutonomyAction[] = [
  "queue_experiment",
  "forge_code",
  "run_backtest",
  "promote_paper",
  "deploy_unreviewed",
  "mutate_risk_limits",
  "real_money_order",
];

describe("autonomy gate (APEX D-03)", () => {
  it("never allows real money, unreviewed deploys or risk mutation, even with the stored flag on", () => {
    for (const level of [0, 1, 2, 3, 4]) {
      for (const action of ["deploy_unreviewed", "mutate_risk_limits", "real_money_order"] as const) {
        const gate = assertActionAllowed({ ...policy(level), allowRiskLimitMutation: true }, action);
        expect(gate.allowed, `${action} at level ${level}`).toBe(false);
      }
    }
  });

  it("matches the explicit permission matrix", () => {
    const table = Object.fromEntries(
      [0, 1, 2, 3, 4].map((level) => [
        level,
        Object.fromEntries(
          ACTIONS.map((action) => {
            const gate = assertActionAllowed(policy(level), action);
            return [action, gate.allowed ? (gate.requiresApproval ? "approval" : "allow") : "deny"];
          }),
        ),
      ]),
    );
    expect(table[0]).toMatchObject({ queue_experiment: "allow", forge_code: "deny", run_backtest: "deny", promote_paper: "deny" });
    expect(table[1]).toMatchObject({ queue_experiment: "allow", forge_code: "approval", run_backtest: "approval", promote_paper: "approval" });
    // Level 2 used to fall through to an unconditional "Permitted" for forging and backtests.
    expect(table[2]).toMatchObject({ queue_experiment: "allow", forge_code: "approval", run_backtest: "approval", promote_paper: "approval" });
    expect(table[3]).toMatchObject({ queue_experiment: "allow", forge_code: "allow", run_backtest: "allow", promote_paper: "approval" });
    // Level 4 is the disabled real-money level: it is not "more autonomous", it is off.
    expect(Object.values(table[4]!).every((value) => value === "deny")).toBe(true);
  });

  it("denies an unknown action rather than defaulting to allow", () => {
    expect(assertActionAllowed(policy(3), "rewrite_engine" as AutonomyAction).allowed).toBe(false);
  });

  it("forces risk mutation off when a stored row says otherwise", () => {
    const parsed = parseAutonomyPolicy({ level: 2, allowRiskLimitMutation: true });
    expect(parsed.allowRiskLimitMutation).toBe(false);
    expect(parsed.realMoneyExecutionEnabled).toBe(false);
    expect(parsed.allowUnreviewedCodeDeploy).toBe(false);
  });
});
