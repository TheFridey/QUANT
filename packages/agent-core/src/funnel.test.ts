import { describe, expect, it } from "vitest";
import {
  funnelEventsFromPlan,
  recordFunnelEvent,
  summarizeFunnel,
  uniqueFunnelEvents,
} from "./funnel.js";

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

  it("maps plan decisions into durable funnel stages with reason codes", () => {
    const events = funnelEventsFromPlan({
      cycleId: "c2",
      decisions: [
        {
          agent: "SENTINEL",
          modelVersion: "s",
          pairAddress: "fx:EURUSD",
          decision: "PASS",
          confidence: "1",
          reasonCodes: ["DISCOVERY_RANKED"],
          input: {},
          output: {},
        },
        {
          agent: "PULSE",
          modelVersion: "p",
          pairAddress: "fx:EURUSD",
          decision: "ACT",
          confidence: "1",
          reasonCodes: ["ENTRY_MOMENTUM"],
          input: {},
          output: { side: "BUY", intent: "ENTRY" },
        },
        {
          agent: "ATLAS",
          modelVersion: "a",
          pairAddress: "fx:EURUSD",
          decision: "REJECT",
          confidence: "1",
          reasonCodes: ["AGGREGATE_EXPOSURE"],
          input: {},
          output: {},
        },
      ],
      orders: [],
    });
    const summary = summarizeFunnel(events);
    expect(summary.DISCOVERED).toBe(1);
    expect(summary.SIGNALLED).toBe(1);
    expect(summary.REJECTED).toBe(1);
    expect(events.every((event) => event.reasonCodes.length > 0)).toBe(true);
  });

  it("uniqueFunnelEvents collapses duplicate cycle|pair|stage rows", () => {
    const duped = [
      {
        cycleId: "c1",
        pairAddress: "fx:EURUSD",
        stage: "DISCOVERED" as const,
        reasonCodes: ["DISCOVERY_RANKED"],
        at: "2026-10-28T12:00:00.000Z",
      },
      {
        cycleId: "c1",
        pairAddress: "fx:EURUSD",
        stage: "DISCOVERED" as const,
        reasonCodes: ["DISCOVERY_FILTERED"],
        at: "2026-10-28T12:00:01.000Z",
      },
      {
        cycleId: "c1",
        pairAddress: "fx:EURUSD",
        stage: "SIGNALLED" as const,
        reasonCodes: ["ENTRY_MOMENTUM"],
        at: "2026-10-28T12:00:02.000Z",
      },
    ];
    const unique = uniqueFunnelEvents(duped);
    expect(unique).toHaveLength(2);
    expect(unique.find((e) => e.stage === "DISCOVERED")?.reasonCodes).toContain("DISCOVERY_FILTERED");
    expect(summarizeFunnel(unique).DISCOVERED).toBe(1);
  });
});
