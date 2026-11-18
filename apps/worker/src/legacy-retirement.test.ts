import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { applyLegacyRetirement, legacyRetirementFromEnv } from "./legacy-retirement.js";

describe("CATALYST legacy crypto retirement flag", () => {
  it("defaults to ACTIVE: today's behaviour is unchanged", () => {
    for (const env of [{}, { LEGACY_CRYPTO_MODE: "" }, { LEGACY_CRYPTO_MODE: "active" }, { LEGACY_CRYPTO_MODE: " ACTIVE " }]) {
      expect(legacyRetirementFromEnv(env)).toEqual({ mode: "ACTIVE", discoveryEnabled: true, newEntriesEnabled: true, issue: null });
    }
  });

  it("RETIRED turns discovery and new entries off", () => {
    expect(legacyRetirementFromEnv({ LEGACY_CRYPTO_MODE: "RETIRED" })).toEqual({ mode: "RETIRED", discoveryEnabled: false, newEntriesEnabled: false, issue: null });
    expect(legacyRetirementFromEnv({ LEGACY_CRYPTO_MODE: "retired" }).mode).toBe("RETIRED");
  });

  it("an unrecognised value retires (the side that only reduces activity) and says so", () => {
    const r = legacyRetirementFromEnv({ LEGACY_CRYPTO_MODE: "RETIERD" });
    expect(r).toMatchObject({ mode: "RETIRED", discoveryEnabled: false, newEntriesEnabled: false });
    expect(r.issue).toBe("UNRECOGNISED_LEGACY_CRYPTO_MODE:RETIERD");
  });

  it("only ever tightens pauseNewEntries, and changes nothing else in the config", () => {
    const retired = legacyRetirementFromEnv({ LEGACY_CRYPTO_MODE: "RETIRED" });
    const active = legacyRetirementFromEnv({});
    const open = { ...DEFAULT_STRATEGY, pauseNewEntries: false };
    const paused = { ...DEFAULT_STRATEGY, pauseNewEntries: true };
    expect(applyLegacyRetirement(open, retired)).toEqual({ ...open, pauseNewEntries: true });
    expect(applyLegacyRetirement(paused, retired)).toBe(paused);
    // ACTIVE never lifts an operator's pause.
    expect(applyLegacyRetirement(paused, active)).toBe(paused);
    expect(applyLegacyRetirement(open, active)).toBe(open);
    // Exit settings are untouched.
    const out = applyLegacyRetirement(open, retired);
    expect(out.maxExitImpactBps).toBe(open.maxExitImpactBps);
    expect(out.allowDelayedExits).toBe(open.allowDelayedExits);
    expect(open.pauseNewEntries).toBe(false);
  });
});
