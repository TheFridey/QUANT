import { describe, expect, it } from "vitest";
import { walkForwardClaim } from "./evaluation-ledger.js";

describe("walk-forward confirmation", () => {
  const startAt = "2026-01-01T00:00:00.000Z";
  const endAt = "2026-01-11T00:00:00.000Z";

  it("keeps the untouched window after validation and refuses a fit on that window", () => {
    const claim = walkForwardClaim({ startAt, endAt, tunedOnWindow: "train", trialsOnDataset: 1 });
    expect(Date.parse(claim.testStart)).toBeGreaterThanOrEqual(Date.parse(claim.validationEnd));
    expect(claim.outOfSample).toBe(true);
    const fitted = walkForwardClaim({ startAt, endAt, tunedOnWindow: "test", trialsOnDataset: 1 });
    expect(fitted.outOfSample).toBe(false);
    expect(fitted.reason).toContain("evaluation window");
  });

  it("records a repeated trial so the same dataset cannot be claimed as fresh confirmation", () => {
    const repeated = walkForwardClaim({ startAt, endAt, tunedOnWindow: "validation", trialsOnDataset: 2 });
    expect(repeated.outOfSample).toBe(false);
    expect(repeated.reason).toContain("Repeated testing");
  });
});
