import { describe, expect, it } from "vitest";
import { PIPELINE_STALL_MS, pipelineHealth } from "./pipeline-health.js";

const now = new Date("2026-11-10T10:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const old = ago(86_400_000);

describe("pipeline health", () => {
  it("is ok while cycles complete and stalled once they stop on a RUNNING engine", () => {
    expect(pipelineHealth({ engineStatus: "RUNNING", lastCompleteCycleAt: ago(20_000), now })).toBe("ok");
    expect(pipelineHealth({ engineStatus: "RUNNING", lastCompleteCycleAt: ago(PIPELINE_STALL_MS), now })).toBe("ok");
    expect(pipelineHealth({ engineStatus: "RUNNING", lastCompleteCycleAt: ago(PIPELINE_STALL_MS + 1), now })).toBe("stalled");
  });

  it("is never stalled when the engine is not meant to be cycling", () => {
    for (const engineStatus of ["PAUSED", "STOPPED", "EMERGENCY_STOP", null]) {
      expect(pipelineHealth({ engineStatus, lastCompleteCycleAt: old, now })).toBe("ok");
    }
  });

  it("has no history to judge on a database with no completed cycle", () => {
    expect(pipelineHealth({ engineStatus: "RUNNING", lastCompleteCycleAt: null, now })).toBe("ok");
  });
});
