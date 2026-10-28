import { describe, expect, it } from "vitest";
import { featuresForEntry, queryWinnersAndLosers, reconstructTrade } from "./archivist.js";
import { appendTradeMemory, capturePhaseContext, createTradeMemoryStore } from "./memory.js";

describe("archivist reconstruction", () => {
  it("separates before, during, and after and keeps post-trade fields out of entry features", () => {
    let store = createTradeMemoryStore();
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "t1",
        pairAddress: "pair",
        phase: "BEFORE",
        at: "2026-10-28T17:00:00.000Z",
        context: {
          marketStructure: "trend",
          momentum: "up",
          liquidityUsd: "100000",
          volumeUsd: "50000",
          volatility: "mid",
          agentSignals: ["PULSE_PASS"],
          historicalContext: "prior range",
          strategyVersion: "1.0.0",
          entryHypothesis: "continuation",
          riskCalculations: { stopPct: "2" },
          realizedPnlUsd: "999",
        },
      }),
    );
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "t1",
        pairAddress: "pair",
        phase: "DURING",
        at: "2026-10-28T17:01:00.000Z",
        context: {
          priceEvolution: ["1.0", "1.1"],
          mfePct: "4",
          maePct: "1",
          slippageBps: "8",
          liquidityChanges: ["down"],
          regime: "trend",
          riskEvents: [],
          executionEvents: ["FILL"],
        },
      }),
    );
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "t1",
        pairAddress: "pair",
        phase: "AFTER",
        at: "2026-10-28T17:02:00.000Z",
        context: {
          exitRationale: "target",
          netPnlUsd: "1.25",
          costsUsd: "0.04",
          compliance: "paper",
          postExitBehaviour: "fade",
          missedOpportunities: "none",
          unexpectedOutcomes: "none",
        },
      }),
    );
    const view = reconstructTrade(store.records);
    expect(view?.before?.entryHypothesis).toBe("continuation");
    expect(view?.before?.strategyVersion).toBe("1.0.0");
    expect(view?.during?.mfePct).toBe("4");
    expect(view?.after?.netPnlUsd).toBe("1.25");
    const entry = featuresForEntry(store, "t1");
    expect(entry.features.entryHypothesis).toBe("continuation");
    expect(entry.features.realizedPnlUsd).toBeUndefined();
    expect(entry.features.netPnlUsd).toBeUndefined();
    expect(entry.features.exitRationale).toBeUndefined();
    expect(JSON.stringify(entry.features)).not.toContain("1.25");
    const cohorts = queryWinnersAndLosers(store.records);
    expect(cohorts.winners).toHaveLength(1);
    expect(cohorts.winners[0]?.entryFactors.join(" ")).not.toContain("netPnlUsd");
    expect(cohorts.losers).toHaveLength(0);
  });

  it("leaves a missing net result unmeasurable", () => {
    const cohorts = queryWinnersAndLosers([
      {
        tradeId: "t2",
        pairAddress: "pair",
        phase: "AFTER",
        capturedAt: "2026-10-28T17:02:00.000Z",
        context: { exitRationale: "unknown" },
        postExit: true,
      },
    ]);
    expect(cohorts.unmeasurable).toHaveLength(1);
    expect(cohorts.winners).toHaveLength(0);
    expect(cohorts.losers).toHaveLength(0);
  });
});
