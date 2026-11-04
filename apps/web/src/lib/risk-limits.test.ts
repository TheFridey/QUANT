import { describe, expect, it } from "vitest";
import {
  diffRiskDraft,
  draftFromConfig,
  patchFromChanges,
  RISK_LIMIT_FIELDS,
  riskDraftNotes,
  validateRiskDraft,
} from "./risk-limits";

const defaults = draftFromConfig(Object.fromEntries(RISK_LIMIT_FIELDS.map((field) => [field.key, field.defaultValue])));

describe("risk limits editor", () => {
  it("rejects non-numbers and out-of-range values before sending", () => {
    expect(validateRiskDraft(defaults)).toEqual({});
    expect(validateRiskDraft({ ...defaults, maxDailyLossPct: "abc" }).maxDailyLossPct).toBe("Enter a number");
    expect(validateRiskDraft({ ...defaults, maxTotalDrawdownPct: "150" }).maxTotalDrawdownPct).toBe("Must be between 0.1 and 100");
    expect(validateRiskDraft({ ...defaults, maxRiskPerTradePct: "0.001" }).maxRiskPerTradePct).toBe("Must be between 0.01 and 25");
  });

  it("sends only changed limits, as strings the server's patch schema accepts", () => {
    const changes = diffRiskDraft(defaults, { ...defaults, maxDailyLossPct: "15", maxTotalDrawdownPct: "10.0" });
    expect(changes).toEqual([{ key: "maxDailyLossPct", label: "Max daily loss %", from: "3", to: "15", loosens: true }]);
    const patch = patchFromChanges(changes);
    expect(patch).toEqual({ maxDailyLossPct: "15" });
    expect(diffRiskDraft(defaults, { ...defaults, maxRiskPerTradePct: "0.25" })[0]?.loosens).toBe(false);
  });

  it("warns when the daily limit cannot bind under the total-drawdown limit", () => {
    const notes = riskDraftNotes({ ...defaults, maxDailyLossPct: "15" }, { equityUsd: null, highWaterMarkUsd: null });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.tone).toBe("warning");
    expect(notes[0]?.text).toContain("always trips first");
    expect(notes[0]?.text).toContain("rest of the London day");
    expect(riskDraftNotes(defaults, { equityUsd: null, highWaterMarkUsd: null })).toEqual([]);
  });

  it("explains the current drawdown against the drafted total limit (production figures, 3 Nov 2026)", () => {
    const account = { equityUsd: "9093.15159827", highWaterMarkUsd: "10106.00207701" };
    const blocked = riskDraftNotes(defaults, account);
    expect(blocked[0]).toEqual({
      tone: "warning",
      // True threshold 9095.4019; equity must be strictly above it.
      text: "Current drawdown is 10.02%, at or above a 10% limit: new entries stay blocked (TOTAL_DRAWDOWN_LIMIT) until equity is above $9095.41. Other limits may still block.",
    });
    const room = riskDraftNotes({ ...defaults, maxTotalDrawdownPct: "20" }, account);
    expect(room[0]?.tone).toBe("info");
    expect(room[0]?.text).toContain("$8084.81");
  });
});
