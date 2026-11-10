import { describe, expect, it } from "vitest";
import { composeHorizonVerdict, mlHoldoutStatus, strategyHoldoutStatus, type VerdictMlInput, type VerdictStrategyInput } from "./horizon-verdict.js";

/**
 * Mixed-result studies. Expected verdicts are written from the rule ("pending" needs every pre-holdout test
 * passed and an unread holdout), not derived from the implementation.
 */
const base = { lateBars: 0, bars: 5000, minBars: 1500, minOosTrades: 30, programmeTrials: 3000 };
const oos = { bars: 800, trades: 60 };
const s = (id: string, over: Partial<VerdictStrategyInput>): VerdictStrategyInput => ({ id, verdict: "INSUFFICIENT_EVIDENCE", walkForwardPassed: false, holdoutStatus: "NOT_REACHED", oos, ...over });
const compose = (strategies: VerdictStrategyInput[], ml: VerdictMlInput[] = [], over: Partial<typeof base> = {}) => composeHorizonVerdict({ ...base, ...over, strategies, ml });

describe("HORIZON verdict composition", () => {
  it("rejected hypotheses in a read-only (withheld) run never make the study pending", () => {
    // Costs, risk, overfit and sample failures all stop before the holdout: status NOT_REACHED, whatever the run's policy.
    const failed = [
      s("costs", { verdict: "REJECTED_COSTS" }),
      s("risk", { verdict: "REJECTED_RISK" }),
      s("overfit", { verdict: "REJECTED_OVERFIT" }),
      s("thin", { verdict: "INSUFFICIENT_EVIDENCE", oos: { bars: 800, trades: 12 } }),
    ];
    const out = compose(failed, [{ horizonBars: 8, verdict: "NO_SKILL", holdoutStatus: "NOT_REACHED" }]);
    expect(out.verdict).toBe("NO_SKILL");
    expect(out.pending).toEqual([]);
  });

  it("status derivation: a failed walk-forward is NOT_REACHED even when no gate was supplied", () => {
    expect(strategyHoldoutStatus({ walkForwardPassed: false, holdoutEvaluated: false, gatePresent: false })).toBe("NOT_REACHED");
    expect(strategyHoldoutStatus({ walkForwardPassed: true, holdoutEvaluated: false, gatePresent: false })).toBe("WITHHELD");
    expect(strategyHoldoutStatus({ walkForwardPassed: true, holdoutEvaluated: false, gatePresent: true })).toBe("ALREADY_CONSUMED");
    expect(strategyHoldoutStatus({ walkForwardPassed: true, holdoutEvaluated: true, gatePresent: true })).toBe("EVALUATED");
    expect(mlHoldoutStatus({ evaluated: false, reason: "walk-forward did not pass (REJECTED_COSTS)" })).toBe("NOT_REACHED");
    expect(mlHoldoutStatus({ evaluated: false, reason: "walk-forward passed; holdout withheld (no gate supplied to record its consumption)" })).toBe("WITHHELD");
    expect(mlHoldoutStatus({ evaluated: false, reason: "holdout ml2|X|h8 already consumed; it is evaluated once only" })).toBe("ALREADY_CONSUMED");
    expect(mlHoldoutStatus({ evaluated: false, reason: "final model could not be fitted" })).toBe("NOT_REACHED");
    expect(mlHoldoutStatus({ evaluated: true })).toBe("EVALUATED");
  });

  it("insufficient samples everywhere is INSUFFICIENT_EVIDENCE, not NO_SKILL", () => {
    const out = compose([s("a", { verdict: "REJECTED_DATA", oos: null }), s("b", { verdict: "REJECTED_DATA", oos: null })], [{ horizonBars: 8, verdict: "INSUFFICIENT_EVIDENCE", holdoutStatus: "NOT_REACHED" }], { bars: 600 });
    expect(out.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.reasons[0]).toMatch(/600 bars/);
  });

  it("genuine walk-forward eligibility awaiting its holdout is pending, and names the hypothesis", () => {
    const out = compose([s("costs", { verdict: "REJECTED_COSTS" }), s("eligible", { walkForwardPassed: true, holdoutStatus: "WITHHELD" })]);
    expect(out.verdict).toBe("CANDIDATE_PENDING_HOLDOUT");
    expect(out.pending).toEqual(["eligible"]);
    const ml = compose([s("costs", { verdict: "REJECTED_COSTS" })], [{ horizonBars: 8, verdict: "INSUFFICIENT_EVIDENCE", holdoutStatus: "WITHHELD" }]);
    expect(ml.verdict).toBe("CANDIDATE_PENDING_HOLDOUT");
    expect(ml.pending).toEqual(["ml2:h8"]);
  });

  it("a walk-forward pass below the market's minimum sample is not pending", () => {
    const out = compose([s("thin-pass", { walkForwardPassed: true, holdoutStatus: "WITHHELD", oos: { bars: 800, trades: 31 } })], [], { minOosTrades: 50 });
    expect(out.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.reasons[0]).toMatch(/fewer than the market minimum of 50/);
  });

  it("a recorded holdout failure is NO_SKILL: evaluated, so neither pending nor candidate", () => {
    const out = compose([s("failed-holdout", { verdict: "REJECTED_OVERFIT", walkForwardPassed: true, holdoutStatus: "EVALUATED" })], [{ horizonBars: 8, verdict: "REJECTED_OVERFIT", holdoutStatus: "EVALUATED" }]);
    expect(out.verdict).toBe("NO_SKILL");
    expect(out.pending).toEqual([]);
  });

  it("a holdout consumed by an earlier run is not pending and says so", () => {
    const out = compose([s("spent", { walkForwardPassed: true, holdoutStatus: "ALREADY_CONSUMED" })]);
    expect(out.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.consumed).toEqual(["spent"]);
    expect(out.reasons[0]).toMatch(/already consumed/);
  });

  it("data rejection: late bars with no ML run is REJECTED_DATA; a refused ML run does not count as having run", () => {
    const rejected = [s("a", { verdict: "REJECTED_DATA", oos: null })];
    expect(compose(rejected, [{ horizonBars: 8, refused: "REFUSED: bar integrity" }], { lateBars: 3 }).verdict).toBe("REJECTED_DATA");
    expect(compose(rejected, [], { lateBars: 3 }).verdict).toBe("REJECTED_DATA");
  });

  it("a successful research candidate wins over pending and failed siblings", () => {
    const out = compose([
      s("winner", { verdict: "VALIDATED_CANDIDATE", walkForwardPassed: true, holdoutStatus: "EVALUATED" }),
      s("waiting", { walkForwardPassed: true, holdoutStatus: "WITHHELD" }),
      s("costs", { verdict: "REJECTED_COSTS" }),
    ]);
    expect(out.verdict).toBe("CANDIDATE");
    expect(out.reasons[0]).toMatch(/Research status only/);
    expect(compose([], [{ horizonBars: 8, verdict: "CANDIDATE", holdoutStatus: "EVALUATED" }]).verdict).toBe("CANDIDATE");
  });
});
