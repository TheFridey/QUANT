import { describe, expect, it } from "vitest";
import { RESEARCH_LOOP_QUEUE, researchLoopEveryMs } from "./research-loop.js";

describe("ASCEND-08 worker research loop schedule", () => {
  it("defaults to five minutes and refuses intervals under one minute", () => {
    expect(researchLoopEveryMs({})).toBe(300_000);
    expect(researchLoopEveryMs({ RESEARCH_LOOP_TICK_MS: "120000" })).toBe(120_000);
    expect(researchLoopEveryMs({ RESEARCH_LOOP_TICK_MS: "1000" })).toBe(300_000);
    expect(researchLoopEveryMs({ RESEARCH_LOOP_TICK_MS: "abc" })).toBe(300_000);
  });

  it("uses its own queue, separate from the trading stage queues", () => {
    expect(RESEARCH_LOOP_QUEUE).toBe("odin.research-loop");
  });
});
