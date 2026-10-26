import { z } from "zod";
import { ASSET_CLASSES } from "./instruments.js";

/** Strategy evolution lifecycle. Every transition must be audited. */
export const STRATEGY_LIFECYCLE = [
  "DRAFT",
  "CODE_GENERATED",
  "TESTING",
  "CHALLENGED",
  "VALIDATED",
  "PAPER_CANDIDATE",
  "PAPER_ACTIVE",
  "REVIEW_REQUIRED",
  "APPROVED_FOR_DEPLOYMENT",
  "REJECTED",
  "RETIRED",
  "QUARANTINED",
] as const;
export type StrategyLifecycle = (typeof STRATEGY_LIFECYCLE)[number];

export const LIFECYCLE_TRANSITIONS: Record<StrategyLifecycle, StrategyLifecycle[]> = {
  DRAFT: ["CODE_GENERATED", "REJECTED", "RETIRED"],
  CODE_GENERATED: ["TESTING", "REJECTED", "QUARANTINED"],
  TESTING: ["CHALLENGED", "REJECTED", "QUARANTINED"],
  CHALLENGED: ["VALIDATED", "REJECTED", "TESTING", "QUARANTINED"],
  VALIDATED: ["PAPER_CANDIDATE", "REJECTED", "RETIRED"],
  PAPER_CANDIDATE: ["PAPER_ACTIVE", "REJECTED", "REVIEW_REQUIRED"],
  PAPER_ACTIVE: ["REVIEW_REQUIRED", "QUARANTINED", "RETIRED"],
  REVIEW_REQUIRED: ["APPROVED_FOR_DEPLOYMENT", "PAPER_ACTIVE", "REJECTED", "RETIRED", "QUARANTINED"],
  APPROVED_FOR_DEPLOYMENT: ["RETIRED", "QUARANTINED", "REVIEW_REQUIRED"],
  REJECTED: ["DRAFT"],
  RETIRED: [],
  QUARANTINED: ["REVIEW_REQUIRED", "RETIRED", "REJECTED"],
};

export function canTransition(from: StrategyLifecycle, to: StrategyLifecycle): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export const hypothesisSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(3).max(160),
    market: z.enum(ASSET_CLASSES),
    instrumentIds: z.array(z.string().min(1)).min(1).max(32),
    conditions: z.string().min(8).max(2000),
    claimedAdvantage: z.string().min(8).max(1000),
    entryRules: z.string().min(8).max(2000),
    exitRules: z.string().min(8).max(2000),
    riskRules: z.string().min(8).max(2000),
    rationale: z.string().min(8).max(4000),
    successCriteria: z.string().min(8).max(2000),
    failureModes: z.string().min(8).max(2000),
    status: z.enum(["OPEN", "FORGING", "TESTING", "CHALLENGED", "CLOSED"]).default("OPEN"),
  })
  .strict();

export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const MODEL_TIERS = ["FAST_OBSERVERS", "DEEP_RESEARCHERS", "ENGINEERING_AGENTS"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const autonomyPolicySchema = z
  .object({
    level: z.number().int().min(0).max(4),
    /** Level 4 requires an explicitly approved execution adapter. None exist for real money. */
    realMoneyExecutionEnabled: z.literal(false),
    allowUnreviewedCodeDeploy: z.literal(false),
    allowRiskLimitMutation: z.boolean().default(false),
    maxResearchIterations: z.number().int().min(1).max(100).default(8),
    maxResearchBudgetUsd: z.string().regex(/^\d+(\.\d{1,4})?$/).default("5"),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.level > 2 && value.level < 4) {
      // Level 3 is research-autonomous but still cannot deploy unreviewed code or mutate risk.
      if (value.allowUnreviewedCodeDeploy) {
        ctx.addIssue({
          code: "custom",
          path: ["allowUnreviewedCodeDeploy"],
          message: "Research autonomy cannot deploy unreviewed code",
        });
      }
    }
    if (value.level === 4 && value.realMoneyExecutionEnabled !== false) {
      ctx.addIssue({
        code: "custom",
        path: ["realMoneyExecutionEnabled"],
        message: "Level 4 real-money adapter is not available",
      });
    }
  });

export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

export const DEFAULT_AUTONOMY: AutonomyPolicy = {
  level: 1,
  realMoneyExecutionEnabled: false,
  allowUnreviewedCodeDeploy: false,
  allowRiskLimitMutation: false,
  maxResearchIterations: 8,
  maxResearchBudgetUsd: "5",
  timeoutMs: 120_000,
};

export const RESEARCH_PIPELINE_STAGES = [
  "OBSERVE",
  "HYPOTHESISE",
  "FORGE",
  "TEST",
  "CHALLENGE",
  "VALIDATE",
  "PAPER",
  "REVIEW",
] as const;
export type ResearchPipelineStage = (typeof RESEARCH_PIPELINE_STAGES)[number];

export const tradeMemoryPhaseSchema = z.enum(["BEFORE", "DURING", "AFTER"]);
export type TradeMemoryPhase = z.infer<typeof tradeMemoryPhaseSchema>;

export const tradeMemoryRecordSchema = z
  .object({
    tradeId: z.string().min(1),
    pairAddress: z.string().min(1),
    phase: tradeMemoryPhaseSchema,
    capturedAt: z.string().datetime(),
    context: z.record(z.string(), z.unknown()),
    /** When true, record must not influence historical entry decision reconstruction. */
    postExit: z.boolean(),
  })
  .strict();

export type TradeMemoryRecord = z.infer<typeof tradeMemoryRecordSchema>;
