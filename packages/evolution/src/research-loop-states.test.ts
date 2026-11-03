import { describe, expect, it } from "vitest";
import {
  CLAIMABLE_EXPERIMENT_STATES,
  GATED_STAGE_ACTIONS,
  RESEARCH_EXPERIMENT_STATES,
  RESEARCH_EXPERIMENT_TRANSITIONS,
  canTransitionExperiment,
  isTerminalExperimentState,
  nextStage,
} from "./research-loop-states.js";

describe("ASCEND-08 research experiment transition table", () => {
  it("advances the happy path one stage at a time", () => {
    const path = ["OBSERVE", "HYPOTHESISE", "FORGE", "TEST", "CHALLENGE", "VALIDATE", "PAPER", "REVIEW"];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionExperiment(path[index]!, path[index + 1]!)).toEqual({ ok: true });
      expect(nextStage(path[index] as never)).toBe(path[index + 1]);
    }
    expect(nextStage("REVIEW")).toBeNull();
  });

  it("refuses skipping stages and moving backwards", () => {
    expect(canTransitionExperiment("OBSERVE", "FORGE").ok).toBe(false);
    expect(canTransitionExperiment("HYPOTHESISE", "TEST").ok).toBe(false);
    expect(canTransitionExperiment("FORGE", "VALIDATE").ok).toBe(false);
    expect(canTransitionExperiment("VALIDATE", "REVIEW").ok).toBe(false);
    expect(canTransitionExperiment("TEST", "FORGE").ok).toBe(false);
    expect(canTransitionExperiment("CHALLENGE", "PAPER").ok).toBe(false);
  });

  it("has no exits from terminal states", () => {
    for (const terminal of ["REJECTED", "FAILED", "ABANDONED"]) {
      expect(isTerminalExperimentState(terminal)).toBe(true);
      for (const to of RESEARCH_EXPERIMENT_STATES) expect(canTransitionExperiment(terminal, to).ok).toBe(false);
    }
  });

  it("lets REVIEW only be abandoned (the loop never leaves REVIEW on its own)", () => {
    for (const to of RESEARCH_EXPERIMENT_STATES) {
      expect(canTransitionExperiment("REVIEW", to).ok).toBe(to === "ABANDONED");
    }
    expect(CLAIMABLE_EXPERIMENT_STATES).not.toContain("REVIEW");
  });

  it("only gated stages can block, and a block returns only to the stage it blocked", () => {
    for (const from of RESEARCH_EXPERIMENT_STATES) {
      const ok = canTransitionExperiment(from, "BLOCKED_APPROVAL").ok;
      expect(ok).toBe(Object.keys(GATED_STAGE_ACTIONS).includes(from));
    }
    expect(canTransitionExperiment("BLOCKED_APPROVAL", "FORGE", { blockedState: "FORGE" }).ok).toBe(true);
    expect(canTransitionExperiment("BLOCKED_APPROVAL", "TEST", { blockedState: "FORGE" }).ok).toBe(false);
    expect(canTransitionExperiment("BLOCKED_APPROVAL", "PAPER", { blockedState: "TEST" }).ok).toBe(false);
    expect(canTransitionExperiment("BLOCKED_APPROVAL", "PAPER", { blockedState: null }).ok).toBe(false);
    expect(canTransitionExperiment("BLOCKED_APPROVAL", "VALIDATE", { blockedState: "VALIDATE" }).ok).toBe(false);
  });

  it("gates forge, backtest and paper-candidate marking", () => {
    expect(GATED_STAGE_ACTIONS).toEqual({ FORGE: "forge_code", TEST: "run_backtest", PAPER: "promote_paper" });
  });

  it("rejects unknown states", () => {
    expect(canTransitionExperiment("DEPLOY", "OBSERVE").ok).toBe(false);
    expect(canTransitionExperiment("OBSERVE", "LIVE").ok).toBe(false);
  });

  it("every listed target is a known state", () => {
    for (const [from, targets] of Object.entries(RESEARCH_EXPERIMENT_TRANSITIONS)) {
      expect(RESEARCH_EXPERIMENT_STATES).toContain(from);
      for (const to of targets) expect(RESEARCH_EXPERIMENT_STATES).toContain(to);
    }
  });
});
