/**
 * Review and promotion are different operations.
 * reviewPromotion and recordStrategyReview never write the paper slot.
 * promoteToPaperEngine is the only write, and only for an explicit operator action.
 */
import { parseStrategyConfig, strategyConfigSchema, type StrategyConfig } from "@odin/shared";
import { z } from "zod";
import { classifyResearchOutcomes } from "./outcomes.js";
import type { ExperimentReport } from "./validate.js";
import { verifyExperimentReport } from "./validate.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

export type PromotionCaller = "OPERATOR" | "ORACLE" | "FORGE" | "MODEL";

export type PromotionEvidence = {
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  artifactSourceHash: string;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
  reviewed: boolean;
  pipelineFinished: boolean;
  experimentExecuted: boolean;
  returnPct: string | null;
  sampleSize: number;
  minSampleSize: number;
  statisticsRecorded: boolean;
  untouchedTestReturnPct: string | null;
  untouchedSampleSize: number;
  tunedOnEvaluationSample: boolean;
  forwardPaperValidated: boolean;
};

export type PromotionAudit = {
  operatorId: string;
  at: string;
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  previousStrategyId: string;
  previousStrategyVersion: string;
  previousSourceHash: string;
  previousArtifactHash: string;
};

export type PaperStrategySlot = {
  id: "primary";
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  config: StrategyConfig;
  audits: PromotionAudit[];
};

export type PromotionResult = {
  appliedToPaperEngine: boolean;
  deploymentEligible: boolean;
  reason: string;
  audit?: PromotionAudit;
};

const promotionAuditSchema = z
  .object({
    operatorId: z.string().min(1),
    at: z.string().min(1),
    strategyId: z.string().min(1),
    strategyVersion: z.string().min(1),
    sourceHash: hashSchema,
    artifactHash: hashSchema,
    previousStrategyId: z.string().min(1),
    previousStrategyVersion: z.string().min(1),
    previousSourceHash: hashSchema,
    previousArtifactHash: hashSchema,
  })
  .strict();

const activeStrategySchema = z
  .object({
    strategyId: z.string().min(1),
    strategyVersion: z.string().min(1),
    sourceHash: hashSchema,
    artifactHash: hashSchema,
    audits: z.array(promotionAuditSchema),
  })
  .strict();

const evidenceSchema = z
  .object({
    strategyId: z.string().min(1),
    strategyVersion: z.string().min(1),
    sourceHash: hashSchema,
    artifactHash: hashSchema,
    artifactSourceHash: hashSchema,
    approvalStatus: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    reviewed: z.boolean(),
    pipelineFinished: z.boolean(),
    experimentExecuted: z.boolean(),
    returnPct: z.string().nullable(),
    sampleSize: z.number().int(),
    minSampleSize: z.number().int(),
    statisticsRecorded: z.boolean(),
    untouchedTestReturnPct: z.string().nullable(),
    untouchedSampleSize: z.number().int(),
    tunedOnEvaluationSample: z.boolean(),
    forwardPaperValidated: z.boolean(),
  })
  .strict();

export const promotionBodySchema = z
  .object({
    authorised: z.literal(true),
    /** Client evidence is accepted only when reportId is absent (legacy/bootstrap). */
    evidence: evidenceSchema.optional(),
    config: strategyConfigSchema,
    /** When set, evidence must be resolved from the persisted ExperimentReport. */
    reportId: z.string().min(1).optional(),
    /** Optional persisted artifact binding (hash or id) verified against the report. */
    artifactId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.reportId && !value.evidence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Promotion requires evidence or a persisted reportId",
        path: ["evidence"],
      });
    }
  });

/**
 * Build promotion evidence from a persisted, verified ExperimentReport.
 * Client-supplied evidence booleans/hashes are ignored when this path is used.
 */
export function evidenceFromExperimentReport(
  report: ExperimentReport,
  options?: { artifactHash?: string | null },
): { ok: true; evidence: PromotionEvidence } | { ok: false; reason: string } {
  if (!verifyExperimentReport(report)) {
    return { ok: false, reason: "Persisted experiment report failed signature/content verification" };
  }
  const sourceRaw = report.reproducibility.codeHash.trim().toLowerCase();
  if (!hashSchema.safeParse(sourceRaw).success) {
    return { ok: false, reason: "Persisted report does not carry a valid source hash" };
  }
  // Bind artifact to the immutable report content hash when no separate artifact hash is supplied.
  const artifactCandidate = (options?.artifactHash ?? report.contentHash).trim().toLowerCase();
  if (!hashSchema.safeParse(artifactCandidate).success) {
    return { ok: false, reason: "Persisted report/artifact hash is not a valid SHA-256 digest" };
  }
  const outcomes = report.outcomes ?? {};
  const met = (key: string) => outcomes[key]?.met === true;
  const sampleSize = report.results.sampleSize;
  const minSampleSize = Math.max(1, sampleSize > 0 && met("STATISTICALLY_EVALUATED") ? Math.min(sampleSize, 30) : 30);
  const oosMet = met("OUT_OF_SAMPLE_VALIDATED");
  const evidence: PromotionEvidence = {
    strategyId: report.strategyModuleId,
    strategyVersion: report.strategyVersion,
    sourceHash: sourceRaw,
    artifactHash: artifactCandidate,
    artifactSourceHash: sourceRaw,
    approvalStatus: report.approval.status,
    reviewed: report.approval.status === "APPROVED" || report.approval.status === "REJECTED",
    pipelineFinished: met("PIPELINE_COMPLETED"),
    experimentExecuted: met("EXPERIMENT_EXECUTED"),
    returnPct: report.results.returnPct,
    sampleSize,
    minSampleSize,
    statisticsRecorded: met("STATISTICALLY_EVALUATED"),
    untouchedTestReturnPct: oosMet ? report.results.returnPct : null,
    untouchedSampleSize: oosMet ? sampleSize : 0,
    tunedOnEvaluationSample: false,
    forwardPaperValidated: met("FORWARD_PAPER_VALIDATED"),
  };
  return { ok: true, evidence };
}

const BOOTSTRAP_IDENTITY = {
  strategyId: "pulse-bootstrap",
  strategyVersion: "0.0.0",
  sourceHash: "0".repeat(64),
  artifactHash: "1".repeat(64),
};

export function createPaperSlot(input: {
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  config: StrategyConfig;
  audits?: PromotionAudit[];
}): PaperStrategySlot {
  return {
    id: "primary",
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    sourceHash: input.sourceHash,
    artifactHash: input.artifactHash,
    config: input.config,
    audits: input.audits?.map((audit) => ({ ...audit })) ?? [],
  };
}

export function slotFromEngineControl(engine: { config: unknown; activeStrategy?: unknown }): PaperStrategySlot {
  const config = parseStrategyConfig(engine.config);
  const parsed = activeStrategySchema.safeParse(engine.activeStrategy);
  if (!parsed.success) return createPaperSlot({ ...BOOTSTRAP_IDENTITY, config });
  return createPaperSlot({
    strategyId: parsed.data.strategyId,
    strategyVersion: parsed.data.strategyVersion,
    sourceHash: parsed.data.sourceHash,
    artifactHash: parsed.data.artifactHash,
    config,
    audits: parsed.data.audits,
  });
}

export function engineControlDataFromSlot(slot: PaperStrategySlot): {
  id: "primary";
  config: StrategyConfig;
  activeStrategy: {
    strategyId: string;
    strategyVersion: string;
    sourceHash: string;
    artifactHash: string;
    audits: PromotionAudit[];
  };
} {
  return {
    id: slot.id,
    config: slot.config,
    activeStrategy: {
      strategyId: slot.strategyId,
      strategyVersion: slot.strategyVersion,
      sourceHash: slot.sourceHash,
      artifactHash: slot.artifactHash,
      audits: slot.audits.map((audit) => ({ ...audit })),
    },
  };
}

export function recordStrategyReview(evidence: PromotionEvidence): {
  appliedToPaperEngine: false;
  accepted: boolean;
  reason: string;
} {
  const accepted = evidence.reviewed && evidence.approvalStatus === "APPROVED";
  return {
    appliedToPaperEngine: false,
    accepted,
    reason: accepted
      ? "Review is recorded. The approved paper strategy is unchanged."
      : "Unreviewed research output stays out of the approved paper engine",
  };
}

export function reviewPromotion(
  input: {
    deploymentEligible: boolean;
    approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
    reviewed: boolean;
  },
  _slot?: PaperStrategySlot,
): { appliedToPaperEngine: false; accepted: boolean; reason: string } {
  void _slot;
  if (!input.reviewed || input.approvalStatus !== "APPROVED" || !input.deploymentEligible) {
    return {
      appliedToPaperEngine: false,
      accepted: false,
      reason: "Unreviewed research output stays out of the approved paper engine",
    };
  }
  return {
    appliedToPaperEngine: false,
    accepted: true,
    reason: "Promotion is recorded for an operator. The approved paper strategy is unchanged.",
  };
}

export function promoteToPaperEngine(
  slot: PaperStrategySlot,
  request: {
    operatorId: string;
    authorised: boolean;
    caller: PromotionCaller;
    evidence: PromotionEvidence;
    config: StrategyConfig;
    at?: string;
  },
): PromotionResult {
  const refuse = (reason: string): PromotionResult => ({
    appliedToPaperEngine: false,
    deploymentEligible: false,
    reason,
  });
  if (request.caller !== "OPERATOR") {
    return refuse("Only an explicit operator action can write the paper engine");
  }
  if (request.authorised !== true || request.operatorId.trim() === "") {
    return refuse("Promotion requires an explicit operator identity and authorisation");
  }
  const evidence = request.evidence;
  if (!evidence.reviewed || evidence.approvalStatus !== "APPROVED") {
    return refuse("Unreviewed research output stays out of the approved paper engine");
  }
  if (
    !hashSchema.safeParse(evidence.sourceHash).success ||
    !hashSchema.safeParse(evidence.artifactHash).success ||
    evidence.artifactSourceHash !== evidence.sourceHash
  ) {
    return refuse("Compiled artifact does not match the reviewed source");
  }
  const parsedConfig = strategyConfigSchema.safeParse(request.config);
  if (!parsedConfig.success) return refuse("Strategy config is not a paper strategy");
  const outcomes = classifyResearchOutcomes({
    pipelineFinished: evidence.pipelineFinished,
    experimentExecuted: evidence.experimentExecuted,
    returnPct: evidence.returnPct,
    sampleSize: evidence.sampleSize,
    minSampleSize: evidence.minSampleSize,
    statisticsRecorded: evidence.statisticsRecorded,
    untouchedTestReturnPct: evidence.untouchedTestReturnPct,
    untouchedSampleSize: evidence.untouchedSampleSize,
    tunedOnEvaluationSample: evidence.tunedOnEvaluationSample,
    forwardPaperValidated: evidence.forwardPaperValidated,
    promotionAuthorised: true,
  });
  if (!outcomes.DEPLOYMENT_ELIGIBLE.met) {
    return refuse(outcomes.DEPLOYMENT_ELIGIBLE.detail);
  }
  const audit: PromotionAudit = {
    operatorId: request.operatorId,
    at: request.at ?? new Date().toISOString(),
    strategyId: evidence.strategyId,
    strategyVersion: evidence.strategyVersion,
    sourceHash: evidence.sourceHash,
    artifactHash: evidence.artifactHash,
    previousStrategyId: slot.strategyId,
    previousStrategyVersion: slot.strategyVersion,
    previousSourceHash: slot.sourceHash,
    previousArtifactHash: slot.artifactHash,
  };
  slot.strategyId = evidence.strategyId;
  slot.strategyVersion = evidence.strategyVersion;
  slot.sourceHash = evidence.sourceHash;
  slot.artifactHash = evidence.artifactHash;
  slot.config = parsedConfig.data;
  slot.audits.push(audit);
  return {
    appliedToPaperEngine: true,
    deploymentEligible: true,
    reason: "Operator promotion wrote the primary paper strategy slot",
    audit,
  };
}
