import { describe, expect, it } from "vitest";
import { classifyReasonCodes, isHardBlock, securityAllowsEntry } from "./blocks.js";

describe("hard blocks vs advisories (B29)", () => {
  it("treats UNKNOWN security as not pass", () => {
    expect(securityAllowsEntry("PASS")).toBe(true);
    expect(securityAllowsEntry("UNKNOWN")).toBe(false);
    expect(securityAllowsEntry("BLOCK")).toBe(false);
    expect(securityAllowsEntry(null)).toBe(false);
  });

  it("classifies pause/suspend as hard blocks and advisory-only as advisory", () => {
    expect(isHardBlock("PAUSE_NEW_ENTRIES")).toBe(true);
    expect(isHardBlock("ENTRIES_SUSPENDED")).toBe(true);
    const classified = classifyReasonCodes([
      "PAUSE_NEW_ENTRIES",
      "ADVISORY_ONLY",
      "ENTRY_MOMENTUM",
    ]);
    expect(classified.hardBlocks).toEqual(["PAUSE_NEW_ENTRIES"]);
    expect(classified.advisories).toEqual(["ADVISORY_ONLY"]);
    expect(classified.other).toEqual(["ENTRY_MOMENTUM"]);
  });
});
