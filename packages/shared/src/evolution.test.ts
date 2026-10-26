import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTONOMY,
  autonomyPolicySchema,
  canTransition,
  hypothesisSchema,
} from "./evolution.js";

describe("strategy lifecycle", () => {
  it("allows DRAFT → CODE_GENERATED → TESTING → CHALLENGED → VALIDATED", () => {
    expect(canTransition("DRAFT", "CODE_GENERATED")).toBe(true);
    expect(canTransition("CODE_GENERATED", "TESTING")).toBe(true);
    expect(canTransition("TESTING", "CHALLENGED")).toBe(true);
    expect(canTransition("CHALLENGED", "VALIDATED")).toBe(true);
    expect(canTransition("VALIDATED", "PAPER_CANDIDATE")).toBe(true);
    expect(canTransition("DRAFT", "PAPER_ACTIVE")).toBe(false);
    expect(canTransition("RETIRED", "DRAFT")).toBe(false);
  });
});

describe("hypothesis schema", () => {
  it("requires falsifiable fields", () => {
    const parsed = hypothesisSchema.parse({
      title: "M5 momentum fade on liquid Solana pairs",
      market: "SPOT_CRYPTO_PAIR",
      instrumentIds: ["solana:spot:universe"],
      conditions: "LIVE quote, liquidity >= threshold, WSOL/USDC quote",
      claimedAdvantage: "Short-horizon continuation after orderly M5 thrust",
      entryRules: "M5 change in [entry, maxEntry], H1 >= 0, buys > sells",
      exitRules: "Stop, take-profit, or M5 fade",
      riskRules: "Institutional ATLAS caps; no delayed entries",
      rationale: "Existing paper pulse rule — research packaging only",
      successCriteria: "OOS sample >= 30 and drawdown under release gate",
      failureModes: "Regime change, liquidity collapse, cost underestimation",
    });
    expect(parsed.status).toBe("OPEN");
  });
});

describe("autonomy policy", () => {
  it("defaults to level <= 2 with real money disabled", () => {
    const policy = autonomyPolicySchema.parse(DEFAULT_AUTONOMY);
    expect(policy.level).toBeLessThanOrEqual(2);
    expect(policy.realMoneyExecutionEnabled).toBe(false);
    expect(policy.allowUnreviewedCodeDeploy).toBe(false);
  });

  it("rejects unreviewed deploy even when someone tries to enable it at L3", () => {
    expect(() =>
      autonomyPolicySchema.parse({
        ...DEFAULT_AUTONOMY,
        level: 3,
        allowUnreviewedCodeDeploy: true,
      }),
    ).toThrow();
  });
});
