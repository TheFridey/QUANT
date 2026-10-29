/**
 * Review and promotion are different operations.
 * reviewPromotion and recordStrategyReview never write the paper slot.
 * promoteToPaperEngine (validated) and applyUnvalidatedPaperExperiment (labelled, paper-only)
 * are the only slot writes, and only for an explicit operator action.
 */
import { builtinArtifactIdentity, resolveStrategyBinding } from "@odin/agent-core";
import {
  configHashOf,
  parseStrategyConfig,
  strategyConfigSchema,
  type StrategyConfig,
} from "@odin/shared";
import { z } from "zod";
import { classifyResearchOutcomes, type ResearchOutcomeMap } from "./outcomes.js";
import { validateLineageForPromotion } from "./lineage.js";
import {
  PROMOTION_MIN_SAMPLE_FLOOR,
  buildPersistedLineage,
  missingProvenance,
  partitionOf,
  type ReportEvaluation,
} from "./provenance.js";
import type { ExperimentReport } from "./validate.js";
import { experimentReportSchema, verifyExperimentReport } from "./validate.js";

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
  /** null = unknown tuning/selection history. */
  tunedOnEvaluationSample: boolean | null;
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

export type SlotMode = "VALIDATED" | "UNVALIDATED_PAPER_EXPERIMENT" | "LEGACY_UNVERIFIED" | "BOOTSTRAP";
export type SlotValidationStatus = "VALIDATED" | "UNVALIDATED_EXPERIMENT" | "LEGACY_INCOMPLETE";

/** Persisted label + binding of what occupies the paper slot. liveEligible is never true. */
export type SlotBinding = {
  mode: SlotMode;
  validationStatus: SlotValidationStatus;
  provenance: "COMPLETE" | "INCOMPLETE";
  moduleRef: string | null;
  moduleVersion: string | null;
  configHash: string;
  promotionId: string | null;
  reportId: string | null;
  approvalId: string | null;
  artifactId: string | null;
  deploymentEligible: boolean;
  liveEligible: false;
};

export type PaperStrategySlot = {
  id: "primary";
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  config: StrategyConfig;
  audits: PromotionAudit[];
  binding: SlotBinding;
};

export type PromotionResult = {
  appliedToPaperEngine: boolean;
  deploymentEligible: boolean;
  liveEligible: false;
  reason: string;
  audit?: PromotionAudit;
};

export type ValidationCheck = { name: string; passed: boolean; detail: string };
export type PromotionValidation = {
  status: "VALIDATED" | "UNVALIDATED_EXPERIMENT" | "REJECTED";
  checks: ValidationCheck[];
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
    mode: z.enum(["VALIDATED", "UNVALIDATED_PAPER_EXPERIMENT", "LEGACY_UNVERIFIED"]).optional(),
    validationStatus: z.enum(["VALIDATED", "UNVALIDATED_EXPERIMENT", "LEGACY_INCOMPLETE"]).optional(),
    provenance: z.enum(["COMPLETE", "INCOMPLETE"]).optional(),
    moduleRef: z.string().nullable().optional(),
    moduleVersion: z.string().nullable().optional(),
    configHash: hashSchema.optional(),
    promotionId: z.string().nullable().optional(),
    reportId: z.string().nullable().optional(),
    approvalId: z.string().nullable().optional(),
    artifactId: z.string().nullable().optional(),
    deploymentEligible: z.boolean().optional(),
    liveEligible: z.literal(false).optional(),
  })
  .strict();

/** Validated promotion: evidence is resolved server-side from persisted rows only. */
export const promotionBodySchema = z
  .object({
    authorised: z.literal(true),
    reportId: z.string().min(1),
    artifactId: z.string().min(1),
    /** Optional explicit approval; otherwise the latest APPROVED review bound to report+artifact+config. */
    approvalId: z.string().min(1).optional(),
    /** Optional; when present its canonical hash must equal the report's evaluated config hash. */
    config: strategyConfigSchema.optional(),
  })
  .strict();

/** Labelled paper-only experiment. Never deployment- or live-eligible; reuses no approval. */
export const unvalidatedExperimentBodySchema = z
  .object({
    authorised: z.literal(true),
    mode: z.literal("UNVALIDATED_PAPER_EXPERIMENT"),
    artifactId: z.string().min(1),
    config: strategyConfigSchema,
    label: z.string().trim().min(1).max(120),
    rationale: z.string().trim().min(1).max(2000),
    hypothesisId: z.string().min(1).optional(),
  })
  .strict();

export const reportReviewBodySchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    artifactId: z.string().min(1),
    config: strategyConfigSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const rollbackBodySchema = z
  .object({
    authorised: z.literal(true),
    promotionId: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export type PersistedArtifact = {
  id: string;
  kind: string;
  moduleRef: string | null;
  moduleVersion: string;
  sourceHash: string;
  artifactHash: string;
  runtimeLoadable: boolean;
};

export type PersistedApproval = {
  id: string;
  reportId: string;
  reportContentHash: string;
  artifactId: string;
  artifactHash: string;
  sourceHash: string;
  configHash: string;
  decision: string;
  reviewer: string;
  at: string;
};

export type PersistedReportRow = {
  id: string;
  contentHash: string;
  signature: string;
  createdAt: string;
  payload: unknown;
};

/** Re-derive artifact identity from what the runtime would load; a hash-shaped id proves nothing. */
export function verifyArtifactIdentity(artifact: PersistedArtifact): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  if (artifact.kind === "BUILTIN_MODULE") {
    const identity = artifact.moduleRef ? builtinArtifactIdentity(artifact.moduleRef) : null;
    const matches =
      identity !== null &&
      identity.artifactHash === artifact.artifactHash &&
      identity.sourceHash === artifact.sourceHash &&
      identity.moduleVersion === artifact.moduleVersion;
    checks.push({
      name: "ARTIFACT_IDENTITY_VERIFIED",
      passed: matches,
      detail: matches
        ? `Builtin ${artifact.moduleRef}@${artifact.moduleVersion} re-derived to ${artifact.artifactHash}`
        : "Persisted artifact hash does not re-derive from the builtin module the runtime would load",
    });
  } else {
    checks.push({
      name: "ARTIFACT_IDENTITY_VERIFIED",
      passed: hashSchema.safeParse(artifact.artifactHash).success,
      detail: "Compiled sandbox artifact hash was recorded server-side at forge time",
    });
  }
  const binding = resolveStrategyBinding({
    moduleRef: artifact.moduleRef,
    artifactHash: artifact.artifactHash,
    instrumentIds: [],
  });
  const loadable = binding.ok && artifact.runtimeLoadable;
  checks.push({
    name: "RUNTIME_LOADABLE",
    passed: loadable,
    detail: loadable
      ? `Runtime resolves moduleRef=${artifact.moduleRef} to this exact executable`
      : binding.ok
        ? "Artifact is not marked runtime-loadable"
        : `${binding.code}: ${binding.message}`,
  });
  return checks;
}

function parseReportPayload(row: PersistedReportRow): ExperimentReport | null {
  const parsed = experimentReportSchema.safeParse(row.payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Build promotion evidence from a persisted, verified ExperimentReport and a persisted artifact.
 * Outcome labels stored on the report are not trusted: everything is re-derived from the
 * recorded partitions, tuning history, and forward-paper records. Unknown stays unknown.
 */
export function evidenceFromExperimentReport(
  report: ExperimentReport,
  options: { artifact: Pick<PersistedArtifact, "artifactHash" | "sourceHash">; approved?: boolean },
):
  | { ok: true; evidence: PromotionEvidence; outcomes: ResearchOutcomeMap }
  | { ok: false; reason: string } {
  if (!verifyExperimentReport(report)) {
    return { ok: false, reason: "Persisted experiment report failed signature/content verification" };
  }
  const evaluation = report.evaluation;
  if (!evaluation) {
    return { ok: false, reason: "Report has no recorded evaluation provenance (LEGACY_INCOMPLETE)" };
  }
  const sourceHash = report.reproducibility.codeHash.trim().toLowerCase();
  const artifactHash = options.artifact.artifactHash.trim().toLowerCase();
  if (!hashSchema.safeParse(sourceHash).success || !hashSchema.safeParse(artifactHash).success) {
    return { ok: false, reason: "Report source or artifact hash is not a valid SHA-256 digest" };
  }
  if (artifactHash === report.contentHash) {
    return { ok: false, reason: "Report hash cannot stand in for the executable hash" };
  }
  const full = partitionOf(evaluation, "FULL");
  const test = partitionOf(evaluation, "TEST");
  const minSampleSize = Math.max(evaluation.minSampleSize, PROMOTION_MIN_SAMPLE_FLOOR);
  const sampleSize = full?.measured ? (full.sampleSize ?? 0) : 0;
  const returnPct = full?.measured ? full.returnPct : null;
  const forward = evaluation.forwardPaper;
  const approved = options.approved === true;
  const evidence: PromotionEvidence = {
    strategyId: report.strategyModuleId,
    strategyVersion: report.strategyVersion,
    sourceHash,
    artifactHash,
    artifactSourceHash: options.artifact.sourceHash.trim().toLowerCase(),
    approvalStatus: approved ? "APPROVED" : "PENDING",
    reviewed: approved,
    pipelineFinished: true,
    experimentExecuted: Boolean(full?.measured),
    returnPct,
    sampleSize,
    minSampleSize,
    statisticsRecorded: Boolean(full?.measured && full.returnPct !== null && full.maxDrawdownPct !== null),
    untouchedTestReturnPct: test?.measured ? test.returnPct : null,
    untouchedSampleSize: test?.measured ? (test.sampleSize ?? 0) : 0,
    tunedOnEvaluationSample: evaluation.tuning.tunedOnEvaluationSample,
    forwardPaperValidated:
      forward.status === "RECORDED" &&
      forward.resultIds.length > 0 &&
      forward.returnPct !== null &&
      forward.closedTradeCount >= minSampleSize,
  };
  return { ok: true, evidence, outcomes: outcomesForEvidence(evidence, true) };
}

function outcomesForEvidence(evidence: PromotionEvidence, promotionAuthorised: boolean): ResearchOutcomeMap {
  return classifyResearchOutcomes({
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
    promotionAuthorised,
  });
}

/**
 * Mandatory validation for a normal paper promotion. Every check runs against persisted rows;
 * the status is VALIDATED only when every check actually passed.
 */
export function validatePromotion(input: {
  report: PersistedReportRow | null;
  artifact: PersistedArtifact | null;
  approval: PersistedApproval | null;
  approvalsForReport: PersistedApproval[];
  hypothesis: { id: string; persisted: boolean; at: string | null } | null;
  requestedConfig?: StrategyConfig | null;
}): {
  validation: PromotionValidation;
  evidence: PromotionEvidence | null;
  config: StrategyConfig | null;
  configHash: string | null;
  report: ExperimentReport | null;
  provenance: "COMPLETE" | "INCOMPLETE";
} {
  const checks: ValidationCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const row = input.report;
  const report = row ? parseReportPayload(row) : null;
  add("REPORT_PERSISTED", Boolean(row), row ? `ExperimentReport ${row.id}` : "No persisted ExperimentReport");
  const signatureOk = Boolean(
    row && report && verifyExperimentReport(report) && report.contentHash === row.contentHash && report.reportId === row.id,
  );
  add(
    "REPORT_SIGNATURE_VALID",
    signatureOk,
    signatureOk ? `contentHash ${row!.contentHash}` : "Report payload does not verify against its persisted hash/signature",
  );
  const evaluation: ReportEvaluation | null = signatureOk ? (report!.evaluation ?? null) : null;
  const recomputedMissing = evaluation ? missingProvenance(evaluation, report!.executable) : ["EVALUATION_ABSENT"];
  const provenanceComplete = Boolean(evaluation && evaluation.provenance === "COMPLETE" && recomputedMissing.length === 0);
  add(
    "REPORT_PROVENANCE_COMPLETE",
    provenanceComplete,
    provenanceComplete
      ? `Protocol ${evaluation!.protocol.id}@${evaluation!.protocol.version}`
      : `Provenance incomplete: ${recomputedMissing.join(", ") || "report marked INCOMPLETE"}`,
  );

  const artifact = input.artifact;
  add("ARTIFACT_PERSISTED", Boolean(artifact), artifact ? `StrategyArtifact ${artifact.id}` : "No persisted artifact");
  if (artifact) checks.push(...verifyArtifactIdentity(artifact));
  else {
    add("ARTIFACT_IDENTITY_VERIFIED", false, "Artifact unavailable");
    add("RUNTIME_LOADABLE", false, "Artifact unavailable");
  }
  const executable = signatureOk ? report!.executable : undefined;
  const artifactMatches = Boolean(
    artifact &&
      executable &&
      executable.artifactHash === artifact.artifactHash &&
      executable.sourceHash === artifact.sourceHash &&
      report!.reproducibility.codeHash.toLowerCase() === artifact.sourceHash &&
      executable.artifactHash !== row!.contentHash,
  );
  add(
    "ARTIFACT_MATCHES_REPORT",
    artifactMatches,
    artifactMatches
      ? "Report evaluated exactly this executable and source"
      : "Report did not evaluate this persisted executable/source",
  );

  let config: StrategyConfig | null = null;
  let configHash: string | null = null;
  if (evaluation) {
    const evaluated = strategyConfigSchema.safeParse(evaluation.config);
    const effective = input.requestedConfig ?? (evaluated.success ? evaluated.data : null);
    if (effective) {
      config = parseStrategyConfig(effective);
      configHash = configHashOf(config);
    }
  }
  const configMatches = Boolean(
    configHash &&
      evaluation &&
      configHash === evaluation.configHash &&
      configHash === report!.reproducibility.configHash.toLowerCase(),
  );
  add(
    "CONFIG_MATCHES_REPORT",
    configMatches,
    configMatches
      ? `configHash ${configHash}`
      : `Config hash ${configHash ?? "unavailable"} differs from the report's evaluated config ${evaluation?.configHash ?? "unknown"}`,
  );

  const approval = input.approval;
  const approvalBound = Boolean(
    approval &&
      row &&
      artifact &&
      approval.decision === "APPROVED" &&
      approval.reportId === row.id &&
      approval.reportContentHash === row.contentHash &&
      approval.artifactId === artifact.id &&
      approval.artifactHash === artifact.artifactHash &&
      approval.sourceHash === artifact.sourceHash &&
      approval.configHash === configHash,
  );
  add(
    "APPROVAL_BOUND",
    approvalBound,
    approvalBound
      ? `Approval ${approval!.id} by ${approval!.reviewer}`
      : approval
        ? `Approval ${approval.id} is not an APPROVED review of this report/artifact/config`
        : "No APPROVED review for this report/artifact/config",
  );

  let lineageOk = false;
  let lineageDetail = "Lineage unavailable";
  if (row && report && artifact && input.hypothesis && configHash) {
    const approvals = [...input.approvalsForReport];
    if (approval && !approvals.some((a) => a.id === approval.id)) approvals.push(approval);
    const chain = buildPersistedLineage({
      hypothesis: input.hypothesis,
      report: {
        id: row.id,
        contentHash: row.contentHash,
        createdAt: row.createdAt,
        evaluation: evaluation,
        executable: report.executable ?? null,
        codeHash: report.reproducibility.codeHash.toLowerCase(),
        configHash: report.reproducibility.configHash.toLowerCase(),
      },
      approvals,
    });
    const gate = validateLineageForPromotion({
      chain,
      reportId: row.id,
      sourceHash: artifact.sourceHash,
      artifactHash: artifact.artifactHash,
      configHash,
      approvalId: approval?.id ?? null,
    });
    lineageOk = gate.ok;
    lineageDetail = gate.ok ? "hypothesis → dataset → experiment → report → approval verified" : gate.reason;
  } else if (!input.hypothesis) {
    lineageDetail = "Report hypothesis is not a persisted record";
  }
  add("LINEAGE_COMPLETE", lineageOk, lineageDetail);

  let evidence: PromotionEvidence | null = null;
  if (signatureOk && artifact) {
    const resolved = evidenceFromExperimentReport(report!, { artifact, approved: approvalBound });
    if (resolved.ok) {
      evidence = resolved.evidence;
      add(
        "SCIENTIFIC_GATES",
        resolved.outcomes.DEPLOYMENT_ELIGIBLE.met,
        resolved.outcomes.DEPLOYMENT_ELIGIBLE.met
          ? "Out-of-sample and forward paper evidence recorded"
          : firstUnmet(resolved.outcomes),
      );
    } else {
      add("SCIENTIFIC_GATES", false, resolved.reason);
    }
  } else {
    add("SCIENTIFIC_GATES", false, "Evidence unavailable");
  }

  const passed = checks.every((check) => check.passed);
  return {
    validation: { status: passed ? "VALIDATED" : "REJECTED", checks },
    evidence: passed ? evidence : null,
    config,
    configHash,
    report: signatureOk ? report : null,
    provenance: provenanceComplete ? "COMPLETE" : "INCOMPLETE",
  };
}

function firstUnmet(outcomes: ResearchOutcomeMap): string {
  const order = [
    "EXPERIMENT_EXECUTED",
    "RESULTS_MEASURABLE",
    "STATISTICALLY_EVALUATED",
    "OUT_OF_SAMPLE_VALIDATED",
    "FORWARD_PAPER_VALIDATED",
    "DEPLOYMENT_ELIGIBLE",
  ] as const;
  const miss = order.find((key) => !outcomes[key].met) ?? "DEPLOYMENT_ELIGIBLE";
  return `${miss}: ${outcomes[miss].detail}`;
}

/** Checks for a labelled paper-only experiment: identity and loadability only, no statistical gates. */
export function validateUnvalidatedExperiment(input: {
  artifact: PersistedArtifact | null;
  config: StrategyConfig;
}): { validation: PromotionValidation; config: StrategyConfig; configHash: string } {
  const checks: ValidationCheck[] = [];
  const artifact = input.artifact;
  checks.push({
    name: "ARTIFACT_PERSISTED",
    passed: Boolean(artifact),
    detail: artifact ? `StrategyArtifact ${artifact.id}` : "No persisted artifact",
  });
  if (artifact) checks.push(...verifyArtifactIdentity(artifact));
  const config = parseStrategyConfig(input.config);
  const configHash = configHashOf(config);
  checks.push({ name: "CONFIG_VALID", passed: true, detail: `configHash ${configHash}` });
  checks.push({
    name: "STATISTICAL_VALIDATION",
    passed: true,
    detail: "Not performed: explicitly UNVALIDATED paper experiment (not deployment- or live-eligible)",
  });
  const ok = checks.every((check) => check.passed);
  return { validation: { status: ok ? "UNVALIDATED_EXPERIMENT" : "REJECTED", checks }, config, configHash };
}

const BOOTSTRAP_IDENTITY = {
  strategyId: "pulse-bootstrap",
  strategyVersion: "0.0.0",
  sourceHash: "0".repeat(64),
  artifactHash: "1".repeat(64),
};

function legacyBinding(config: StrategyConfig, mode: "LEGACY_UNVERIFIED" | "BOOTSTRAP"): SlotBinding {
  return {
    mode,
    validationStatus: "LEGACY_INCOMPLETE",
    provenance: "INCOMPLETE",
    moduleRef: null,
    moduleVersion: null,
    configHash: configHashOf(config),
    promotionId: null,
    reportId: null,
    approvalId: null,
    artifactId: null,
    deploymentEligible: false,
    liveEligible: false,
  };
}

export function createPaperSlot(input: {
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  config: StrategyConfig;
  audits?: PromotionAudit[];
  binding?: SlotBinding;
}): PaperStrategySlot {
  return {
    id: "primary",
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    sourceHash: input.sourceHash,
    artifactHash: input.artifactHash,
    config: input.config,
    audits: input.audits?.map((audit) => ({ ...audit })) ?? [],
    binding: input.binding ? { ...input.binding } : legacyBinding(input.config, "LEGACY_UNVERIFIED"),
  };
}

export function slotFromEngineControl(engine: { config: unknown; activeStrategy?: unknown }): PaperStrategySlot {
  const config = parseStrategyConfig(engine.config);
  const parsed = activeStrategySchema.safeParse(engine.activeStrategy);
  if (!parsed.success) {
    return createPaperSlot({ ...BOOTSTRAP_IDENTITY, config, binding: legacyBinding(config, "BOOTSTRAP") });
  }
  const data = parsed.data;
  // Rows written before bindings existed are labelled legacy and never become validated retroactively.
  const bound = data.mode !== undefined && data.mode !== "LEGACY_UNVERIFIED" && data.configHash !== undefined;
  const binding: SlotBinding = bound
    ? {
        mode: data.mode!,
        validationStatus: data.validationStatus ?? "LEGACY_INCOMPLETE",
        provenance: data.provenance ?? "INCOMPLETE",
        moduleRef: data.moduleRef ?? null,
        moduleVersion: data.moduleVersion ?? null,
        configHash: data.configHash!,
        promotionId: data.promotionId ?? null,
        reportId: data.reportId ?? null,
        approvalId: data.approvalId ?? null,
        artifactId: data.artifactId ?? null,
        deploymentEligible: data.deploymentEligible === true && data.mode === "VALIDATED",
        liveEligible: false,
      }
    : legacyBinding(config, "LEGACY_UNVERIFIED");
  return createPaperSlot({
    strategyId: data.strategyId,
    strategyVersion: data.strategyVersion,
    sourceHash: data.sourceHash,
    artifactHash: data.artifactHash,
    config,
    audits: data.audits,
    binding,
  });
}

export type ActiveStrategyRecord = {
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
  audits: PromotionAudit[];
  mode: Exclude<SlotMode, "BOOTSTRAP">;
  validationStatus: SlotValidationStatus;
  provenance: "COMPLETE" | "INCOMPLETE";
  moduleRef: string | null;
  moduleVersion: string | null;
  configHash: string;
  promotionId: string | null;
  reportId: string | null;
  approvalId: string | null;
  artifactId: string | null;
  deploymentEligible: boolean;
  liveEligible: false;
};

export function engineControlDataFromSlot(slot: PaperStrategySlot): {
  id: "primary";
  config: StrategyConfig;
  activeStrategy: ActiveStrategyRecord;
} {
  const { mode, ...binding } = slot.binding;
  return {
    id: slot.id,
    config: slot.config,
    activeStrategy: {
      strategyId: slot.strategyId,
      strategyVersion: slot.strategyVersion,
      sourceHash: slot.sourceHash,
      artifactHash: slot.artifactHash,
      audits: slot.audits.map((audit) => ({ ...audit })),
      ...binding,
      mode: mode === "BOOTSTRAP" ? "LEGACY_UNVERIFIED" : mode,
      configHash: configHashOf(slot.config),
      liveEligible: false,
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

function refuseWrite(reason: string): PromotionResult {
  return { appliedToPaperEngine: false, deploymentEligible: false, liveEligible: false, reason };
}

function checkOperator(request: { operatorId: string; authorised: boolean; caller: PromotionCaller }): string | null {
  if (request.caller !== "OPERATOR") return "Only an explicit operator action can write the paper engine";
  if (request.authorised !== true || request.operatorId.trim() === "") {
    return "Promotion requires an explicit operator identity and authorisation";
  }
  return null;
}

function writeSlot(
  slot: PaperStrategySlot,
  identity: { strategyId: string; strategyVersion: string; sourceHash: string; artifactHash: string },
  config: StrategyConfig,
  binding: SlotBinding,
  operatorId: string,
  at: string | undefined,
): PromotionAudit {
  const audit: PromotionAudit = {
    operatorId,
    at: at ?? new Date().toISOString(),
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    sourceHash: identity.sourceHash,
    artifactHash: identity.artifactHash,
    previousStrategyId: slot.strategyId,
    previousStrategyVersion: slot.strategyVersion,
    previousSourceHash: slot.sourceHash,
    previousArtifactHash: slot.artifactHash,
  };
  slot.strategyId = identity.strategyId;
  slot.strategyVersion = identity.strategyVersion;
  slot.sourceHash = identity.sourceHash;
  slot.artifactHash = identity.artifactHash;
  slot.config = config;
  slot.binding = { ...binding, configHash: configHashOf(config), liveEligible: false };
  slot.audits.push(audit);
  return audit;
}

/**
 * Validated paper promotion. Without a server-resolved binding the slot is labelled
 * LEGACY_UNVERIFIED — gates passing on caller-built evidence never yields VALIDATED.
 */
export function promoteToPaperEngine(
  slot: PaperStrategySlot,
  request: {
    operatorId: string;
    authorised: boolean;
    caller: PromotionCaller;
    evidence: PromotionEvidence;
    config: StrategyConfig;
    binding?: Omit<SlotBinding, "configHash" | "liveEligible" | "deploymentEligible">;
    at?: string;
  },
): PromotionResult {
  const operatorRefusal = checkOperator(request);
  if (operatorRefusal) return refuseWrite(operatorRefusal);
  const evidence = request.evidence;
  if (!evidence.reviewed || evidence.approvalStatus !== "APPROVED") {
    return refuseWrite("Unreviewed research output stays out of the approved paper engine");
  }
  if (
    !hashSchema.safeParse(evidence.sourceHash).success ||
    !hashSchema.safeParse(evidence.artifactHash).success ||
    evidence.artifactSourceHash !== evidence.sourceHash
  ) {
    return refuseWrite("Compiled artifact does not match the reviewed source");
  }
  const parsedConfig = strategyConfigSchema.safeParse(request.config);
  if (!parsedConfig.success) return refuseWrite("Strategy config is not a paper strategy");
  const outcomes = outcomesForEvidence(evidence, true);
  if (!outcomes.DEPLOYMENT_ELIGIBLE.met) {
    return refuseWrite(outcomes.DEPLOYMENT_ELIGIBLE.detail);
  }
  const config = parseStrategyConfig(parsedConfig.data);
  const binding: SlotBinding = request.binding
    ? {
        ...request.binding,
        configHash: configHashOf(config),
        deploymentEligible: request.binding.mode === "VALIDATED",
        liveEligible: false,
      }
    : legacyBinding(config, "LEGACY_UNVERIFIED");
  const audit = writeSlot(slot, evidence, config, binding, request.operatorId, request.at);
  return {
    appliedToPaperEngine: true,
    deploymentEligible: binding.deploymentEligible,
    liveEligible: false,
    reason: "Operator promotion wrote the primary paper strategy slot",
    audit,
  };
}

/** Labelled paper-only experiment write. No statistical gates; never deployment/live eligible. */
export function applyUnvalidatedPaperExperiment(
  slot: PaperStrategySlot,
  request: {
    operatorId: string;
    authorised: boolean;
    caller: PromotionCaller;
    identity: { strategyId: string; strategyVersion: string; sourceHash: string; artifactHash: string };
    config: StrategyConfig;
    binding: { moduleRef: string | null; moduleVersion: string | null; promotionId: string; artifactId: string };
    at?: string;
  },
): PromotionResult {
  const operatorRefusal = checkOperator(request);
  if (operatorRefusal) return refuseWrite(operatorRefusal);
  const config = parseStrategyConfig(request.config);
  const audit = writeSlot(
    slot,
    request.identity,
    config,
    {
      mode: "UNVALIDATED_PAPER_EXPERIMENT",
      validationStatus: "UNVALIDATED_EXPERIMENT",
      provenance: "INCOMPLETE",
      moduleRef: request.binding.moduleRef,
      moduleVersion: request.binding.moduleVersion,
      configHash: configHashOf(config),
      promotionId: request.binding.promotionId,
      reportId: null,
      approvalId: null,
      artifactId: request.binding.artifactId,
      deploymentEligible: false,
      liveEligible: false,
    },
    request.operatorId,
    request.at,
  );
  return {
    appliedToPaperEngine: true,
    deploymentEligible: false,
    liveEligible: false,
    reason: "UNVALIDATED paper experiment applied to the primary paper slot",
    audit,
  };
}
