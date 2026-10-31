import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { strategyConfigOrExitOnly } from "./stage-runner.js";

/** Audit H1 (safety review F1): an invalid stored config blocks entries only — never exits or protection. */
describe("invalid stored strategy config", () => {
  it("passes a valid stored config through unchanged", () => {
    const stored = { ...DEFAULT_STRATEGY, maxPositions: 3 };
    const resolved = strategyConfigOrExitOnly(stored);
    expect(resolved.issues).toBeNull();
    expect(resolved.config.maxPositions).toBe(3);
    expect(resolved.config.pauseNewEntries).toBe(false);
  });

  it("pauses entries, keeps exits on the authoritative defaults, and names the failing field", () => {
    const stored = { ...DEFAULT_STRATEGY, startingBalanceUsd: "100.00000000", minOrderNotionalUsd: "5" };
    const snapshot = structuredClone(stored);
    const resolved = strategyConfigOrExitOnly(stored);
    expect(resolved.config.pauseNewEntries).toBe(true);
    expect(resolved.config.maxExitImpactBps).toBe(DEFAULT_STRATEGY.maxExitImpactBps);
    expect(resolved.config.allowDelayedExits).toBe(DEFAULT_STRATEGY.allowDelayedExits);
    expect(resolved.issues?.map((issue) => issue.path.join("."))).toContain("minOrderNotionalUsd");
    // Nothing is healed or rewritten.
    expect(stored).toEqual(snapshot);
  });

  it("never throws, even for a non-object stored value", () => {
    expect(() => strategyConfigOrExitOnly("garbage")).not.toThrow();
    expect(strategyConfigOrExitOnly({ privateKey: "x" }).config.pauseNewEntries).toBe(true);
  });
});
