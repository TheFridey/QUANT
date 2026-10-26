import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { approveResearchProposal, rejectResearchProposal, runWalkForward } from "./research.js";

describe("offline research loop", () => {
  it("evaluates a walk-forward proposal without promoting it", () => {
    const proposal = runWalkForward({
      id: "research_1",
      createdAt: "2026-10-26T16:00:00.000Z",
      baseline: DEFAULT_STRATEGY,
      parameterPatch: { stopLossPct: "2.5" },
      rationale: "Tighter stop in train window",
      window: {
        trainStart: "2026-10-01T00:00:00.000Z",
        trainEnd: "2026-10-15T00:00:00.000Z",
        testStart: "2026-10-15T00:00:00.000Z",
        testEnd: "2026-10-26T00:00:00.000Z",
      },
      trainTrades: [
        { closedAt: "2026-10-10T00:00:00.000Z", pnlUsd: "1.5" },
        { closedAt: "2026-10-11T00:00:00.000Z", pnlUsd: "-0.5" },
      ],
      testTrades: [{ closedAt: "2026-10-20T00:00:00.000Z", pnlUsd: "0.25" }],
      cashUsd: "100.00000000",
      startingBalanceUsd: "100.00000000",
    });
    expect(proposal.status).toBe("EVALUATED");
    expect(proposal.promoted).toBe(false);
    expect(proposal.walkForward?.trainSampleSize).toBe(2);
    expect(proposal.walkForward?.testSampleSize).toBe(1);
    const approved = approveResearchProposal(proposal, "2026-10-26T17:00:00.000Z");
    expect(approved.status).toBe("APPROVED");
    expect(approved.promoted).toBe(false);
    expect(rejectResearchProposal(proposal).status).toBe("REJECTED");
  });
});
