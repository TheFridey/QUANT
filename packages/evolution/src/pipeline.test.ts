import { describe, expect, it } from "vitest";
import { runResearchPipeline } from "./pipeline.js";
import { DEFAULT_AUTONOMY, type Hypothesis } from "@odin/shared";

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
    expect(result.forge.ok).toBe(true);
    expect(result.report).not.toBeNull();
    expect(result.acceptance.hypothesis_discovered).toBe("PASS");
    expect(result.acceptance.coding_model_creates_candidate).toBe("PASS");
    expect(result.acceptance.sandbox_run).toBe("PASS");
    expect(result.acceptance.historical_measurable_results).toBe("PASS");
    expect(result.acceptance.independent_challenge).toBe("PASS");
    expect(result.acceptance.versioned_evidence_report).toBe("PASS");
    expect(result.acceptance.reject_or_approved_paper_eval).toBe("PASS");
    expect(result.acceptance.forward_paper_trades_recorded).toBe("PASS");
    expect(result.acceptance.post_trade_memory_update).toBe("PASS");
    expect(result.acceptance.subsequent_experiment_proposed).toBe("PASS");
  });
});
