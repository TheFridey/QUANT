import { describe, expect, it } from "vitest";
import { MockModelProvider } from "./llm.js";
import { approveOracleSuggestions, runOracleReview } from "./oracle.js";

describe("ORACLE advisory module", () => {
  it("never claims trade execution and requires approval", async () => {
    const review = await runOracleReview(
      {
        runId: "run_1",
        strategyName: "default",
        sampleSize: 4,
        oosSampleSize: null,
        returnPct: "12.5",
        oosReturnPct: null,
        maxDrawdownPct: "3.0",
        profitFactor: null,
        sampleGatePassed: false,
        releaseGateLabel: "NOT_RELEASE_READY",
        baselines: [{ name: "no_trade_cash", returnPct: "0" }],
        assumptions: ["latency applied"],
        inactivePairCount: 1,
        disappearedPairCount: 1,
      },
      new MockModelProvider(),
    );
    expect(review.agent).toBe("ORACLE");
    expect(review.executesTrades).toBe(false);
    expect(review.approvalRequired).toBe(true);
    expect(review.payload.readiness).toBe("INSUFFICIENT_EVIDENCE");
    expect(review.payload.weaknesses.length).toBeGreaterThan(0);
  });

  it("approval does not promote to real money", () => {
    const approved = approveOracleSuggestions({
      reviewId: "or_1",
      approvedBy: "admin@odin.local",
      approvedAt: new Date().toISOString(),
    });
    expect(approved.promoted).toBe(false);
    expect(approved.realMoneyGraduation).toBe(false);
  });
});
