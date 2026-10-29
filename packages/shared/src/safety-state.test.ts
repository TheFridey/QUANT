import { describe, expect, it } from "vitest";
import { alertAckClearsSafetyCode, entriesSuspendedFromSafety, SAFETY_CODES } from "./safety-state.js";

describe("safety state vs alert ACK (R06)", () => {
  it("ACTIVE ENTRIES_SUSPENDED suspends entries", () => {
    expect(
      entriesSuspendedFromSafety([
        { code: SAFETY_CODES.ENTRIES_SUSPENDED, status: "ACTIVE" },
        { code: SAFETY_CODES.RECONCILE_ISSUE, status: "RESOLVED" },
      ]),
    ).toBe(true);
  });

  it("RESOLVED or missing suspension does not suspend", () => {
    expect(
      entriesSuspendedFromSafety([{ code: SAFETY_CODES.ENTRIES_SUSPENDED, status: "RESOLVED" }]),
    ).toBe(false);
    expect(entriesSuspendedFromSafety([])).toBe(false);
  });

  it("ACTIVE PROTECTION_RECOVERY suspends entries", () => {
    expect(
      entriesSuspendedFromSafety([
        { code: SAFETY_CODES.PROTECTION_RECOVERY, status: "ACTIVE" },
      ]),
    ).toBe(true);
    expect(
      entriesSuspendedFromSafety([
        { code: SAFETY_CODES.PROTECTION_RECOVERY, status: "RESOLVED" },
      ]),
    ).toBe(false);
  });

  it("alert ACK never clears safety codes", () => {
    expect(alertAckClearsSafetyCode(SAFETY_CODES.ENTRIES_SUSPENDED)).toBe(false);
    expect(alertAckClearsSafetyCode(SAFETY_CODES.PROTECTION_RECOVERY)).toBe(false);
    expect(alertAckClearsSafetyCode("ANY")).toBe(false);
  });
});
