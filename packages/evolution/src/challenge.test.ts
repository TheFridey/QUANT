import { describe, expect, it } from "vitest";
import { runChallengeReview } from "./challenge.js";
import { buildExperimentReport, verifyExperimentReport } from "./validate.js";
import { memoryForEntryDecision, createTradeMemoryStore, capturePhaseContext, appendTradeMemory } from "./memory.js";
import { transitionLifecycle } from "./lifecycle.js";

describe("challenge + validate + memory", () => {
  it("blocks look-ahead and leakage", () => {
    const report = runChallengeReview({
      sampleSize: 40,
      oosSampleSize: 40,
      inSampleReturnPct: "10",
      oosReturnPct: "8",
      maxDrawdownPct: "5",
      inactivePairCount: 0,
      disappearedPairCount: 0,
      parameterTrials: 1,
      usedFutureBars: true,
      usedPostExitMemoryInEntry: true,
      costModelPresent: true,
      monteCarloRan: true,
      correlatedSiblingStrategies: 0,
    });
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.code === "LOOK_AHEAD")).toBe(true);
    expect(report.findings.some((f) => f.code === "LEAKAGE")).toBe(true);
  });

  it("signs and verifies experiment reports", () => {
    const challenge = runChallengeReview({
      sampleSize: 40,
      oosSampleSize: 40,
      inSampleReturnPct: "2",
      oosReturnPct: "1",
      maxDrawdownPct: "4",
      inactivePairCount: 0,
      disappearedPairCount: 0,
      parameterTrials: 1,
      usedFutureBars: false,
      usedPostExitMemoryInEntry: false,
      costModelPresent: true,
      monteCarloRan: true,
      correlatedSiblingStrategies: 0,
    });
    const report = buildExperimentReport({
      reportId: "rpt1",
      hypothesisId: "hyp1",
      strategyModuleId: "mod1",
      strategyVersion: "0.1.0",
      models: [],
      datasetManifest: {
        observationCount: 100,
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-02T00:00:00.000Z",
        sources: ["fixture"],
        contentHash: "abc123456789",
      },
      periods: { train: "t", validation: "v", test: "s" },
      results: {
        sampleSize: 40,
        returnPct: "2",
        maxDrawdownPct: "4",
        releaseGateLabel: "NOT_RELEASE_READY",
      },
      uncertainty: ["paper≠live"],
      weaknesses: [],
      challenge,
      reproducibility: { codeHash: "codehash12", configHash: "cfghash123", seed: 1 },
    });
    expect(verifyExperimentReport(report)).toBe(true);
  });

  it("excludes post-exit memory from entry reconstruction", () => {
    let store = createTradeMemoryStore();
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "t1",
        pairAddress: "p1",
        phase: "BEFORE",
        context: { rsi: 40 },
      }),
    );
    store = appendTradeMemory(
      store,
      capturePhaseContext({
        tradeId: "t1",
        pairAddress: "p1",
        phase: "AFTER",
        context: { realizedPnlUsd: "12", exitPrice: "2" },
      }),
    );
    const entry = memoryForEntryDecision(store, "t1");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.phase).toBe("BEFORE");
  });

  it("audits lifecycle transitions with evidence hashes", () => {
    const result = transitionLifecycle({
      strategyId: "s1",
      from: "DRAFT",
      to: "CODE_GENERATED",
      actor: "test",
      evidence: { ok: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transition.evidenceHash).toHaveLength(64);
    expect(
      transitionLifecycle({
        strategyId: "s1",
        from: "DRAFT",
        to: "PAPER_ACTIVE",
        actor: "test",
        evidence: {},
      }).ok,
    ).toBe(false);
  });
});
