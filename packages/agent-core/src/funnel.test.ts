import { describe, expect, it } from "vitest";
import { recordFunnelEvent, summarizeFunnel } from "./funnel.js";

describe("opportunity funnel", () => {
  it("persists stage transitions with reason codes", () => {
    let events = recordFunnelEvent([], {
      cycleId: "c1",
      pairAddress: "fx:EURUSD",
      stage: "DISCOVERED",
      reasonCodes: ["DISCOVERY_RANKED"],
    });
    events = recordFunnelEvent(events, {
      cycleId: "c1",
      pairAddress: "fx:EURUSD",
      stage: "SIGNALLED",
      reasonCodes: ["ENTRY_MOMENTUM"],
    });
    events = recordFunnelEvent(events, {
      cycleId: "c1",
      pairAddress: "fx:EURUSD",
      stage: "REJECTED",
      reasonCodes: ["AGGREGATE_EXPOSURE"],
    });
    const summary = summarizeFunnel(events);
    expect(summary.DISCOVERED).toBe(1);
    expect(summary.SIGNALLED).toBe(1);
    expect(summary.REJECTED).toBe(1);
  });
});
