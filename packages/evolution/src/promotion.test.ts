import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinArtifactIdentity } from "@odin/agent-core";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_STRATEGY,
  autonomyPolicySchema,
  configHashOf,
  parseStrategyConfig,
  type StrategyConfig,
} from "@odin/shared";
import { finaliseEvaluation } from "./provenance.js";
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
  type SlotBinding,
} from "./promotion.js";

const identity = builtinArtifactIdentity("pulse-momentum-v1")!;
const sourceHash = identity.sourceHash;
const artifactHash = identity.artifactHash;

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

function validatedBinding(overrides: Partial<SlotBinding> = {}): SlotBinding {
  const cfg = config("3");
  return {
    mode: "VALIDATED",
    validationStatus: "VALIDATED",
    provenance: "COMPLETE",
    moduleRef: identity.moduleRef,
    moduleVersion: identity.moduleVersion,
    configHash: configHashOf(cfg),
    promotionId: "promo_1",
    reportId: "rpt_1",
    approvalId: "appr_1",
    artifactId: "art_1",
    deploymentEligible: true,
    liveEligible: false,
    ...overrides,
  };
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

function completeReport(cfg: StrategyConfig) {
  const executable = {
    kind: "BUILTIN_MODULE" as const,
    moduleRef: identity.moduleRef,
    moduleVersion: identity.moduleVersion,
    sourceHash,
    artifactHash,
    runtimeLoadable: true,
  };
  const evaluation = finaliseEvaluation(
    {
      protocol: { id: "PIPELINE_SANDBOX", version: "1" },
      config: cfg,
      configHash: configHashOf(cfg),
      dataset: {
        id: "ds1",
        hash: "d".repeat(64),
        basis: "fixture",
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-02T00:00:00.000Z",
        observationCount: 100,
      },
      partitions: [
        {
          name: "FULL",
          startAt: "2026-01-01T00:00:00.000Z",
          endAt: "2026-01-02T00:00:00.000Z",
          measured: true,
          sampleSize: 40,
          returnPct: "1.50",
          maxDrawdownPct: "4",
        },
        {
          name: "TRAIN",
          startAt: "2026-01-01T00:00:00.000Z",
          endAt: "2026-01-01T12:00:00.000Z",
          measured: true,
          sampleSize: 20,
          returnPct: "1.20",
          maxDrawdownPct: "3",
        },
        {
          name: "VALIDATION",
          startAt: "2026-01-01T12:00:00.000Z",
          endAt: "2026-01-01T18:00:00.000Z",
          measured: true,
          sampleSize: 10,
          returnPct: "0.90",
          maxDrawdownPct: "2",
        },
        {
          name: "TEST",
          startAt: "2026-01-01T18:00:00.000Z",
          endAt: "2026-01-02T00:00:00.000Z",
          measured: true,
          sampleSize: 30,
          returnPct: "1.10",
          maxDrawdownPct: "2.5",
        },
      ],
      minSampleSize: 30,
      tuning: {
        parameterTrials: 1,
        tunedOnEvaluationSample: false,
        basis: "fixed-params",
        history: [],
      },
      costs: { feeBps: "10", slippageModel: "fixed", latencyMs: 50 },
      forwardPaper: {
        status: "RECORDED",
        resultIds: ["fwd_1"],
        closedTradeCount: 30,
        returnPct: "0.80",
      },
    },
    executable,
  );
  return buildExperimentReport({
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
      contentHash: "d".repeat(64),
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
    reproducibility: { codeHash: sourceHash, configHash: configHashOf(cfg), seed: 1 },
    evaluation,
    executable,
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
      binding: validatedBinding(),
      at: "2026-10-28T19:45:00.000Z",
    });
    expect(result.appliedToPaperEngine).toBe(true);
    expect(result.deploymentEligible).toBe(true);
    expect(paper.strategyId).toBe("strat_reviewed");
    expect(paper.strategyVersion).toBe("1.0.0");
    expect(paper.sourceHash).toBe(sourceHash);
    expect(paper.artifactHash).toBe(artifactHash);
    expect(paper.config.entryM5ChangePct).toBe("3");
    expect(paper.binding.mode).toBe("VALIDATED");
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
    expect(stored.activeStrategy).toMatchObject({
      strategyId: "strat_reviewed",
      sourceHash,
      artifactHash,
      mode: "VALIDATED",
      deploymentEligible: true,
    });
    expect(stored.config).not.toHaveProperty("sourceHash");
    const reloaded = slotFromEngineControl({ config: stored.config, activeStrategy: stored.activeStrategy });
    expect(reloaded.strategyVersion).toBe("1.0.0");
    expect(reloaded.binding.mode).toBe("VALIDATED");
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

  it("labels caller-built evidence without a server binding as LEGACY_UNVERIFIED", () => {
    const paper = slot();
    const result = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence(),
      config: config("3"),
    });
    expect(result.appliedToPaperEngine).toBe(true);
    expect(result.deploymentEligible).toBe(false);
    expect(paper.binding.mode).toBe("LEGACY_UNVERIFIED");
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
        binding: validatedBinding(),
      });
      expect(result.appliedToPaperEngine).toBe(false);
      expect(paper).toEqual(before);
    }
  });

  it("rejects a source or artifact hash that no longer matches the review", () => {
    const paper = slot();
    const changedSource = "c".repeat(64);
    const stale = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ sourceHash: changedSource }),
      config: config("3"),
      binding: validatedBinding(),
    });
    expect(stale.appliedToPaperEngine).toBe(false);
    const unbound = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ artifactSourceHash: changedSource }),
      config: config("3"),
      binding: validatedBinding(),
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
      binding: validatedBinding(),
    });
    expect(nullReturn.appliedToPaperEngine).toBe(false);
    expect(nullReturn.deploymentEligible).toBe(false);
    const unavailable = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: evidence({ statisticsRecorded: false }),
      config: config("3"),
      binding: validatedBinding(),
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
      binding: validatedBinding(),
    });
    expect(missing.appliedToPaperEngine).toBe(false);
    expect(missing.deploymentEligible).toBe(false);
    expect(paper).toEqual(before);
    expect(
      promotionBodySchema.safeParse({
        authorised: true,
        caller: "ORACLE",
        reportId: "rpt",
        artifactId: "art",
      }).success,
    ).toBe(false);
    expect(promotionBodySchema.safeParse({ authorised: false, reportId: "rpt", artifactId: "art" }).success).toBe(
      false,
    );
  });

  it("does not add a real-money order path", () => {
    const source = readFileSync(new URL("./promotion.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/submitOrder|placeOrder|api\.binance|jup\.ag\/swap|realMoney/);
    expect(autonomyPolicySchema.safeParse({ ...DEFAULT_AUTONOMY, realMoneyExecutionEnabled: true }).success).toBe(
      false,
    );
  });

  it("resolves promotion evidence from a persisted experiment report (D13)", () => {
    const cfg = config("3");
    const report = completeReport(cfg);
    const resolved = evidenceFromExperimentReport(report, {
      artifact: { artifactHash, sourceHash },
      approved: true,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.evidence.strategyId).toBe("strat_reviewed");
    expect(resolved.evidence.sourceHash).toBe(sourceHash);
    expect(resolved.evidence.artifactHash).toBe(artifactHash);
    expect(resolved.evidence.artifactHash).not.toBe(report.contentHash);
    expect(resolved.evidence.approvalStatus).toBe("APPROVED");
    expect(resolved.evidence.forwardPaperValidated).toBe(true);

    const paper = slot();
    const result = promoteToPaperEngine(paper, {
      operatorId: "operator@odin.local",
      authorised: true,
      caller: "OPERATOR",
      evidence: resolved.evidence,
      config: cfg,
      binding: validatedBinding({ configHash: configHashOf(cfg) }),
    });
    expect(result.appliedToPaperEngine).toBe(true);
    expect(paper.strategyId).toBe("strat_reviewed");
    expect(paper.artifactHash).toBe(artifactHash);
  });

  it("requires reportId and artifactId on the promotion body schema without client evidence", () => {
    const parsed = promotionBodySchema.safeParse({
      authorised: true,
      reportId: "rpt_promote",
      artifactId: "art_promote",
      config: config("3"),
    });
    expect(parsed.success).toBe(true);
    expect(promotionBodySchema.safeParse({ authorised: true, config: config("3") }).success).toBe(false);
    expect(
      promotionBodySchema.safeParse({ authorised: true, reportId: "rpt_promote", config: config("3") }).success,
    ).toBe(false);
    expect(
      promotionBodySchema.safeParse({
        authorised: true,
        reportId: "rpt_promote",
        artifactId: "art_promote",
        evidence: evidence(),
        config: config("3"),
      }).success,
    ).toBe(false);
  });
});
