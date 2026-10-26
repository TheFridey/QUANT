import { describe, expect, it } from "vitest";
import { forgeStrategyModule, staticCheck, destroyForgeWorkspace } from "./forge.js";
import type { Hypothesis } from "@odin/shared";

const hypothesis: Hypothesis = {
  title: "Liquid M5 thrust continuation",
  market: "SPOT_CRYPTO_PAIR",
  instrumentIds: ["solana:spot:universe"],
  conditions: "LIVE quote with liquidity floor",
  claimedAdvantage: "Short-horizon continuation",
  entryRules: "M5 in band",
  exitRules: "Stop or fade",
  riskRules: "ATLAS caps",
  rationale: "Package existing pulse rule",
  successCriteria: "OOS n>=30",
  failureModes: "Regime shift",
  status: "OPEN",
  id: "hyp_test_1",
};

describe("forge sandbox", () => {
  it("creates a versioned module and passes contract tests", () => {
    const result = forgeStrategyModule({ hypothesis });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceHash).toHaveLength(64);
    expect(result.module.instrumentIds).toEqual(["solana:spot:universe"]);
    destroyForgeWorkspace(result.workspacePath);
  });

  it("rejects code that touches credentials or risk overrides", () => {
    const evil = `
import fs from "fs";
process.env.DATABASE_URL;
function overrideRisk() {}
placeOrder({ real_money: true });
`;
    const findings = staticCheck(evil);
    expect(findings.length).toBeGreaterThan(0);
    const result = forgeStrategyModule({ hypothesis, source: evil });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STATIC_REJECT");
  });
});
