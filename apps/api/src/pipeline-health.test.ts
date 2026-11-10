import { describe, expect, it } from "vitest";
import { PIPELINE_STALL_MS, pipelineHealth } from "./pipeline-health.js";

const now = new Date("2026-11-10T10:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const old = ago(86_400_000);

describe("pipeline health", () => {
  it("is ok while cycles complete and stalled once they stop on a RUNNING engine", () => {
    expect(pipelineHealth({ engineStatus: "RUNNING", engineUpdatedAt: old, lastCompleteCycleAt: ago(20_000), now })).toBe("ok");
    expect(pipelineHealth({ engineStatus: "RUNNING", engineUpdatedAt: old, lastCompleteCycleAt: ago(PIPELINE_STALL_MS), now })).toBe("ok");
    expect(pipelineHealth({ engineStatus: "RUNNING", engineUpdatedAt: old, lastCompleteCycleAt: ago(PIPELINE_STALL_MS + 1), now })).toBe("stalled");
  });

  it("is never stalled when the engine is not meant to be cycling", () => {
    for (const engineStatus of ["PAUSED", "STOPPED", "EMERGENCY_STOP", null]) {
      expect(pipelineHealth({ engineStatus, engineUpdatedAt: old, lastCompleteCycleAt: old, now })).toBe("ok");
    }
  });

  it("gives a just-started or just-resumed engine a full window", () => {
    expect(pipelineHealth({ engineStatus: "RUNNING", engineUpdatedAt: ago(10_000), lastCompleteCycleAt: null, now })).toBe("ok");
    expect(pipelineHealth({ engineStatus: "RUNNING", engineUpdatedAt: ago(10_000), lastCompleteCycleAt: old, now })).toBe("ok");
    expect(pipelineHealth({ engineStatus: "RUNNING", engineUpdatedAt: old, lastCompleteCycleAt: null, now })).toBe("stalled");
  });
});
