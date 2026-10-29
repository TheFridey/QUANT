import { describe, expect, it } from "vitest";
import { isolationAvailable, probeIsolation } from "./sandbox-runner.js";

/**
 * Research artifact execution honesty (C36/C38/C39 residual):
 * Generated code must not claim paper signals without sandbox isolation / integrity.
 */
describe("research artifact execution honesty", () => {
  it("reports isolation availability honestly", () => {
    const available = isolationAvailable();
    expect(typeof available).toBe("boolean");
    const probe = probeIsolation();
    expect(probe).toHaveProperty("available");
    expect(probe.available).toBe(available);
    // When unavailable, callers must not invent PASS / signalsClaimed.
    if (!probe.available) {
      expect(probe.reason.length).toBeGreaterThan(0);
      expect(probe.runtime).toBe("disabled");
    }
  });
});
