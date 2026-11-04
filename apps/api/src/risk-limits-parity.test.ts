import { DEFAULT_STRATEGY, parseStrategyConfig, strategyPatchSchema } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { diffRiskDraft, draftFromConfig, patchFromChanges, RISK_LIMIT_FIELDS } from "../../web/src/lib/risk-limits";

// The web risk-limits editor mirrors bounds and defaults from packages/shared/src/strategy.ts
// (the web app does not depend on @odin/shared). This fails if they drift.
describe("web risk-limits editor parity with the strategy schema", () => {
  it("mirrors the authoritative defaults and bounds in packages/shared", () => {
    for (const field of RISK_LIMIT_FIELDS) {
      expect(String(DEFAULT_STRATEGY[field.key]), field.key).toBe(field.defaultValue);
      // A large balance keeps the separate min-order-vs-position-budget rule out of the way at the minimum.
      const at = (value: string) => () =>
        parseStrategyConfig({ ...DEFAULT_STRATEGY, startingBalanceUsd: "10000000.00000000", [field.key]: value });
      expect(at(field.min), `${field.key} min`).not.toThrow();
      expect(at(field.max), `${field.key} max`).not.toThrow();
      expect(at(String(Number(field.min) / 2)), `${field.key} below min`).toThrow();
      expect(at(String(Number(field.max) + 1)), `${field.key} above max`).toThrow();
    }
  });

  it("produces a patch the server's schema accepts", () => {
    const defaults = draftFromConfig(DEFAULT_STRATEGY as unknown as Record<string, unknown>);
    const patch = patchFromChanges(diffRiskDraft(defaults, { ...defaults, maxDailyLossPct: "15" }));
    expect(strategyPatchSchema.parse(patch)).toEqual({ maxDailyLossPct: "15" });
  });
});
