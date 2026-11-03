import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmRequest, ModelProvider } from "@odin/agent-core";
import type { BacktestObservation } from "@odin/backtest";
import { chronologicalSplits } from "@odin/backtest";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_STRATEGY,
  configHashOf,
  d,
  newId,
  parseStrategyConfig,
  type AutonomyPolicy,
  type Hypothesis,
} from "@odin/shared";
import { toJson, type Prisma, type PrismaClient } from "@odin/shared/db";
import { assertActionAllowed, parseAutonomyPolicy } from "./autonomy.js";
import { MemoryBudgetStore, researchBudgetWindowStart } from "./budget-store.js";
import { runChallengeReview, type ChallengeReport } from "./challenge.js";
import { compileStrategySource } from "./compile-strategy.js";
import { forgeStrategyModule } from "./forge.js";
import { hashEvidence, transitionLifecycle } from "./lifecycle.js";
import { classifyResearchOutcomes } from "./outcomes.js";
import { EVALUATION_PROTOCOLS, finaliseEvaluation, type ReportExecutable } from "./provenance.js";
import { scoreWindow, simulateResearchPath } from "./research-backtest.js";
import {
  APPROVABLE_ACTIONS,
  CLAIMABLE_EXPERIMENT_STATES,
  GATED_STAGE_ACTIONS,
  canTransitionExperiment,
  isGatedStage,
  isTerminalExperimentState,
  type ApprovableAction,
  type GatedStage,
  type ResearchExperimentState,
} from "./research-loop-states.js";
import { ModelRouter, type ModelAssignment, type ModelEndpoint, type UsageRecord } from "./router.js";
import { executeCompiledStrategy } from "./sandbox-runner.js";
import { summariseStatistics } from "./statistics.js";
import { buildExperimentReport } from "./validate.js";

/**
 * ASCEND-08 bounded autonomous research loop.
 *
 * Safety contract (see docs/apex/ASCEND-08.md):
 * - Off unless ResearchLoopControl.enabled is true (default false; a missing row is off) AND the autonomy
 *   level is 2 or 3.
 * - Each tick claims experiments under a lease with a version compare-and-set, advances each at most
 *   one state, and commits the transition only if it still holds that lease at that version.
 * - Forge, backtest and paper-candidate marking consult `assertActionAllowed`; where it requires approval,
 *   an unexpired ResearchApproval row is needed or the experiment moves to BLOCKED_APPROVAL. Denied actions
 *   are never executed. The loop never writes ResearchApproval.
 * - The loop never calls promotion code, never writes EngineControl, StrategyPromotion, PromotionApproval or
 *   any risk configuration, and never marks a report approved. PAPER means a PAPER_CANDIDATE lifecycle
 *   label only; an operator still decides everything after REVIEW.
 */

export const RESEARCH_LOOP_CONTROL_ID = "primary";
/** Serialises experiment creation so the daily and concurrency caps hold across processes. */
export const RESEARCH_LOOP_INTAKE_LOCK = 8_080_801;
export const RESEARCH_LOOP_ACTOR = "RESEARCH_LOOP";

export const RESEARCH_LOOP_LIMIT_BOUNDS = {
  maxExperimentsPerDay: { min: 0, max: 50 },
  maxConcurrentExperiments: { min: 1, max: 10 },
  maxAttemptsPerExperiment: { min: 1, max: 10 },
  /** At least 70 s: a model stage needs up to 60 s plus margin, so a shorter tick could never run one. */
  tickRuntimeMs: { min: 70_000, max: 600_000 },
  /** Also at least 2 × tickRuntimeMs, so a lease cannot expire while its tick is still working. */
  leaseMs: { min: 140_000, max: 3_600_000 },
} as const;

export const researchLoopControlBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    maxExperimentsPerDay: z.number().int().min(0).max(50).optional(),
    maxConcurrentExperiments: z.number().int().min(1).max(10).optional(),
    maxAttemptsPerExperiment: z.number().int().min(1).max(10).optional(),
    tickRuntimeMs: z.number().int().min(70_000).max(600_000).optional(),
    leaseMs: z.number().int().min(140_000).max(3_600_000).optional(),
  })
  .strict();

export const researchApprovalBodySchema = z
  .object({
    action: z.enum(["forge_code", "run_backtest", "promote_paper"]),
    /** The subject the operator reviewed, as shown on the blocked experiment (`approvalRequest.subjectHash`). */
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Approval lifetime; default 24 h, at most 7 days. */
    ttlMinutes: z.number().int().min(1).max(10_080).default(1_440),
    note: z.string().max(1_000).optional(),
  })
  .strict();

export type ResearchLoopControlRow = {
  enabled: boolean;
  maxExperimentsPerDay: number;
  maxConcurrentExperiments: number;
  maxAttemptsPerExperiment: number;
  tickRuntimeMs: number;
  leaseMs: number;
};

/** Defaults used when no control row exists (the loop is then disabled). Mirrors the schema defaults. */
export const DEFAULT_RESEARCH_LOOP_CONTROL: ResearchLoopControlRow = {
  enabled: false,
  maxExperimentsPerDay: 2,
  maxConcurrentExperiments: 2,
  maxAttemptsPerExperiment: 3,
  tickRuntimeMs: 120_000,
  leaseMs: 600_000,
};

/** Router seams. Production passes only `env`; tests inject explicit FIXTURE providers. Mode is always live. */
export type ResearchLoopRouterOptions = {
  env?: NodeJS.ProcessEnv;
  providers?: Map<string, ModelProvider>;
  endpoints?: ModelEndpoint[];
  assignments?: ModelAssignment[];
};

export type ResearchLoopDeps = {
  /** Lease owner identity, unique per worker process (for example `${hostname}:${pid}`). */
  owner: string;
  router?: ResearchLoopRouterOptions;
  /** Defaults to the real forge. Tests may pass a forge with `isolation: "disabled"`. */
  forge?: typeof forgeStrategyModule;
  /** Defaults to the real isolated runner. */
  execute?: typeof executeCompiledStrategy;
  /** Defaults to persisted MarketObservation rows received at or before `now`. */
  loadObservations?: (prisma: PrismaClient, now: Date) => Promise<BacktestObservation[]>;
  /** Wall clock for the per-tick runtime limit. Defaults to Date.now. */
  clock?: () => number;
  /** Test seam: awaited after the claim and before any experiment is advanced. */
  afterClaim?: (claimedIds: string[]) => Promise<void>;
  /** Test seam (fault injection): awaited inside each transition's transaction, just before it commits. */
  beforeCommit?: (experimentId: string, to: string) => Promise<void>;
};

export type ResearchLoopTickResult = {
  status: "DISABLED" | "AUTONOMY_INSUFFICIENT" | "RAN";
  reason: string;
  owner: string;
  created: string[];
  claimed: string[];
  reclaimed: string[];
  advanced: Array<{ id: string; from: string; to: string; reason: string }>;
  held: Array<{ id: string; state: string; reason: string }>;
  attemptsFailed: Array<{ id: string; state: string; reason: string }>;
  leaseLost: string[];
  /** Experiments whose failure could not even be recorded (the lease then lapses at leaseExpiresAt). */
  errors: Array<{ id: string; error: string }>;
  modelCalls: number;
  stoppedEarly: string | null;
};

type ExperimentRow = Prisma.ResearchExperimentGetPayload<object>;
type Tx = Prisma.TransactionClient;
type Context = Record<string, unknown>;

type StageOutcome =
  | {
      kind: "advance";
      to: ResearchExperimentState;
      reason: string;
      evidence: Record<string, unknown>;
      contextPatch?: Context;
      blockedState?: GatedStage | null;
      sideEffects?: (tx: Tx) => Promise<void>;
    }
  | { kind: "attempt_failed"; reason: string; evidence?: Record<string, unknown> }
  | { kind: "hold"; reason: string };

type TickEnv = {
  prisma: PrismaClient;
  deps: ResearchLoopDeps;
  now: Date;
  policy: AutonomyPolicy;
  control: ResearchLoopControlRow;
  deadline: number;
  startedAt: number;
  clock: () => number;
  counters: { modelCalls: number };
};

class LeaseLostError extends Error {
  constructor(id: string) {
    super(`Lease on ${id} was lost before commit`);
    this.name = "LeaseLostError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Control, policy and budget reads
// ---------------------------------------------------------------------------------------------------

export async function readResearchLoopControl(prisma: PrismaClient | Tx): Promise<ResearchLoopControlRow & { present: boolean }> {
  const row = await prisma.researchLoopControl.findUnique({ where: { id: RESEARCH_LOOP_CONTROL_ID } });
  if (!row) return { ...DEFAULT_RESEARCH_LOOP_CONTROL, enabled: false, present: false };
  return {
    present: true,
    enabled: row.enabled === true,
    maxExperimentsPerDay: row.maxExperimentsPerDay,
    maxConcurrentExperiments: row.maxConcurrentExperiments,
    maxAttemptsPerExperiment: row.maxAttemptsPerExperiment,
    tickRuntimeMs: row.tickRuntimeMs,
    leaseMs: row.leaseMs,
  };
}

export async function readAutonomyPolicy(prisma: PrismaClient | Tx): Promise<AutonomyPolicy> {
  const row = await prisma.autonomyControl.findUnique({ where: { id: "primary" } });
  if (!row) return parseAutonomyPolicy(DEFAULT_AUTONOMY);
  return parseAutonomyPolicy({
    level: row.level,
    realMoneyExecutionEnabled: false,
    allowUnreviewedCodeDeploy: false,
    allowRiskLimitMutation: false,
    maxResearchIterations: row.maxResearchIterations,
    maxResearchBudgetUsd: row.maxResearchBudgetUsd.toString(),
    timeoutMs: row.timeoutMs,
  });
}

/** Cumulative research model spend for the UTC day containing `now`, from the durable ModelUsageLog. */
export async function researchSpendToday(prisma: PrismaClient | Tx, now: Date): Promise<{ windowStart: string; spentUsd: string }> {
  const windowStart = researchBudgetWindowStart(now);
  const aggregate = await prisma.modelUsageLog.aggregate({
    _sum: { costUsdEst: true },
    where: { createdAt: { gte: windowStart } },
  });
  return {
    windowStart: windowStart.toISOString(),
    spentUsd: aggregate._sum.costUsdEst ? aggregate._sum.costUsdEst.toFixed(8) : "0.00000000",
  };
}

async function persistModelUsage(prisma: PrismaClient, usage: UsageRecord): Promise<void> {
  await prisma.modelUsageLog.create({
    data: {
      id: newId("mul"),
      agentOrTask: usage.agentOrTask,
      endpointId: usage.endpointId,
      provider: usage.provider,
      model: usage.model,
      tier: usage.tier,
      ok: usage.ok,
      latencyMs: usage.latencyMs,
      promptTokensEst: usage.promptTokensEst,
      completionTokensEst: usage.completionTokensEst,
      costUsdEst: usage.costUsdEst,
      costKind: usage.costKind,
      provenance: usage.provenance,
      error: usage.error ?? null,
    },
  });
}

/** Programme-wide experiment counts: the denominator for multiple-testing accounting. */
export async function researchProgrammeCounts(prisma: PrismaClient | Tx) {
  const [total, byState, tested] = await Promise.all([
    prisma.researchExperiment.count(),
    prisma.researchExperiment.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.researchExperimentEvent.count({ where: { kind: "TRANSITION", fromState: "TEST", toState: "CHALLENGE" } }),
  ]);
  return {
    experiments: total,
    /** Experiments whose candidate was executed and measured (TEST → CHALLENGE), failures included. */
    tested,
    byState: Object.fromEntries(byState.map((row) => [row.state, row._count._all])),
  };
}

// ---------------------------------------------------------------------------------------------------
// Intake (daily cap and concurrency cap, serialised by an advisory transaction lock)
// ---------------------------------------------------------------------------------------------------

export type IntakeResult = { created: string[]; refused: string | null };

export async function createResearchExperiments(
  prisma: PrismaClient,
  input: { now: Date; createdBy: string; hypothesisIds?: string[]; control?: ResearchLoopControlRow },
): Promise<IntakeResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RESEARCH_LOOP_INTAKE_LOCK})`;
    const control = input.control ?? (await readResearchLoopControl(tx));
    const dayStart = researchBudgetWindowStart(input.now);
    const [createdToday, active] = await Promise.all([
      tx.researchExperiment.count({ where: { createdAt: { gte: dayStart } } }),
      tx.researchExperiment.count({ where: { state: { in: [...CLAIMABLE_EXPERIMENT_STATES] } } }),
    ]);
    const dailyRoom = control.maxExperimentsPerDay - createdToday;
    const concurrentRoom = control.maxConcurrentExperiments - active;
    if (dailyRoom <= 0) return { created: [], refused: `DAILY_CAP: ${createdToday}/${control.maxExperimentsPerDay} experiments created today (UTC)` };
    if (concurrentRoom <= 0) return { created: [], refused: `CONCURRENCY_CAP: ${active}/${control.maxConcurrentExperiments} experiments active` };
    const room = Math.min(dailyRoom, concurrentRoom);

    let hypothesisIds: string[];
    if (input.hypothesisIds) {
      const rows = await tx.hypothesis.findMany({ where: { id: { in: input.hypothesisIds } }, select: { id: true } });
      const known = new Set(rows.map((row) => row.id));
      const missing = input.hypothesisIds.filter((id) => !known.has(id));
      if (missing.length > 0) return { created: [], refused: `UNKNOWN_HYPOTHESIS: ${missing.join(", ")}` };
      hypothesisIds = input.hypothesisIds;
    } else {
      // Autonomous intake: OPEN hypotheses that have never had a loop experiment, oldest first.
      const existing = await tx.researchExperiment.findMany({ select: { hypothesisId: true }, distinct: ["hypothesisId"] });
      const taken = new Set(existing.map((row) => row.hypothesisId));
      const open = await tx.hypothesis.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true } });
      hypothesisIds = open.map((row) => row.id).filter((id) => !taken.has(id));
    }
    const created: string[] = [];
    for (const hypothesisId of hypothesisIds.slice(0, room)) {
      const id = newId("rexp");
      await tx.researchExperiment.create({
        data: { id, hypothesisId, state: "OBSERVE", createdBy: input.createdBy, createdAt: input.now },
      });
      const evidence = { hypothesisId, createdBy: input.createdBy, createdToday: createdToday + created.length + 1 };
      await tx.researchExperimentEvent.create({
        data: {
          id: newId("rxev"),
          experimentId: id,
          kind: "CREATED",
          fromState: null,
          toState: "OBSERVE",
          actor: input.createdBy,
          reason: "Experiment queued within daily and concurrency caps",
          evidence: toJson(evidence),
          evidenceHash: hashEvidence(evidence),
        },
      });
      created.push(id);
    }
    const refused = hypothesisIds.length > room ? `CAP_REACHED: ${hypothesisIds.length - room} hypothesis(es) not queued` : null;
    return { created, refused };
  });
}

// ---------------------------------------------------------------------------------------------------
// Claiming (lease + version compare-and-set)
// ---------------------------------------------------------------------------------------------------

function leaseFree(now: Date): Prisma.ResearchExperimentWhereInput {
  return { OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] };
}

/**
 * Claim up to `limit` experiments. A row is claimed only by an UPDATE that matches its id, the version
 * read, and a free (or expired) lease, so two ticks can never both hold the same experiment.
 * Expired leases (a worker that died mid-tick) are reclaimed and logged as LEASE_RECLAIMED.
 */
export async function claimResearchExperiments(
  prisma: PrismaClient,
  input: { owner: string; now: Date; leaseMs: number; limit: number },
): Promise<{ claimed: ExperimentRow[]; reclaimed: string[] }> {
  const candidates = await prisma.researchExperiment.findMany({
    where: { state: { in: [...CLAIMABLE_EXPERIMENT_STATES] }, ...leaseFree(input.now) },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: Math.max(input.limit * 3, input.limit),
  });
  const claimed: ExperimentRow[] = [];
  const reclaimed: string[] = [];
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  for (const candidate of candidates) {
    if (claimed.length >= input.limit) break;
    const result = await prisma.researchExperiment.updateMany({
      where: {
        id: candidate.id,
        version: candidate.version,
        state: { in: [...CLAIMABLE_EXPERIMENT_STATES] },
        ...leaseFree(input.now),
      },
      data: { leaseOwner: input.owner, leaseExpiresAt, version: { increment: 1 } },
    });
    if (result.count !== 1) continue;
    claimed.push({ ...candidate, leaseOwner: input.owner, leaseExpiresAt, version: candidate.version + 1 });
    if (candidate.leaseOwner !== null) {
      reclaimed.push(candidate.id);
      const evidence = {
        previousOwner: candidate.leaseOwner,
        previousLeaseExpiresAt: candidate.leaseExpiresAt?.toISOString() ?? null,
        newOwner: input.owner,
        at: input.now.toISOString(),
      };
      await prisma.researchExperimentEvent.create({
        data: {
          id: newId("rxev"),
          experimentId: candidate.id,
          kind: "LEASE_RECLAIMED",
          fromState: candidate.state,
          toState: candidate.state,
          actor: input.owner,
          reason: "Expired lease reclaimed (previous holder did not finish)",
          evidence: toJson(evidence),
          evidenceHash: hashEvidence(evidence),
        },
      });
    }
  }
  return { claimed, reclaimed };
}

async function releaseLease(prisma: PrismaClient, row: ExperimentRow, owner: string, lastError: string | null): Promise<boolean> {
  const result = await prisma.researchExperiment.updateMany({
    where: { id: row.id, leaseOwner: owner, version: row.version },
    data: { leaseOwner: null, leaseExpiresAt: null, version: { increment: 1 }, ...(lastError ? { lastError } : {}) },
  });
  return result.count === 1;
}

// ---------------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------------

export async function findValidApproval(
  prisma: PrismaClient | Tx,
  experimentId: string,
  action: ApprovableAction,
  subjectHash: string,
  now: Date,
) {
  return prisma.researchApproval.findFirst({
    where: { experimentId, action, subjectHash, approvedAt: { lte: now }, expiresAt: { gt: now } },
    orderBy: { approvedAt: "desc" },
  });
}

/**
 * What an approval of `action` covers for this experiment: the restated hypothesis the forge will
 * implement, the exact forged source and artifact the backtest will run, or the exact report the
 * paper-candidate label rests on. Null while that subject does not exist yet (nothing to approve).
 */
export function approvalSubject(
  experiment: { id: string; hypothesisId: string; context: unknown },
  action: ApprovableAction,
): { subjectHash: string; subject: Record<string, unknown> } | null {
  const context = asContext(experiment.context);
  let subject: Record<string, unknown>;
  if (action === "forge_code") {
    const hypothesis = asContext(context.hypothesis);
    if (typeof hypothesis.falsifier !== "string" || typeof hypothesis.conditions !== "string") return null;
    subject = {
      action,
      experimentId: experiment.id,
      hypothesisId: experiment.hypothesisId,
      hypothesis: { title: hypothesis.title ?? null, falsifier: hypothesis.falsifier, conditions: hypothesis.conditions },
    };
  } else if (action === "run_backtest") {
    const forge = asContext(context.forge);
    if (typeof forge.sourceHash !== "string" || typeof forge.artifactHash !== "string") return null;
    subject = { action, experimentId: experiment.id, sourceHash: forge.sourceHash, artifactHash: forge.artifactHash };
  } else {
    const validate = asContext(context.validate);
    if (typeof validate.reportId !== "string" || typeof validate.contentHash !== "string") return null;
    subject = { action, experimentId: experiment.id, reportId: validate.reportId, contentHash: validate.contentHash };
  }
  return { subject, subjectHash: hashEvidence(subject) };
}

type GateDecision =
  | { proceed: true; approvalId: string | null; gateReason: string }
  | { proceed: false; deny: string }
  | { proceed: false; needsApproval: true; gateReason: string };

async function gateAction(env: TickEnv, row: ExperimentRow, action: ApprovableAction): Promise<GateDecision> {
  const gate = assertActionAllowed(env.policy, action);
  if (!gate.allowed) return { proceed: false, deny: gate.reason };
  if (!gate.requiresApproval) return { proceed: true, approvalId: null, gateReason: gate.reason };
  const subject = approvalSubject(row, action);
  if (!subject) return { proceed: false, needsApproval: true, gateReason: `${gate.reason}; no approvable subject recorded` };
  // Validity is judged at gate time, not at tick start: an approval that lapsed during the tick is refused.
  const approval = await findValidApproval(env.prisma, row.id, action, subject.subjectHash, new Date(env.clock()));
  if (!approval) return { proceed: false, needsApproval: true, gateReason: gate.reason };
  return { proceed: true, approvalId: approval.id, gateReason: gate.reason };
}

// ---------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------

export async function runResearchLoopTick(
  prisma: PrismaClient,
  deps: ResearchLoopDeps,
  now: Date = new Date(),
): Promise<ResearchLoopTickResult> {
  const result: ResearchLoopTickResult = {
    status: "DISABLED",
    reason: "",
    owner: deps.owner,
    created: [],
    claimed: [],
    reclaimed: [],
    advanced: [],
    held: [],
    attemptsFailed: [],
    leaseLost: [],
    errors: [],
    modelCalls: 0,
    stoppedEarly: null,
  };
  const control = await readResearchLoopControl(prisma);
  if (!control.enabled) {
    result.reason = control.present ? "Kill switch is off" : "No ResearchLoopControl row (loop disabled)";
    return result;
  }
  const policy = await readAutonomyPolicy(prisma);
  if (policy.level < 2 || policy.level > 3) {
    result.status = "AUTONOMY_INSUFFICIENT";
    result.reason = `Autonomy level ${policy.level} does not permit the bounded research loop (needs 2 or 3)`;
    return result;
  }
  const queueGate = assertActionAllowed(policy, "queue_experiment");
  result.status = "RAN";
  result.reason = "Tick ran";
  const clock = deps.clock ?? Date.now;
  const env: TickEnv = {
    prisma,
    deps,
    now,
    policy,
    control,
    deadline: clock() + control.tickRuntimeMs,
    startedAt: clock(),
    clock,
    counters: { modelCalls: 0 },
  };

  if (queueGate.allowed) {
    const intake = await createResearchExperiments(prisma, { now, createdBy: RESEARCH_LOOP_ACTOR, control });
    result.created = intake.created;
  }

  const { claimed, reclaimed } = await claimResearchExperiments(prisma, {
    owner: deps.owner,
    now,
    leaseMs: control.leaseMs,
    limit: control.maxConcurrentExperiments,
  });
  result.claimed = claimed.map((row) => row.id);
  result.reclaimed = reclaimed;
  const untouched = new Map(claimed.map((row) => [row.id, row]));
  try {
    if (deps.afterClaim) await deps.afterClaim(result.claimed);
    for (const row of claimed) {
      const stillEnabled = (await readResearchLoopControl(prisma)).enabled;
      if (!stillEnabled || clock() >= env.deadline) {
        result.stoppedEarly = stillEnabled ? "TICK_RUNTIME_LIMIT" : "KILL_SWITCH_OFF";
        break;
      }
      untouched.delete(row.id);
      await advanceSafely(env, row, result);
    }
  } finally {
    // Whatever happened above, no claimed experiment stays leased once the tick ends.
    for (const rest of untouched.values()) {
      try {
        await releaseLease(prisma, rest, deps.owner, null);
      } catch (error) {
        result.errors.push({ id: rest.id, error: `LEASE_RELEASE_FAILED: ${errorMessage(error)}` });
      }
    }
    result.modelCalls = env.counters.modelCalls;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * M1: an unexpected error while advancing one experiment (a database error, a transaction timeout, a
 * failing side effect) is recorded as a failed attempt in a fresh compare-and-set transaction, so the
 * retry ceiling still applies, and the tick goes on to the next experiment.
 */
async function advanceSafely(env: TickEnv, row: ExperimentRow, result: ResearchLoopTickResult): Promise<void> {
  try {
    await advanceOne(env, row, result);
  } catch (error) {
    try {
      await recordAttemptFailure(env, row, `TICK_ERROR: ${errorMessage(error)}`, {}, result);
    } catch (second) {
      result.errors.push({ id: row.id, error: `${errorMessage(error)}; recording the attempt failed: ${errorMessage(second)}` });
    }
  }
}

/** Counts one failed attempt; at the ceiling the experiment becomes FAILED with the reason. */
async function recordAttemptFailure(
  env: TickEnv,
  row: ExperimentRow,
  reason: string,
  extraEvidence: Record<string, unknown>,
  result: ResearchLoopTickResult,
): Promise<void> {
  const attempts = row.attempts + 1;
  const ceiling = attempts >= env.control.maxAttemptsPerExperiment;
  const toState = ceiling ? "FAILED" : row.state;
  const recordedReason = ceiling
    ? `RETRY_CEILING: ${attempts}/${env.control.maxAttemptsPerExperiment} attempts; last error: ${reason}`
    : reason;
  const evidence = { attempts, maxAttempts: env.control.maxAttemptsPerExperiment, lastError: reason, ...extraEvidence, experimentVersion: row.version };
  try {
    await env.prisma.$transaction(async (tx) => {
      const updated = await tx.researchExperiment.updateMany({
        where: { id: row.id, leaseOwner: env.deps.owner, version: row.version },
        data: {
          attempts,
          lastError: recordedReason,
          ...(ceiling ? { state: "FAILED", blockedState: null } : {}),
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new LeaseLostError(row.id);
      await tx.researchExperimentEvent.create({
        data: {
          id: newId("rxev"),
          experimentId: row.id,
          kind: ceiling ? "TRANSITION" : "ATTEMPT_FAILED",
          fromState: row.state,
          toState,
          actor: env.deps.owner,
          reason: recordedReason,
          evidence: toJson(evidence),
          evidenceHash: hashEvidence(evidence),
        },
      });
    });
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
    result.leaseLost.push(row.id);
    return;
  }
  if (ceiling) result.advanced.push({ id: row.id, from: row.state, to: "FAILED", reason: recordedReason });
  else result.attemptsFailed.push({ id: row.id, state: row.state, reason });
}

async function advanceOne(env: TickEnv, row: ExperimentRow, result: ResearchLoopTickResult): Promise<void> {
  let outcome: StageOutcome;
  if (row.attempts >= env.control.maxAttemptsPerExperiment) {
    outcome = {
      kind: "advance",
      to: "FAILED",
      reason: `RETRY_CEILING: ${row.attempts}/${env.control.maxAttemptsPerExperiment} attempts; last error: ${row.lastError ?? "none"}`,
      evidence: { attempts: row.attempts, lastError: row.lastError },
    };
  } else if (leaseRemainingMs(env, row) < Math.max(env.deadline - env.clock(), 0) + 10_000) {
    // L1: never start stage work the lease might not cover (it would be reclaimed mid-work).
    outcome = { kind: "hold", reason: "LEASE_TOO_SHORT: remaining lease does not cover the rest of the tick" };
  } else {
    try {
      outcome = await runStage(env, row);
    } catch (error) {
      outcome = { kind: "attempt_failed", reason: `STAGE_ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (outcome.kind === "hold") {
    const kept = await releaseLease(env.prisma, row, env.deps.owner, outcome.reason);
    if (kept) result.held.push({ id: row.id, state: row.state, reason: outcome.reason });
    else result.leaseLost.push(row.id);
    return;
  }

  if (outcome.kind === "attempt_failed") {
    return recordAttemptFailure(env, row, outcome.reason, outcome.evidence ?? {}, result);
  }

  return commitAdvance(env, row, outcome, result, row.attempts);
}

/** Lease time left, on the tick's logical clock (`now` plus the wall time elapsed since the tick began). */
function leaseRemainingMs(env: TickEnv, row: ExperimentRow): number {
  if (!row.leaseExpiresAt) return 0;
  return row.leaseExpiresAt.getTime() - (env.now.getTime() + (env.clock() - env.startedAt));
}

async function commitAdvance(
  env: TickEnv,
  row: ExperimentRow,
  outcome: Extract<StageOutcome, { kind: "advance" }>,
  result: ResearchLoopTickResult,
  attempts: number,
): Promise<void> {
  const check = canTransitionExperiment(row.state, outcome.to, { blockedState: row.blockedState });
  if (!check.ok) {
    // A stage handler asked for an illegal move. Refuse it, keep the state, and record why.
    await releaseLease(env.prisma, row, env.deps.owner, `ILLEGAL_TRANSITION_REFUSED: ${check.error}`);
    result.held.push({ id: row.id, state: row.state, reason: `ILLEGAL_TRANSITION_REFUSED: ${check.error}` });
    return;
  }
  const blockedState = outcome.to === "BLOCKED_APPROVAL" ? (outcome.blockedState ?? null) : null;
  const context = { ...asContext(row.context), ...(outcome.contextPatch ?? {}) };
  try {
    await env.prisma.$transaction(async (tx) => {
      const updated = await tx.researchExperiment.updateMany({
        where: { id: row.id, leaseOwner: env.deps.owner, version: row.version },
        data: {
          state: outcome.to,
          blockedState,
          // Attempts accumulate over the whole experiment: the ceiling is per experiment, not per stage.
          attempts,
          lastError: isTerminalExperimentState(outcome.to) || outcome.to === "BLOCKED_APPROVAL" ? outcome.reason : null,
          context: toJson(context),
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new LeaseLostError(row.id);
      const evidence = { ...outcome.evidence, experimentVersion: row.version, tickAt: env.now.toISOString() };
      await tx.researchExperimentEvent.create({
        data: {
          id: newId("rxev"),
          experimentId: row.id,
          kind: "TRANSITION",
          fromState: row.state,
          toState: outcome.to,
          actor: env.deps.owner,
          reason: outcome.reason,
          evidence: toJson(evidence),
          evidenceHash: hashEvidence(evidence),
        },
      });
      if (outcome.sideEffects) await outcome.sideEffects(tx);
      if (env.deps.beforeCommit) await env.deps.beforeCommit(row.id, outcome.to);
    });
    result.advanced.push({ id: row.id, from: row.state, to: outcome.to, reason: outcome.reason });
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
    result.leaseLost.push(row.id);
  }
}

// ---------------------------------------------------------------------------------------------------
// Stage work
// ---------------------------------------------------------------------------------------------------

async function runStage(env: TickEnv, row: ExperimentRow): Promise<StageOutcome> {
  const state = row.state as ResearchExperimentState;
  if (state === "BLOCKED_APPROVAL") return unblock(env, row);
  if (isGatedStage(state)) {
    const decision = await gateAction(env, row, GATED_STAGE_ACTIONS[state]);
    if (!decision.proceed) {
      if ("deny" in decision) return { kind: "hold", reason: `DENIED: ${decision.deny}` };
      return {
        kind: "advance",
        to: "BLOCKED_APPROVAL",
        blockedState: state,
        reason: `APPROVAL_REQUIRED: ${GATED_STAGE_ACTIONS[state]} (${decision.gateReason})`,
        evidence: { action: GATED_STAGE_ACTIONS[state], autonomyLevel: env.policy.level },
      };
    }
    const gateEvidence = { action: GATED_STAGE_ACTIONS[state], approvalId: decision.approvalId, autonomyLevel: env.policy.level };
    if (state === "FORGE") return forgeStage(env, row, gateEvidence);
    if (state === "TEST") return testStage(env, row, gateEvidence);
    return paperStage(env, row, gateEvidence);
  }
  switch (state) {
    case "OBSERVE":
      return observeStage(env, row);
    case "HYPOTHESISE":
      return hypothesiseStage(env, row);
    case "CHALLENGE":
      return challengeStage(env, row);
    case "VALIDATE":
      return validateStage(env, row);
    default:
      return { kind: "hold", reason: `State ${state} is not worked by the loop` };
  }
}

async function unblock(env: TickEnv, row: ExperimentRow): Promise<StageOutcome> {
  const target = row.blockedState;
  if (!target || !isGatedStage(target)) {
    return { kind: "advance", to: "FAILED", reason: "BLOCKED_APPROVAL without a valid blockedState", evidence: { blockedState: target } };
  }
  const decision = await gateAction(env, row, GATED_STAGE_ACTIONS[target]);
  if (!decision.proceed) {
    if ("deny" in decision) return { kind: "hold", reason: `DENIED: ${decision.deny}` };
    return { kind: "hold", reason: `AWAITING_APPROVAL: ${GATED_STAGE_ACTIONS[target]}` };
  }
  return {
    kind: "advance",
    to: target,
    reason: decision.approvalId ? `Approval ${decision.approvalId} recorded for ${GATED_STAGE_ACTIONS[target]}` : `Gate no longer requires approval`,
    evidence: { action: GATED_STAGE_ACTIONS[target], approvalId: decision.approvalId },
  };
}

async function loadHypothesis(env: TickEnv, row: ExperimentRow): Promise<Hypothesis | null> {
  const hypothesis = await env.prisma.hypothesis.findUnique({ where: { id: row.hypothesisId } });
  if (!hypothesis) return null;
  return {
    id: hypothesis.id,
    title: hypothesis.title,
    market: hypothesis.market as Hypothesis["market"],
    instrumentIds: hypothesis.instrumentIds,
    conditions: hypothesis.conditions,
    claimedAdvantage: hypothesis.claimedAdvantage,
    entryRules: hypothesis.entryRules,
    exitRules: hypothesis.exitRules,
    riskRules: hypothesis.riskRules,
    rationale: hypothesis.rationale,
    successCriteria: hypothesis.successCriteria,
    failureModes: hypothesis.failureModes,
    status: "OPEN",
  };
}

async function observeStage(env: TickEnv, row: ExperimentRow): Promise<StageOutcome> {
  const hypothesis = await loadHypothesis(env, row);
  if (!hypothesis) {
    return { kind: "advance", to: "ABANDONED", reason: "HYPOTHESIS_MISSING", evidence: { hypothesisId: row.hypothesisId } };
  }
  const [count, latest] = await Promise.all([
    env.prisma.marketObservation.count({ where: { receivedAt: { lte: env.now } } }),
    env.prisma.marketObservation.findFirst({ where: { receivedAt: { lte: env.now } }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
  ]);
  const observe = {
    hypothesisHash: hashEvidence(hypothesis as unknown as Record<string, unknown>),
    observationCount: count,
    latestObservationAt: latest?.receivedAt.toISOString() ?? null,
    observedAt: env.now.toISOString(),
  };
  return { kind: "advance", to: "HYPOTHESISE", reason: "Observation recorded", evidence: observe, contextPatch: { observe } };
}

const hypothesisReplySchema = z
  .object({
    title: z.string().min(3).max(160),
    falsifier: z.string().min(8).max(500),
    conditions: z.string().min(8).max(500),
  })
  .strict();
const sourceReplySchema = z.object({ source: z.string().min(20).max(8_000) }).strict();
const challengeReplySchema = z
  .object({ verdict: z.enum(["PASS", "REJECT"]), findings: z.array(z.string()).max(12) })
  .strict();

type ModelCall<T> =
  | { status: "OK"; data: T; model: string; endpointId: string | null }
  | { status: "BUDGET_EXHAUSTED"; detail: string }
  | { status: "NO_TIME"; detail: string }
  | { status: "UNAVAILABLE"; detail: string };

/**
 * One model call under the persistent research budget: a router seeded with the current UTC day's
 * ModelUsageLog spend, whose `onUsage` hook writes each call before the next. No call is made when the
 * budget is spent or no endpoint for the tier is configured.
 */
async function callModel<T>(
  env: TickEnv,
  agent: string,
  purpose: LlmRequest["purpose"],
  schema: z.ZodType<T>,
  prompt: string,
): Promise<ModelCall<T> & { router: ModelRouter }> {
  const spend = await researchSpendToday(env.prisma, env.now);
  const router = new ModelRouter({
    ...env.deps.router,
    mode: "live",
    budgetCapUsd: env.policy.maxResearchBudgetUsd,
    budgetStore: new MemoryBudgetStore(spend.spentUsd),
    onUsage: async (usage) => {
      env.counters.modelCalls += 1;
      await persistModelUsage(env.prisma, usage);
    },
  });
  const budget = router.budget();
  if (d(budget.remainingUsd).lte(0)) {
    return { status: "BUDGET_EXHAUSTED", detail: `Research budget spent: ${budget.spentUsd ?? "unknown"} of ${budget.capUsd} USD today (UTC)`, router };
  }
  const remainingMs = env.deadline - env.clock();
  if (remainingMs < 5_000) return { status: "NO_TIME", detail: "Less than 5 s of tick runtime left", router };
  const assignment = router.assignmentFor(agent);
  const chain = [assignment.primaryEndpointId, ...assignment.fallbackEndpointIds];
  const health = router.health();
  const configured = chain.some((id) => health.find((row) => row.id === id)?.availability === "CONFIGURED");
  if (!configured) return { status: "UNAVAILABLE", detail: `No configured model endpoint for ${agent} (${chain.join(", ")})`, router };
  const reply = await router.completeJson(
    agent,
    {
      purpose,
      maxTokens: purpose === "engineering_source" ? 1_200 : 600,
      timeoutMs: Math.max(1_000, Math.min(60_000, remainingMs - 1_000)),
      messages: [
        { role: "system", content: "You are a research assistant for a paper-only research lab. Reply with one JSON object only." },
        { role: "user", content: prompt },
      ],
    },
    schema,
  );
  if (!reply.ok) {
    if (reply.error === "Model budget cap reached") return { status: "BUDGET_EXHAUSTED", detail: reply.error, router };
    return { status: "UNAVAILABLE", detail: `${reply.code}: ${reply.error}`, router };
  }
  return { status: "OK", data: reply.data, model: reply.model, endpointId: reply.usage?.endpointId ?? null, router };
}

function modelFailure(call: Exclude<ModelCall<unknown>, { status: "OK" }>, step: string): StageOutcome {
  if (call.status === "BUDGET_EXHAUSTED") return { kind: "hold", reason: `BUDGET_EXHAUSTED: ${call.detail}` };
  if (call.status === "NO_TIME") return { kind: "hold", reason: `TICK_RUNTIME_LIMIT: ${call.detail}` };
  return { kind: "attempt_failed", reason: `MODEL_UNAVAILABLE (${step}): ${call.detail}` };
}

async function hypothesiseStage(env: TickEnv, row: ExperimentRow): Promise<StageOutcome> {
  const hypothesis = await loadHypothesis(env, row);
  if (!hypothesis) return { kind: "advance", to: "ABANDONED", reason: "HYPOTHESIS_MISSING", evidence: { hypothesisId: row.hypothesisId } };
  const call = await callModel(
    env,
    "ORACLE",
    "deep_hypothesis",
    hypothesisReplySchema,
    `Restate this operator hypothesis as one falsifiable hypothesis. Reply {"title","falsifier","conditions"}. Do not write strategy source.\n${JSON.stringify({
      title: hypothesis.title,
      conditions: hypothesis.conditions,
      claimedAdvantage: hypothesis.claimedAdvantage,
      entryRules: hypothesis.entryRules,
      exitRules: hypothesis.exitRules,
      successCriteria: hypothesis.successCriteria,
      failureModes: hypothesis.failureModes,
    })}`,
  );
  if (call.status !== "OK") return modelFailure(call, "HYPOTHESISE");
  const restated = { ...call.data, model: call.model, endpointId: call.endpointId };
  return { kind: "advance", to: "FORGE", reason: "Falsifiable hypothesis recorded", evidence: { hypothesis: restated }, contextPatch: { hypothesis: restated } };
}

const FORGE_REJECT_CODES = new Set(["STATIC_REJECT", "COMPILE_FAIL", "CONTRACT_FAIL", "INVALID"]);

async function forgeStage(env: TickEnv, row: ExperimentRow, gateEvidence: Record<string, unknown>): Promise<StageOutcome> {
  const hypothesis = await loadHypothesis(env, row);
  if (!hypothesis) return { kind: "advance", to: "ABANDONED", reason: "HYPOTHESIS_MISSING", evidence: { hypothesisId: row.hypothesisId } };
  const restated = asContext(asContext(row.context).hypothesis);
  if (typeof restated.falsifier !== "string" || typeof restated.conditions !== "string") {
    return { kind: "advance", to: "FAILED", reason: "CONTEXT_MISSING: no recorded hypothesis restatement", evidence: gateEvidence };
  }
  const call = await callModel(
    env,
    "FORGE",
    "engineering_source",
    sourceReplySchema,
    `Write a TypeScript strategy module for the hypothesis below. Export exactly \`export function onBar(input)\`; input.bar is the current bar (priceUsd, liquidityUsd, volume24hUsd, priceChangeM5Pct, priceChangeH1Pct, txnsM5Buys, txnsM5Sells as strings or null) and input.history holds earlier bars only. Return {intent: "ENTER_LONG"|"EXIT_LONG"|"HOLD", reasonCodes: string[]}. No imports, no I/O, no globals, no sizing. Reply {"source"}.\n${JSON.stringify({
      falsifier: restated.falsifier,
      conditions: restated.conditions,
      entryRules: hypothesis.entryRules,
      exitRules: hypothesis.exitRules,
    })}`,
  );
  if (call.status !== "OK") return modelFailure(call, "FORGE");
  const forge = env.deps.forge ?? forgeStrategyModule;
  const forged = await forge({
    hypothesis: { ...hypothesis, conditions: String(restated.conditions), status: "FORGING" },
    source: call.data.source,
    modelIdentifier: call.model,
  });
  if (!forged.ok) {
    const evidence = { ...gateEvidence, code: forged.code, error: forged.error, findings: forged.findings, sourceHash: forged.integrity.sourceHash };
    if (FORGE_REJECT_CODES.has(forged.code)) {
      return { kind: "advance", to: "REJECTED", reason: `FORGE_${forged.code}: ${forged.error}`, evidence };
    }
    return { kind: "attempt_failed", reason: `FORGE_${forged.code}: ${forged.error}`, evidence };
  }
  const forgeContext = {
    strategyId: forged.manifest.id,
    version: forged.manifest.version,
    source: call.data.source,
    sourceHash: forged.sourceHash,
    artifactHash: forged.artifactHash,
    modelIdentifier: call.model,
    endpointId: call.endpointId,
    provenance: forged.provenance,
  };
  const { source: _source, ...forgeEvidence } = forgeContext;
  void _source;
  return {
    kind: "advance",
    to: "TEST",
    reason: `Forged ${forged.manifest.id} (${forged.sourceHash.slice(0, 12)}) in the isolated runner`,
    evidence: { ...gateEvidence, ...forgeEvidence },
    contextPatch: { forge: forgeContext },
    sideEffects: (tx) =>
      writeLifecycle(tx, forged.manifest.id, row.id, [
        ["DRAFT", "CODE_GENERATED", "FORGE", { sourceHash: forged.sourceHash }],
        ["CODE_GENERATED", "TESTING", RESEARCH_LOOP_ACTOR, { artifactHash: forged.artifactHash }],
      ]),
  };
}

/** Persisted observations received at or before the tick time (no look-ahead), most recent 400, in time order. */
export async function loadResearchObservations(prisma: PrismaClient, now: Date): Promise<BacktestObservation[]> {
  const rows = await prisma.marketObservation.findMany({
    where: { receivedAt: { lte: now } },
    orderBy: { receivedAt: "desc" },
    take: 400,
  });
  return rows.reverse().map((row) => ({
    id: row.id,
    pairAddress: row.pairAddress,
    baseSymbol: row.baseSymbol,
    quoteAddress: row.quoteAddress,
    quoteSymbol: row.quoteSymbol,
    priceUsd: row.priceUsd?.toString() ?? null,
    liquidityUsd: row.liquidityUsd?.toString() ?? null,
    volume24hUsd: row.volume24hUsd?.toString() ?? null,
    volume5mUsd: row.volume5mUsd?.toString() ?? null,
    priceChangeM5Pct: row.priceChangeM5?.toString() ?? null,
    priceChangeH1Pct: row.priceChangeH1?.toString() ?? null,
    txnsM5Buys: row.txnsM5Buys,
    txnsM5Sells: row.txnsM5Sells,
    receivedAt: row.receivedAt.toISOString(),
    freshness: (["LIVE", "DELAYED", "STALE", "REPLAY", "DEMO"].includes(row.freshness) ? row.freshness : "STALE") as BacktestObservation["freshness"],
    provenance: `MarketObservation:${row.id}`,
  }));
}

const SANDBOX_RETRY_CODES = new Set(["ISOLATION_DISABLED", "SECCOMP_INTEGRITY", "SANDBOX_TIMEOUT", "SANDBOX_EXIT"]);

async function testStage(env: TickEnv, row: ExperimentRow, gateEvidence: Record<string, unknown>): Promise<StageOutcome> {
  const forgeContext = asContext(asContext(row.context).forge);
  const source = forgeContext.source;
  const strategyId = forgeContext.strategyId;
  if (typeof source !== "string" || typeof strategyId !== "string" || typeof forgeContext.artifactHash !== "string") {
    return { kind: "advance", to: "FAILED", reason: "CONTEXT_MISSING: no forged artifact recorded", evidence: gateEvidence };
  }
  const reject = (reason: string, evidence: Record<string, unknown>): StageOutcome => ({
    kind: "advance",
    to: "REJECTED",
    reason,
    evidence: { ...gateEvidence, ...evidence },
    sideEffects: (tx) => writeLifecycle(tx, strategyId, row.id, [["TESTING", "REJECTED", "TEST", { reason }]]),
  });
  const compiled = compileStrategySource(source);
  if (!compiled.ok || compiled.artifactHash !== forgeContext.artifactHash) {
    return reject("ARTIFACT_MISMATCH: recompiled source does not match the forged artifact", { expected: forgeContext.artifactHash });
  }
  const observations = await (env.deps.loadObservations ?? loadResearchObservations)(env.prisma, env.now);
  const usable = observations.filter((row) => Date.parse(row.receivedAt) <= env.now.getTime());
  if (usable.length === 0) return reject("INSUFFICIENT_EVIDENCE: no observations at or before the tick time", { observationCount: 0 });
  const hypothesisId = row.hypothesisId;
  const instrumentId = (await loadHypothesis(env, row))?.instrumentIds[0];
  const execute = env.deps.execute ?? executeCompiledStrategy;
  const execution = await execute({
    javascript: compiled.javascript,
    artifactHash: compiled.artifactHash,
    bars: usable.map((obs) => ({
      instrumentId: instrumentId ?? obs.pairAddress,
      pairAddress: obs.pairAddress,
      receivedAt: obs.receivedAt,
      priceUsd: obs.priceUsd,
      liquidityUsd: obs.liquidityUsd,
      volume24hUsd: obs.volume24hUsd,
      priceChangeM5Pct: obs.priceChangeM5Pct,
      priceChangeH1Pct: obs.priceChangeH1Pct,
      txnsM5Buys: obs.txnsM5Buys,
      txnsM5Sells: obs.txnsM5Sells,
      dataState: obs.freshness,
    })),
    metadata: { strategyId, version: String(forgeContext.version ?? "0.1.0"), hypothesisId },
  });
  if (!execution.signalsClaimed || execution.signals.length !== usable.length) {
    const evidence = { code: execution.code, error: execution.error, signals: execution.signals.length, bars: usable.length };
    if (SANDBOX_RETRY_CODES.has(execution.code)) {
      return { kind: "attempt_failed", reason: `SANDBOX_${execution.code}: ${execution.error ?? "isolated run did not complete"}`, evidence };
    }
    return reject(`SANDBOX_${execution.code}: ${execution.error ?? "signals not claimed for every bar"}`, evidence);
  }
  // Same measurement path as runResearchPipeline: paper simulation, statistics, untouched test window.
  const config = parseStrategyConfig(DEFAULT_STRATEGY);
  const simulation = simulateResearchPath({
    observations: usable,
    signals: usable.map((obs, index) => ({ observationId: obs.id, intent: execution.signals[index]?.intent ?? "HOLD" })),
    config,
    initialCashUsd: config.startingBalanceUsd,
    latencyMs: config.paperLatencyMs,
  });
  const statistics = summariseStatistics({
    startingEquityUsd: config.startingBalanceUsd,
    endingEquityUsd: simulation.endingEquityUsd,
    netProfitUsd:
      simulation.closedPnls.length === 0
        ? null
        : simulation.closedPnls.reduce((total, pnl) => total.plus(d(pnl)), d("0")).toFixed(8),
    closedPnls: simulation.closedPnls,
    equitySeries: simulation.equitySeries,
    exposureSeries: simulation.exposureSeries,
    observationSpanMs: simulation.observationSpanMs,
    feeBps: config.feeBps,
    alternativeFeeReturns: null,
    parameterReturns: null,
  });
  const startAt = usable[0]!.receivedAt;
  const endAt = usable.at(-1)!.receivedAt;
  const splits = startAt !== endAt ? chronologicalSplits(startAt, endAt) : null;
  const untouched = splits
    ? scoreWindow(simulation, Date.parse(splits.testStart), Date.parse(splits.testEnd))
    : { returnPct: null, sampleSize: 0, closedPnls: [] };
  const test = {
    datasetHash: createHash("sha256").update(usable.map((obs) => `${obs.id}:${obs.receivedAt}:${obs.priceUsd ?? ""}`).join("|")).digest("hex"),
    startAt,
    endAt,
    observationCount: usable.length,
    blocked: simulation.blocked,
    blockReason: simulation.blockReason,
    measuredReturnPct: simulation.blocked ? null : simulation.returnPct,
    measuredSampleSize: simulation.blocked ? 0 : simulation.closedPnls.length,
    maxDrawdownPct: statistics.maxDrawdownPct.value,
    untouchedReturnPct: untouched.returnPct,
    untouchedSampleSize: untouched.sampleSize,
    splits,
    statisticsRecorded: true,
    configHash: configHashOf(config),
    feeBps: config.feeBps,
    latencyMs: config.paperLatencyMs,
    executedHash: execution.executedHash,
  };
  return {
    kind: "advance",
    to: "CHALLENGE",
    reason: `Measured: return ${test.measuredReturnPct ?? "unavailable"}, n=${test.measuredSampleSize}, untouched n=${test.untouchedSampleSize}`,
    evidence: { ...gateEvidence, ...test },
    contextPatch: { test },
  };
}

async function challengeStage(env: TickEnv, row: ExperimentRow): Promise<StageOutcome> {
  const context = asContext(row.context);
  const test = asContext(context.test);
  const forgeContext = asContext(context.forge);
  const strategyId = typeof forgeContext.strategyId === "string" ? forgeContext.strategyId : null;
  if (!strategyId || typeof test.measuredSampleSize !== "number") {
    return { kind: "advance", to: "FAILED", reason: "CONTEXT_MISSING: no measured test recorded", evidence: {} };
  }
  const hypothesisTrials = await env.prisma.researchExperimentEvent.count({
    where: { kind: "TRANSITION", fromState: "TEST", toState: "CHALLENGE", experiment: { hypothesisId: row.hypothesisId } },
  });
  const deterministic: ChallengeReport = runChallengeReview({
    sampleSize: test.measuredSampleSize,
    oosSampleSize: typeof test.untouchedSampleSize === "number" && test.untouchedSampleSize > 0 ? test.untouchedSampleSize : null,
    inSampleReturnPct: (test.measuredReturnPct as string | null) ?? null,
    oosReturnPct: (test.untouchedReturnPct as string | null) ?? null,
    maxDrawdownPct: (test.maxDrawdownPct as string | null) ?? null,
    inactivePairCount: 0,
    disappearedPairCount: 0,
    parameterTrials: Math.max(1, hypothesisTrials),
    usedFutureBars: false,
    usedPostExitMemoryInEntry: false,
    costModelPresent: true,
    monteCarloRan: false,
    correlatedSiblingStrategies: 0,
  });
  const rejectOutcome = (reason: string, evidence: Record<string, unknown>): StageOutcome => ({
    kind: "advance",
    to: "REJECTED",
    reason,
    evidence,
    contextPatch: { challenge: evidence },
    sideEffects: (tx) => writeLifecycle(tx, strategyId, row.id, [["TESTING", "REJECTED", "CHALLENGE", { reason }]]),
  });
  if (!deterministic.passed) {
    return rejectOutcome(`CHALLENGE_REJECT: ${deterministic.summary}`, {
      deterministic: { passed: false, summary: deterministic.summary, findingCodes: deterministic.findings.map((f) => f.code) },
    });
  }
  // The model reviewer must be a separate endpoint from the one that wrote the code.
  const probe = new ModelRouter({ ...env.deps.router, mode: "live" });
  const separated = probe.assertSeparatedReviewer();
  if (!separated.separated) {
    return { kind: "advance", to: "FAILED", reason: `REVIEWER_NOT_SEPARATED: FORGE and CHALLENGE share ${separated.forgeEndpointId}`, evidence: separated };
  }
  const call = await callModel(
    env,
    "CHALLENGE",
    "challenge_review",
    challengeReplySchema,
    `Challenge this research candidate adversarially. Reply {"verdict":"PASS"|"REJECT","findings":[...]}.\n${JSON.stringify({
      hypothesis: asContext(context.hypothesis).falsifier ?? null,
      measured: {
        returnPct: test.measuredReturnPct ?? null,
        sampleSize: test.measuredSampleSize,
        untouchedReturnPct: test.untouchedReturnPct ?? null,
        untouchedSampleSize: test.untouchedSampleSize ?? 0,
        maxDrawdownPct: test.maxDrawdownPct ?? null,
      },
      deterministicFindings: deterministic.findings.map((f) => `${f.code}: ${f.detail}`),
    })}`,
  );
  if (call.status !== "OK") return modelFailure(call, "CHALLENGE");
  if (call.endpointId !== null && call.endpointId === forgeContext.endpointId) {
    return { kind: "advance", to: "FAILED", reason: `REVIEWER_NOT_SEPARATED: challenge answered by forge endpoint ${call.endpointId}`, evidence: separated };
  }
  const challenge = {
    deterministic: { passed: deterministic.passed, summary: deterministic.summary, findingCodes: deterministic.findings.map((f) => f.code) },
    report: deterministic,
    model: { verdict: call.data.verdict, findings: call.data.findings, model: call.model, endpointId: call.endpointId },
    separated,
    hypothesisTrials,
  };
  if (call.data.verdict === "REJECT") return rejectOutcome(`CHALLENGE_REJECT: model reviewer (${call.model})`, challenge);
  return {
    kind: "advance",
    to: "VALIDATE",
    reason: "Deterministic and separated model challenge passed",
    evidence: { ...challenge, report: undefined },
    contextPatch: { challenge },
    sideEffects: (tx) => writeLifecycle(tx, strategyId, row.id, [["TESTING", "CHALLENGED", "CHALLENGE", { passed: true }]]),
  };
}

async function validateStage(env: TickEnv, row: ExperimentRow): Promise<StageOutcome> {
  const context = asContext(row.context);
  const test = asContext(context.test);
  const forgeContext = asContext(context.forge);
  const challenge = asContext(context.challenge);
  const report = challenge.report as ChallengeReport | undefined;
  const strategyId = forgeContext.strategyId;
  if (typeof strategyId !== "string" || !report || typeof test.datasetHash !== "string") {
    return { kind: "advance", to: "FAILED", reason: "CONTEXT_MISSING: validation inputs not recorded", evidence: {} };
  }
  const config = parseStrategyConfig(DEFAULT_STRATEGY);
  const minSampleSize = config.minSampleTrades;
  const splits = asContext(test.splits) as { trainStart?: string; validationStart?: string; testStart?: string; testEnd?: string };
  const testWindow = splits.testStart && splits.testEnd ? { start: Date.parse(splits.testStart), end: Date.parse(splits.testEnd) } : null;
  // Earlier reports for the same hypothesis over the same test window count as selection on it.
  const priorReports = await env.prisma.experimentReport.findMany({ where: { hypothesisId: row.hypothesisId }, select: { id: true, payload: true, createdAt: true } });
  const overlapping = priorReports.filter((prior) => {
    if (!testWindow) return false;
    const manifest = asContext(asContext(prior.payload).datasetManifest);
    if (typeof manifest.startAt !== "string" || typeof manifest.endAt !== "string") return true;
    return Date.parse(manifest.startAt) <= testWindow.end && Date.parse(manifest.endAt) >= testWindow.start;
  });
  const tunedOnEvaluationSample = testWindow ? overlapping.length > 0 : null;
  const measuredReturn = (test.measuredReturnPct as string | null) ?? null;
  const measuredSample = Number(test.measuredSampleSize ?? 0);
  const outcomes = classifyResearchOutcomes({
    pipelineFinished: true,
    experimentExecuted: true,
    returnPct: measuredReturn,
    sampleSize: measuredSample,
    minSampleSize,
    statisticsRecorded: test.statisticsRecorded === true,
    untouchedTestReturnPct: (test.untouchedReturnPct as string | null) ?? null,
    untouchedSampleSize: Number(test.untouchedSampleSize ?? 0),
    tunedOnEvaluationSample,
    forwardPaperValidated: false,
    promotionAuthorised: false,
  });
  const programme = await researchProgrammeCounts(env.prisma);
  const executable: ReportExecutable = {
    kind: "COMPILED_SANDBOX",
    moduleRef: null,
    moduleVersion: String(forgeContext.version ?? "0.1.0"),
    sourceHash: String(forgeContext.sourceHash),
    artifactHash: String(forgeContext.artifactHash),
    runtimeLoadable: false,
  };
  const measuredFull = test.blocked !== true;
  const evaluation = finaliseEvaluation(
    {
      protocol: EVALUATION_PROTOCOLS.PIPELINE_SANDBOX_V1,
      config,
      configHash: configHashOf(config),
      dataset: {
        id: `observations:${String(test.startAt)}..${String(test.endAt)}`,
        hash: test.datasetHash,
        basis: "MarketObservation id:receivedAt:priceUsd",
        startAt: (test.startAt as string | null) ?? null,
        endAt: (test.endAt as string | null) ?? null,
        observationCount: Number(test.observationCount ?? 0),
      },
      partitions: [
        {
          name: "FULL",
          startAt: (test.startAt as string | null) ?? null,
          endAt: (test.endAt as string | null) ?? null,
          measured: measuredFull,
          sampleSize: measuredFull ? measuredSample : null,
          returnPct: measuredReturn,
          maxDrawdownPct: (test.maxDrawdownPct as string | null) ?? null,
        },
        {
          name: "TEST",
          startAt: splits.testStart ?? null,
          endAt: splits.testEnd ?? null,
          measured: measuredFull && testWindow !== null,
          sampleSize: measuredFull && testWindow ? Number(test.untouchedSampleSize ?? 0) : null,
          returnPct: measuredFull && testWindow ? ((test.untouchedReturnPct as string | null) ?? null) : null,
          maxDrawdownPct: null,
        },
      ],
      minSampleSize,
      tuning: {
        parameterTrials: overlapping.length + 1,
        tunedOnEvaluationSample,
        basis: "Research-loop experiment; prior reports for this hypothesis over the test window count as selection",
        history: overlapping.map((prior) => ({ ref: prior.id, at: prior.createdAt.toISOString(), detail: "Earlier evaluation of this hypothesis overlapping the test window" })),
      },
      costs: { feeBps: config.feeBps, slippageModel: "research-backtest simulateResearchPath fills", latencyMs: config.paperLatencyMs },
      forwardPaper: { status: "NONE", resultIds: [], closedTradeCount: 0, returnPct: null },
    },
    executable,
  );
  const modelReview = asContext(challenge.model);
  const experimentReport = buildExperimentReport({
    reportId: newId("rpt"),
    hypothesisId: row.hypothesisId,
    strategyModuleId: strategyId,
    strategyVersion: String(forgeContext.version ?? "0.1.0"),
    models: [
      { agentOrTask: "FORGE", endpointId: String(forgeContext.endpointId ?? "unknown"), model: String(forgeContext.modelIdentifier ?? "unknown") },
      { agentOrTask: "CHALLENGE", endpointId: String(modelReview.endpointId ?? "unknown"), model: String(modelReview.model ?? "unknown") },
    ],
    datasetManifest: {
      observationCount: Number(test.observationCount ?? 0),
      startAt: (test.startAt as string | null) ?? null,
      endAt: (test.endAt as string | null) ?? null,
      sources: ["persisted_observations"],
      contentHash: test.datasetHash,
    },
    periods: { train: splits.trainStart ?? null, validation: splits.validationStart ?? null, test: splits.testStart ?? null },
    results: {
      sampleSize: measuredSample,
      returnPct: measuredReturn,
      maxDrawdownPct: (test.maxDrawdownPct as string | null) ?? null,
      releaseGateLabel: "NOT_RELEASE_READY",
    },
    uncertainty: [
      measuredReturn === null ? "RETURN_UNAVAILABLE" : "RETURN_MEASURED",
      measuredSample < minSampleSize ? "INSUFFICIENT_EVIDENCE" : "SAMPLE_OK",
      `PROGRAMME_EXPERIMENTS=${programme.experiments}`,
      `PROGRAMME_EXPERIMENTS_TESTED=${programme.tested}`,
      "RESEARCH_LOOP_AUTONOMOUS: forward paper evaluation and operator review still required",
    ],
    weaknesses: report.findings.map((finding) => `${finding.code}: ${finding.detail}`),
    challenge: report,
    reproducibility: { codeHash: String(forgeContext.sourceHash), configHash: configHashOf(config), seed: null },
    outcomes,
    evaluation,
    executable,
  });
  const validated = report.passed && outcomes.OUT_OF_SAMPLE_VALIDATED.met;
  const to: ResearchExperimentState = validated ? "PAPER" : "REJECTED";
  const validate = {
    reportId: experimentReport.reportId,
    contentHash: experimentReport.contentHash,
    provenance: evaluation.provenance,
    missing: evaluation.missing,
    outOfSampleValidated: outcomes.OUT_OF_SAMPLE_VALIDATED.met,
    programme: { experiments: programme.experiments, tested: programme.tested },
  };
  return {
    kind: "advance",
    to,
    reason: validated ? "Out-of-sample validated; paper-candidate marking needs approval" : `VALIDATION_FAILED: ${outcomes.OUT_OF_SAMPLE_VALIDATED.detail}`,
    evidence: validate,
    contextPatch: { validate },
    sideEffects: async (tx) => {
      await tx.experimentReport.create({
        data: {
          id: experimentReport.reportId,
          hypothesisId: experimentReport.hypothesisId,
          strategyModuleId: experimentReport.strategyModuleId,
          strategyVersion: experimentReport.strategyVersion,
          payload: toJson(experimentReport),
          contentHash: experimentReport.contentHash,
          signature: experimentReport.signature,
          // The loop never approves its own result.
          approvalStatus: "PENDING",
          provenance: evaluation.provenance,
          sourceHash: executable.sourceHash,
          artifactHash: executable.artifactHash,
          configHash: configHashOf(config),
          datasetHash: test.datasetHash as string,
        },
      });
      await writeLifecycle(tx, strategyId, row.id, [
        ["CHALLENGED", validated ? "VALIDATED" : "REJECTED", "VALIDATE", { reportId: experimentReport.reportId, contentHash: experimentReport.contentHash }],
      ]);
    },
  };
}

async function paperStage(env: TickEnv, row: ExperimentRow, gateEvidence: Record<string, unknown>): Promise<StageOutcome> {
  const context = asContext(row.context);
  const strategyId = asContext(context.forge).strategyId;
  const reportId = asContext(context.validate).reportId;
  if (typeof strategyId !== "string" || typeof reportId !== "string") {
    return { kind: "advance", to: "FAILED", reason: "CONTEXT_MISSING: no validated report recorded", evidence: gateEvidence };
  }
  // Research status only: a lifecycle label. No promotion call, no EngineControl or StrategyPromotion write.
  return {
    kind: "advance",
    to: "REVIEW",
    reason: "Research status PAPER_CANDIDATE recorded; operator review required (no promotion performed)",
    evidence: { ...gateEvidence, strategyId, reportId, researchStatus: "PAPER_CANDIDATE" },
    contextPatch: { paper: { researchStatus: "PAPER_CANDIDATE", reportId, approvalId: gateEvidence.approvalId ?? null } },
    sideEffects: (tx) =>
      writeLifecycle(tx, strategyId, row.id, [
        ["VALIDATED", "PAPER_CANDIDATE", RESEARCH_LOOP_ACTOR, { reportId, approvalId: gateEvidence.approvalId ?? null }],
      ]),
  };
}

async function writeLifecycle(
  tx: Tx,
  strategyId: string,
  experimentId: string,
  steps: Array<[from: string, to: string, actor: string, evidence: Record<string, unknown>]>,
): Promise<void> {
  for (const [from, to, actor, evidence] of steps) {
    const transition = transitionLifecycle({
      strategyId,
      from: from as never,
      to: to as never,
      actor,
      evidence: { ...evidence, experimentId, source: "ASCEND-08 research loop" },
    });
    if (!transition.ok) throw new Error(transition.error);
    await tx.lifecycleAudit.create({
      data: {
        id: `${transition.transition.id}_${newId("x").slice(-8)}`,
        strategyId,
        fromState: from,
        toState: to,
        actor,
        evidence: toJson(transition.transition.evidence),
        evidenceHash: transition.transition.evidenceHash,
      },
    });
  }
}

function asContext(value: unknown): Context {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Context) : {};
}

// ---------------------------------------------------------------------------------------------------
// Operator operations (called by the ADMIN API)
// ---------------------------------------------------------------------------------------------------

/** An operator-supplied loop limit is invalid; the API maps this to 400 (never matched by message text). */
export class ResearchLoopLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchLoopLimitError";
  }
}

export async function setResearchLoopControl(prisma: PrismaClient, body: unknown, updatedBy: string) {
  const parsed = researchLoopControlBodySchema.parse(body);
  const current = await readResearchLoopControl(prisma);
  const next = { ...current, ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) };
  if (next.leaseMs < 2 * next.tickRuntimeMs) throw new ResearchLoopLimitError("leaseMs must be at least twice tickRuntimeMs");
  const data = {
    enabled: next.enabled,
    maxExperimentsPerDay: next.maxExperimentsPerDay,
    maxConcurrentExperiments: next.maxConcurrentExperiments,
    maxAttemptsPerExperiment: next.maxAttemptsPerExperiment,
    tickRuntimeMs: next.tickRuntimeMs,
    leaseMs: next.leaseMs,
    updatedBy,
  };
  await prisma.researchLoopControl.upsert({ where: { id: RESEARCH_LOOP_CONTROL_ID }, create: { id: RESEARCH_LOOP_CONTROL_ID, ...data }, update: data });
  return readResearchLoopControl(prisma);
}

export async function researchLoopStatus(prisma: PrismaClient, now: Date = new Date()) {
  const [control, policy, spend, programme, createdToday] = await Promise.all([
    readResearchLoopControl(prisma),
    readAutonomyPolicy(prisma),
    researchSpendToday(prisma, now),
    researchProgrammeCounts(prisma),
    prisma.researchExperiment.count({ where: { createdAt: { gte: researchBudgetWindowStart(now) } } }),
  ]);
  const cap = d(policy.maxResearchBudgetUsd);
  const spent = d(spend.spentUsd);
  return {
    control,
    autonomyLevel: policy.level,
    loopWouldRun: control.enabled && policy.level >= 2 && policy.level <= 3,
    budget: {
      window: "UTC_DAY" as const,
      windowStart: spend.windowStart,
      capUsd: cap.toFixed(4),
      spentUsd: spent.toFixed(8),
      remainingUsd: (spent.gte(cap) ? d("0") : cap.minus(spent)).toFixed(8),
    },
    createdToday,
    programme,
    approvableActions: APPROVABLE_ACTIONS,
  };
}

export async function enqueueResearchExperiment(prisma: PrismaClient, body: unknown, createdBy: string, now: Date = new Date()) {
  const parsed = z.object({ hypothesisId: z.string().min(1) }).strict().parse(body);
  return createResearchExperiments(prisma, { now, createdBy, hypothesisIds: [parsed.hypothesisId] });
}

export async function recordResearchApproval(
  prisma: PrismaClient,
  experimentId: string,
  body: unknown,
  approvedBy: string,
  now: Date = new Date(),
) {
  const parsed = researchApprovalBodySchema.parse(body);
  const experiment = await prisma.researchExperiment.findUnique({ where: { id: experimentId } });
  if (!experiment) return { ok: false as const, error: "EXPERIMENT_NOT_FOUND" };
  // M2: an approval answers a pending request. It is refused before the experiment asks for it,
  // for any other action than the one it is blocked on, and for any subject other than the current one.
  if (experiment.state !== "BLOCKED_APPROVAL" || !experiment.blockedState || !isGatedStage(experiment.blockedState)) {
    return { ok: false as const, error: `APPROVAL_NOT_REQUESTED: experiment is in ${experiment.state}` };
  }
  const requested = GATED_STAGE_ACTIONS[experiment.blockedState];
  if (parsed.action !== requested) {
    return { ok: false as const, error: `ACTION_MISMATCH: experiment awaits ${requested}, not ${parsed.action}` };
  }
  const subject = approvalSubject(experiment, parsed.action);
  if (!subject) return { ok: false as const, error: "SUBJECT_UNAVAILABLE: nothing recorded to approve" };
  if (subject.subjectHash !== parsed.subjectHash) {
    return { ok: false as const, error: `SUBJECT_MISMATCH: current subject is ${subject.subjectHash}` };
  }
  const approval = await prisma.researchApproval.create({
    data: {
      id: newId("rapr"),
      experimentId,
      action: parsed.action,
      approvedBy,
      approvedAt: now,
      expiresAt: new Date(now.getTime() + parsed.ttlMinutes * 60_000),
      subjectHash: subject.subjectHash,
      note: parsed.note ?? null,
    },
  });
  return { ok: true as const, approval };
}

export async function abandonResearchExperiment(prisma: PrismaClient, experimentId: string, body: unknown, actor: string, now: Date = new Date()) {
  const parsed = z.object({ reason: z.string().min(3).max(500) }).strict().parse(body);
  const experiment = await prisma.researchExperiment.findUnique({ where: { id: experimentId } });
  if (!experiment) return { ok: false as const, error: "EXPERIMENT_NOT_FOUND" };
  const check = canTransitionExperiment(experiment.state, "ABANDONED");
  if (!check.ok) return { ok: false as const, error: check.error };
  const evidence = { reason: parsed.reason, at: now.toISOString(), experimentVersion: experiment.version };
  return prisma.$transaction(async (tx) => {
    // Refuses while a live tick holds the lease; the operator retries after it finishes.
    const updated = await tx.researchExperiment.updateMany({
      where: { id: experimentId, version: experiment.version, ...leaseFree(now) },
      data: { state: "ABANDONED", blockedState: null, lastError: `ABANDONED: ${parsed.reason}`, leaseOwner: null, leaseExpiresAt: null, version: { increment: 1 } },
    });
    if (updated.count !== 1) return { ok: false as const, error: "EXPERIMENT_BUSY_OR_CHANGED" };
    await tx.researchExperimentEvent.create({
      data: {
        id: newId("rxev"),
        experimentId,
        kind: "TRANSITION",
        fromState: experiment.state,
        toState: "ABANDONED",
        actor,
        reason: parsed.reason,
        evidence: toJson(evidence),
        evidenceHash: hashEvidence(evidence),
      },
    });
    return { ok: true as const };
  });
}

export async function listResearchExperiments(prisma: PrismaClient) {
  const rows = await prisma.researchExperiment.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map((row) => {
    const context = asContext(row.context);
    const forgeContext = asContext(context.forge);
    return {
      id: row.id,
      hypothesisId: row.hypothesisId,
      state: row.state,
      blockedState: row.blockedState,
      attempts: row.attempts,
      lastError: row.lastError,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      version: row.version,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      strategyId: forgeContext.strategyId ?? null,
      sourceHash: forgeContext.sourceHash ?? null,
      reportId: asContext(context.validate).reportId ?? null,
      approvalRequest:
        row.state === "BLOCKED_APPROVAL" && row.blockedState && isGatedStage(row.blockedState)
          ? { action: GATED_STAGE_ACTIONS[row.blockedState], ...(approvalSubject(row, GATED_STAGE_ACTIONS[row.blockedState]) ?? { subjectHash: null, subject: null }) }
          : null,
    };
  });
}

export async function listResearchExperimentEvents(prisma: PrismaClient, experimentId: string) {
  const [events, approvals] = await Promise.all([
    prisma.researchExperimentEvent.findMany({ where: { experimentId }, orderBy: { createdAt: "asc" } }),
    prisma.researchApproval.findMany({ where: { experimentId }, orderBy: { approvedAt: "asc" } }),
  ]);
  return {
    events: events.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    approvals: approvals.map((row) => ({ ...row, approvedAt: row.approvedAt.toISOString(), expiresAt: row.expiresAt.toISOString() })),
  };
}
