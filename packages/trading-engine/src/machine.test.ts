import { describe, expect, it } from "vitest";
import { allowedActions, transition } from "./machine.js";

describe("engine state machine", () => {
  it("allows the operational path and rejects illegal jumps", () => {
    expect(transition("STOPPED", "start")).toBe("RUNNING");
    expect(transition("RUNNING", "pause")).toBe("PAUSED");
    expect(transition("PAUSED", "resume")).toBe("RUNNING");
    expect(transition("RUNNING", "emergency_stop")).toBe("EMERGENCY_STOP");
    expect(transition("EMERGENCY_STOP", "resume")).toBe("RUNNING");
    expect(transition("EMERGENCY_STOP", "stop")).toBe("STOPPED");
    expect(transition("RUNNING", "start")).toBeNull();
    expect(transition("STOPPED", "pause")).toBeNull();
    expect(allowedActions("RUNNING")).toEqual(["pause", "emergency_stop"]);
  });
});
