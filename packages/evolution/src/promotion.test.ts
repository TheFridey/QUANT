import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY, DEFAULT_STRATEGY, autonomyPolicySchema, parseStrategyConfig, type StrategyConfig } from "@odin/shared";
import { buildExperimentReport } from "./validate.js";
import {
  createPaperSlot,
  engineControlDataFromSlot,
  evidenceFromExperimentReport,
  promoteToPaperEngine,
  promotionBodySchema,
  recordStrategyReview,
  reviewPromotion,
  slotFromEngineControl,
  type PaperStrategySlot,
  type PromotionEvidence,
} from "./promotion.js";

const sourceHash = "a".repeat(64);
const artifactHash = "b".repeat(64);
const changedSource = "c".repeat(64);

function evidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    strategyId: "strat_reviewed",
    strategyVersion: "1.0.0",
    sourceHash,
    artifactHash,
    artifactSourceHash: sourceHash,
    approvalStatus: "APPROVED",
    reviewed: true,
    pipelineFinished: true,
    experimentExecuted: true,
    returnPct: "1.50",
    sampleSize: 40,
    minSampleSize: 30,
    statisticsRecorded: true,
    untouchedTestReturnPct: "1.10",
    untouchedSampleSize: 30,
    tunedOnEvaluationSample: false,
    forwardPaperValidated: true,
    ...overrides,
  };
}

function config(entryM5ChangePct: string): StrategyConfig {
  return { ...DEFAULT_STRATEGY, entryM5ChangePct };
}

function slot(): PaperStrategySlot {
  return createPaperSlot({
    strategyId: "pulse-bootstrap",
    strategyVersion: "0.0.0",
    sourceHash: "0".repeat(64),
    artifactHash: "1".repeat(64),
    config: config("2"),
  });
}

describe("operator promotion", () => {
  it("refuses unreviewed code and leaves the paper slot unchanged", () => {
    const paper = slot();
    const before = structuredClone(paper);
    const result = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ reviewed: false, approvalStatus: "PENDING" }),
      config: config("3"),
    });
    expect(result.appliedToPaperEngine).toBe(false);
    expect(result.deploymentEligible).toBe(false);
    expect(paper).toEqual(before);
    expect(paper.audits).toHaveLength(0);
    const rejected = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ approvalStatus: "REJECTED" }),
      config: config("3"),
    });
    expect(rejected.appliedToPaperEngine).toBe(false);
    expect(rejected.deploymentEligible).toBe(false);
    expect(paper).toEqual(before);
  });

  it("records a review without writing the paper engine", () => {
    const paper = slot();
    const before = structuredClone(paper);
    const review = recordStrategyReview(evidence());
    const legacy = reviewPromotion(
      { deploymentEligible: true, approvalStatus: "APPROVED", reviewed: true },
      paper,
    );
    expect(review.appliedToPaperEngine).toBe(false);
    expect(legacy.appliedToPaperEngine).toBe(false);
    expect(paper).toEqual(before);
    expect(paper.audits).toHaveLength(0);
  });

  it("promotes a reviewed strategy when an operator authorises it and the scientific gates pass", () => {
    const paper = slot();
    const result = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence(),
      config: config("3"),
      at: "2026-10-28T19:45:00.000Z",
    });
    expect(result.appliedToPaperEngine).toBe(true);
    expect(result.deploymentEligible).toBe(true);
    expect(paper.strategyId).toBe("strat_reviewed");
    expect(paper.strategyVersion).toBe("1.0.0");
    expect(paper.sourceHash).toBe(sourceHash);
    expect(paper.artifactHash).toBe(artifactHash);
    expect(paper.config.entryM5ChangePct).toBe("3");
    expect(paper.audits).toHaveLength(1);
    expect(paper.audits[0]).toMatchObject({
      operatorId: "operator@odin.local",
      at: "2026-10-28T19:45:00.000Z",
      strategyVersion: "1.0.0",
      sourceHash,
      artifactHash,
      previousStrategyId: "pulse-bootstrap",
      previousStrategyVersion: "0.0.0",
      previousSourceHash: "0".repeat(64),
      previousArtifactHash: "1".repeat(64),
    });
    expect(JSON.stringify(paper.audits[0])).not.toMatch(/API_KEY|JWT_SECRET|password/i);
    const stored = engineControlDataFromSlot(paper);
    expect(stored.id).toBe("primary");
    expect(parseStrategyConfig(stored.config).entryM5ChangePct).toBe("3");
    expect(stored.activeStrategy).toMatchObject({ strategyId: "strat_reviewed", sourceHash, artifactHash });
    expect(stored.config).not.toHaveProperty("sourceHash");
    const reloaded = slotFromEngineControl({ config: stored.config, activeStrategy: stored.activeStrategy });
    expect(reloaded.strategyVersion).toBe("1.0.0");
    const later = promoteToPaperEngine(reloaded, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ reviewed: false, approvalStatus: "PENDING", strategyVersion: "1.0.1" }),
      config: config("9"),
    });
    expect(later.appliedToPaperEngine).toBe(false);
    expect(reloaded.config.entryM5ChangePct).toBe("3");
    expect(reloaded.strategyVersion).toBe("1.0.0");
  });

  it("rejects ORACLE, FORGE, and model callers even when they set the authorisation flag", () => {
    for (const caller of ["ORACLE", "FORGE", "MODEL"] as const) {
      const paper = slot();
      const before = structuredClone(paper);
      const result = promoteToPaperEngine(paper, {
        operatorId: "operator@odin.local",
        authorised: true,
        caller,
        evidence: evidence(),
        config: config("3"),
      });
      expect(result.appliedToPaperEngine).toBe(false);
      expect(paper).toEqual(before);
    }
  });

  it("rejects a source or artifact hash that no longer matches the review", () => {
    const paper = slot();
    const stale = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ sourceHash: changedSource }),
      config: config("3"),
    });
    expect(stale.appliedToPaperEngine).toBe(false);
    const unbound = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ artifactSourceHash: changedSource }),
      config: config("3"),
    });
    expect(unbound.appliedToPaperEngine).toBe(false);
    expect(paper.strategyId).toBe("pulse-bootstrap");
    expect(paper.config.entryM5ChangePct).toBe("2");
  });

  it("refuses promotion when the return is null or statistics are unavailable", () => {
    const paper = slot();
    const nullReturn = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ returnPct: null, untouchedTestReturnPct: null }),
      config: config("3"),
    });
    expect(nullReturn.appliedToPaperEngine).toBe(false);
    expect(nullReturn.deploymentEligible).toBe(false);
    const unavailable = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ statisticsRecorded: false }),
      config: config("3"),
    });
    expect(unavailable.appliedToPaperEngine).toBe(false);
    expect(unavailable.deploymentEligible).toBe(false);
    expect(paper.config.entryM5ChangePct).toBe("2");
  });

  it("rejects a missing authorisation flag and a caller supplied on the request body", () => {
    const paper = slot();
    const before = structuredClone(paper);
    const missing = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: false,
      caller: "OPERATOR",
      evidence: evidence(),
      config: config("3"),
    });
    expect(missing.appliedToPaperEngine).toBe(false);
    expect(missing.deploymentEligible).toBe(false);
    expect(paper).toEqual(before);
    expect(promotionBodySchema.safeParse({ authorised: true, caller: "ORACLE", evidence: evidence(), config: config("3") }).success).toBe(false);
    expect(promotionBodySchema.safeParse({ authorised: false, evidence: evidence(), config: config("3") }).success).toBe(false);
  });

  it("does not add a real-money order path", () => {
    const source = readFileSync(new URL("./promotion.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/submitOrder|placeOrder|api\.binance|jup\.ag\/swap|realMoney/);
    expect(autonomyPolicySchema.safeParse({ ...DEFAULT_AUTONOMY, realMoneyExecutionEnabled: true }).success).toBe(false);
  });

  it("resolves promotion evidence from a persisted experiment report (D13)", () => {
    const report = buildExperimentReport({
      reportId: "rpt_promote",
      hypothesisId: "hyp1",
      strategyModuleId: "strat_reviewed",
      strategyVersion: "1.0.0",
      models: [],
      datasetManifest: {
        observationCount: 100,
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-02T00:00:00.000Z",
        sources: ["fixture"],
        contentHash: "a".repeat(64),
      },
      periods: { train: "t", validation: "v", test: "s" },
      results: {
        sampleSize: 40,
        returnPct: "1.50",
        maxDrawdownPct: "4",
        releaseGateLabel: "PROMOTION_REVIEW",
      },
      uncertainty: [],
      weaknesses: [],
      challenge: { passed: true, summary: "ok", findings: [], reviewer: "CHALLENGE", independent: true },
      approval: { status: "APPROVED", approvedBy: "operator@odin.local", approvedAt: "2026-10-28T19:00:00.000Z" },
      reproducibility: { codeHash: sourceHash, configHash: "c".repeat(64), seed: 1 },
      outcomes: {
        PIPELINE_COMPLETED: { met: true, detail: "ok" },
        EXPERIMENT_EXECUTED: { met: true, detail: "ok" },
        RESULTS_MEASURABLE: { met: true, detail: "ok" },
        STATISTICALLY_EVALUATED: { met: true, detail: "ok" },
        OUT_OF_SAMPLE_VALIDATED: { met: true, detail: "ok" },
        FORWARD_PAPER_VALIDATED: { met: true, detail: "ok" },
        DEPLOYMENT_ELIGIBLE: { met: true, detail: "ok" },
      },
    });
    const resolved = evidenceFromExperimentReport(report);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.evidence.strategyId).toBe("strat_reviewed");
    expect(resolved.evidence.sourceHash).toBe(sourceHash);
    expect(resolved.evidence.artifactHash).toBe(report.contentHash);
    expect(resolved.evidence.approvalStatus).toBe("APPROVED");
    expect(resolved.evidence.forwardPaperValidated).toBe(true);

    const paper = slot();
    const result = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: resolved.evidence,
      config: config("3"),
    });
    expect(result.appliedToPaperEngine).toBe(true);
    expect(paper.strategyId).toBe("strat_reviewed");
    expect(paper.artifactHash).toBe(report.contentHash);
  });

  it("accepts reportId on the promotion body schema without client evidence", () => {
    const parsed = promotionBodySchema.safeParse({
      authorised: true,
      reportId: "rpt_promote",
      config: config("3"),
    });
    expect(parsed.success).toBe(true);
    expect(
      promotionBodySchema.safeParse({ authorised: true, config: config("3") }).success,
    ).toBe(false);
  });
});
