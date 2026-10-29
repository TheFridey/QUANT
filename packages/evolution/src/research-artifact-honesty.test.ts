import { describe, expect, it } from "vitest";
import { isolationAvailable, probeIsolation } from "./sandbox-runner.js";

/**
 * Research artifact execution honesty (C36/C38/C39 residual):
 * Generated code must not claim paper signals without sandbox isolation / integrity.
 * Skip vs pass must be reported accurately for the local environment.
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

  it("documents sandbox skip vs pass honesty for C39 bounded research", () => {
    const probe = probeIsolation();
    const report = {
      scenario: "C39_BOUNDED_RESEARCH_SANDBOX",
      status: probe.available ? "PASS_LOCAL_ISOLATION" : "SKIP_ISOLATION_UNAVAILABLE",
      available: probe.available,
      runtime: probe.runtime,
      reason: probe.reason,
      // Never claim VERIFIED_EXTERNAL from sandbox probe alone.
      verifiedExternal: false,
    };
    expect(["PASS_LOCAL_ISOLATION", "SKIP_ISOLATION_UNAVAILABLE"]).toContain(report.status);
    expect(report.verifiedExternal).toBe(false);
    if (report.status === "SKIP_ISOLATION_UNAVAILABLE") {
      expect(report.available).toBe(false);
      expect(report.reason.length).toBeGreaterThan(0);
    } else {
      expect(report.available).toBe(true);
      expect(report.runtime).toBe("bubblewrap");
    }
  });
});
