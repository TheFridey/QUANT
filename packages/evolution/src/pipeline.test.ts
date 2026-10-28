import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY, type Hypothesis } from "@odin/shared";
import { runResearchPipeline } from "./pipeline.js";
import { isolationAvailable } from "./sandbox-runner.js";

const hypothesis: Hypothesis = {
  id: "hyp_e2e",
  title: "E2E momentum packaging",
  market: "SPOT_CRYPTO_PAIR",
  instrumentIds: ["solana:spot:universe"],
  conditions: "LIVE liquid Solana pairs",
  claimedAdvantage: "M5 continuation",
  entryRules: "band entry",
  exitRules: "stop/tp/fade",
  riskRules: "atlas",
  rationale: "evolution e2e",
  successCriteria: "oos evidence",
  failureModes: "regime",
  status: "OPEN",
};

describe("research pipeline e2e", () => {
  it("runs OBSERVE→REVIEW with honest acceptance flags", async () => {
    const result = await runResearchPipeline({
      hypothesis,
      autonomy: DEFAULT_AUTONOMY,
      testMetrics: {
        sampleSize: 40,
        returnPct: "1.25",
        maxDrawdownPct: "4.2",
        oosSampleSize: 35,
        releaseGateLabel: "NOT_RELEASE_READY",
        observationCount: 500,
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-10T00:00:00.000Z",
      },
    });
    expect(result.stages).toEqual([
      "OBSERVE",
      "HYPOTHESISE",
      "FORGE",
      "TEST",
      "CHALLENGE",
      "VALIDATE",
      "PAPER",
      "REVIEW",
    ]);
    expect(result.acceptance.hypothesis_discovered).toBe("PASS");
    expect(result.acceptance.historical_measurable_results).toBe("FAIL");
    expect(result.acceptance.forward_paper_trades_recorded).toBe("SKIP");
    expect(result.acceptance.post_trade_memory_update).toBe("SKIP");
    if (isolationAvailable()) {
      expect(result.forge.ok).toBe(true);
      expect(result.forge.signalsClaimed).toBe(true);
      expect(result.report).not.toBeNull();
      expect(result.acceptance.coding_model_creates_candidate).toBe("PASS");
      expect(result.acceptance.sandbox_run).toBe("PASS");
      expect(result.acceptance.independent_challenge).toBe("PASS");
      expect(result.acceptance.versioned_evidence_report).toBe("PASS");
      expect(result.acceptance.reject_or_approved_paper_eval).toBe("PASS");
      expect(result.acceptance.subsequent_experiment_proposed).toBe("PASS");
    } else {
      expect(result.forge.ok).toBe(false);
      expect(result.forge.signalsClaimed).toBe(false);
      expect(result.report).toBeNull();
      expect(result.acceptance.coding_model_creates_candidate).toBe("SKIP");
      expect(result.acceptance.sandbox_run).toBe("SKIP");
    }
    expect(result.returnPct).toBeNull();
    expect(result.outcomes.PIPELINE_COMPLETED.met).toBe(true);
    expect(result.outcomes.RESULTS_MEASURABLE.met).toBe(false);
    expect(result.outcomes.DEPLOYMENT_ELIGIBLE.met).toBe(false);
    expect(result.test.measurable).toBe(false);
  });
});
