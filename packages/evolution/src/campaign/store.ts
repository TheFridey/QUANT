import { Prisma, toJson, type PrismaClient } from "@odin/shared/db";
import { canonicalJson } from "../genesis/canonical.js";
import { settleTrials } from "./accounting.js";
import type { UnitEvaluation } from "./evaluate.js";
import { campaignVersions, planCampaign, type CampaignSpec, type PlannedUnit } from "./spec.js";
import { campaignTx } from "./tx.js";

/**
 * OPERATION EVIDENCE campaign persistence.
 *
 * Immutable: ResearchCampaign (the declaration), ResearchCampaignRun (one execution), ResearchCampaignResult
 * (evidence), ResearchCampaignEvent (what happened, failures included). Mutable: ResearchCampaignRunState and
 * the execution columns of ResearchCampaignUnit.
 *
 * Retry: the same unit runs again after a failure or a lost lease. It keeps its trial reservation, its frozen
 * `priorTrials` and its unit id, and can store at most one result per phase, so it can neither create a new
 * experiment nor overwrite evidence.
 * Rerun: an explicit new run of the same campaign (`rerun: true`, with a reason). It gets a new run number, new
 * units and new trial reservations; earlier runs and their results stay as they are.
 */

type Tx = Prisma.TransactionClient;

export const TERMINAL_UNIT_STATES = ["SUCCEEDED", "REFUSED", "FAILED", "ABANDONED", "CANCELLED"] as const;
export type UnitState = "PENDING" | "RUNNING" | (typeof TERMINAL_UNIT_STATES)[number];
export type UnitRow = Prisma.ResearchCampaignUnitGetPayload<object>;

export class CampaignError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CampaignError";
  }
}

const isUnique = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

export async function logEvent(db: PrismaClient | Tx, input: { runId: string; unitId?: string | null; kind: string; actor: string; detail?: Record<string, unknown> }): Promise<void> {
  await db.researchCampaignEvent.create({ data: { runId: input.runId, unitId: input.unitId ?? null, kind: input.kind, actor: input.actor, detail: toJson(input.detail ?? {}) } });
}

/** Registers a declaration. The same canonical specification always returns the same campaign. */
export async function createCampaign(prisma: PrismaClient, raw: unknown, createdBy: string) {
  const plan = planCampaign(raw);
  const existing = await prisma.researchCampaign.findUnique({ where: { specHash: plan.specHash } });
  if (existing) return { status: "EXISTS" as const, campaign: existing, plan };
  try {
    const campaign = await prisma.researchCampaign.create({ data: { name: plan.spec.name, specVersion: plan.spec.specVersion, specCanonical: plan.specCanonical, specHash: plan.specHash, synthetic: plan.spec.synthetic, createdBy } });
    return { status: "CREATED" as const, campaign, plan };
  } catch (error) {
    if (!isUnique(error)) throw error;
    const raced = await prisma.researchCampaign.findUniqueOrThrow({ where: { specHash: plan.specHash } });
    return { status: "EXISTS" as const, campaign: raced, plan };
  }
}

export function specOf(campaign: { specCanonical: string }): { spec: CampaignSpec; units: PlannedUnit[] } {
  const plan = planCampaign(JSON.parse(campaign.specCanonical));
  return { spec: plan.spec, units: plan.units };
}

/**
 * Starts a run. Without `rerun`, an existing run is returned unchanged (so concurrent or repeated starts are
 * one run). With `rerun`, a new run number is created and a reason is required. `codeVersion` must be a git
 * commit: results are only reproducible against known code.
 */
export async function startRun(prisma: PrismaClient, input: { campaignId: string; requestedBy: string; codeVersion: string; reason?: string; rerun?: boolean }) {
  if (!/^[a-f0-9]{7,40}$/.test(input.codeVersion)) throw new CampaignError("CODE_VERSION_REQUIRED", `codeVersion must be a git commit hash (got ${JSON.stringify(input.codeVersion)}); commit the working tree or set GIT_COMMIT`);
  if (input.rerun && !input.reason?.trim()) throw new CampaignError("RERUN_REASON_REQUIRED", "an intentional rerun needs a reason");
  const campaign = await prisma.researchCampaign.findUnique({ where: { id: input.campaignId } });
  if (!campaign) throw new CampaignError("NOT_FOUND", `campaign ${input.campaignId}`);
  const { units } = specOf(campaign);
  return campaignTx(prisma, async (tx) => {
    // Serialises starts of one campaign, so two callers cannot both create run 1.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign:${campaign.id}`}))`;
    const latest = await tx.researchCampaignRun.findFirst({ where: { campaignId: campaign.id }, orderBy: { runNumber: "desc" } });
    if (latest && !input.rerun) return { status: "ALREADY_STARTED" as const, run: latest };
    const run = await tx.researchCampaignRun.create({
      data: { campaignId: campaign.id, runNumber: (latest?.runNumber ?? 0) + 1, reason: input.rerun ? input.reason!.trim() : (input.reason?.trim() || "first run"), requestedBy: input.requestedBy, codeVersion: input.codeVersion, versions: toJson(campaignVersions()) },
    });
    await tx.researchCampaignRunState.create({ data: { runId: run.id, state: "QUEUED" } });
    await tx.researchCampaignUnit.createMany({ data: units.map((u) => ({ runId: run.id, seq: u.seq, datasetKey: u.datasetKey, hypothesisKind: u.hypothesisKind, hypothesisId: u.hypothesisId, plannedTrials: u.plannedTrials, unitSpecHash: u.unitSpecHash })) });
    await logEvent(tx, { runId: run.id, kind: input.rerun ? "RERUN_DECLARED" : "RUN_DECLARED", actor: input.requestedBy, detail: { runNumber: run.runNumber, units: units.length, reason: run.reason, codeVersion: run.codeVersion } });
    return { status: "STARTED" as const, run };
  });
}

/**
 * Serialises every state change of one run on its run-state row. Taken as the FIRST statement of each
 * transaction that claims, completes, fails or cancels a unit, so the run state is always recomputed from a
 * consistent view (no write skew under READ COMMITTED), the concurrency limit cannot be overshot, and the
 * lock order is the same everywhere.
 */
export async function lockRun(tx: Tx, runId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "ResearchCampaignRunState" WHERE "runId" = ${runId} FOR UPDATE`;
}

/** Recomputes the run state from its units (inside the caller's transaction, which holds the run lock). */
export async function refreshRunState(tx: Tx, runId: string, now: Date): Promise<string> {
  const [state, groups] = await Promise.all([tx.researchCampaignRunState.findUniqueOrThrow({ where: { runId } }), tx.researchCampaignUnit.groupBy({ by: ["state"], where: { runId }, _count: true })]);
  const count = (s: string) => groups.find((g) => g.state === s)?._count ?? 0;
  const open = count("PENDING") + count("RUNNING");
  let next: string;
  if (open > 0) next = count("RUNNING") > 0 || state.startedAt ? "RUNNING" : "QUEUED";
  else if (state.cancelRequestedAt) next = "CANCELLED";
  else next = count("FAILED") + count("ABANDONED") > 0 ? "COMPLETED_WITH_FAILURES" : "COMPLETED";
  if (next !== state.state || (open === 0 && !state.finishedAt)) {
    await tx.researchCampaignRunState.update({ where: { runId }, data: { state: next, startedAt: state.startedAt ?? (next === "QUEUED" ? null : now), finishedAt: open === 0 ? (state.finishedAt ?? now) : null } });
  }
  return next;
}

export type ClaimResult =
  | { kind: "CLAIMED"; unit: UnitRow; reclaimed: boolean }
  | { kind: "NONE"; reason: "NOTHING_CLAIMABLE" | "CONCURRENCY_LIMIT" | "CANCELLED" };

/**
 * Claims one unit of a run for `owner` until `leaseMs` from now. A unit is claimable when PENDING, or RUNNING
 * with an expired lease (its executor died). The whole decision runs under the run lock, so two executors and
 * duplicate job deliveries cannot both hold a unit and the concurrency limit holds. Each claim increments
 * `attempts`, which is the fencing token of that claim. A unit whose lease expired on its last allowed
 * attempt becomes ABANDONED.
 */
export async function claimUnit(prisma: PrismaClient, input: { runId: string; owner: string; leaseMs: number; now: Date }): Promise<ClaimResult> {
  const run = await prisma.researchCampaignRun.findUniqueOrThrow({ where: { id: input.runId }, include: { campaign: true, state: true } });
  const { spec } = specOf(run.campaign);
  if (run.state?.cancelRequestedAt) {
    await sweepCancelled(prisma, input.runId, input.now, "campaign-runner");
    return { kind: "NONE", reason: "CANCELLED" };
  }
  return campaignTx(prisma, async (tx): Promise<ClaimResult> => {
    await lockRun(tx, input.runId);
    for (;;) {
      const live = await tx.researchCampaignUnit.count({ where: { runId: input.runId, state: "RUNNING", leaseExpiresAt: { gt: input.now } } });
      if (live >= spec.limits.maxConcurrency) return { kind: "NONE", reason: "CONCURRENCY_LIMIT" };
      const candidate = await tx.researchCampaignUnit.findFirst({
        where: { runId: input.runId, OR: [{ state: "PENDING" }, { state: "RUNNING", leaseExpiresAt: { lte: input.now } }] },
        orderBy: { seq: "asc" },
      });
      if (!candidate) {
        await refreshRunState(tx, input.runId, input.now);
        return { kind: "NONE", reason: "NOTHING_CLAIMABLE" };
      }
      const reclaimed = candidate.state === "RUNNING";
      const exhausted = candidate.attempts >= spec.limits.maxAttemptsPerUnit;
      const data = exhausted
        ? { state: "ABANDONED", leaseOwner: null, leaseExpiresAt: null, finishedAt: input.now, lastError: `ABANDONED: ${candidate.attempts} attempt(s) used; last: ${candidate.lastError ?? (reclaimed ? "executor lost its lease" : "unknown")}`.slice(0, 2000), version: { increment: 1 } }
        : { state: "RUNNING", leaseOwner: input.owner, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), attempts: { increment: 1 }, startedAt: candidate.startedAt ?? input.now, version: { increment: 1 } };
      await tx.researchCampaignUnit.update({ where: { id: candidate.id }, data });
      if (reclaimed) await logEvent(tx, { runId: input.runId, unitId: candidate.id, kind: "LEASE_RECLAIMED", actor: input.owner, detail: { previousOwner: candidate.leaseOwner, attempt: candidate.attempts, note: "the previous executor stopped renewing its lease" } });
      await logEvent(tx, { runId: input.runId, unitId: candidate.id, kind: exhausted ? "UNIT_ABANDONED" : "UNIT_CLAIMED", actor: input.owner, detail: { attempt: candidate.attempts + (exhausted ? 0 : 1), maxAttempts: spec.limits.maxAttemptsPerUnit } });
      await refreshRunState(tx, input.runId, input.now);
      if (!exhausted) return { kind: "CLAIMED", unit: await tx.researchCampaignUnit.findUniqueOrThrow({ where: { id: candidate.id } }), reclaimed };
    }
  });
}

export type LeaseCheck = { ok: true; unit: UnitRow; cancelRequested: boolean } | { ok: false; reason: "LEASE_LOST" };

/**
 * Extends a held lease. The claim is identified by its owner and its attempt number, so a renewal whose reply
 * was lost cannot make the holder think it was taken over. Returns LEASE_LOST only when the unit is no longer
 * this claim's (another executor reclaimed it, or it was closed); the caller must then stop.
 */
export async function renewLease(prisma: PrismaClient, input: { unit: UnitRow; owner: string; leaseMs: number; now: Date }): Promise<LeaseCheck> {
  const updated = await prisma.researchCampaignUnit.updateMany({
    where: { id: input.unit.id, leaseOwner: input.owner, attempts: input.unit.attempts, state: "RUNNING" },
    data: { leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), version: { increment: 1 } },
  });
  if (updated.count !== 1) return { ok: false, reason: "LEASE_LOST" };
  const [unit, state] = await Promise.all([prisma.researchCampaignUnit.findUniqueOrThrow({ where: { id: input.unit.id } }), prisma.researchCampaignRunState.findUnique({ where: { runId: input.unit.runId } })]);
  return { ok: true, unit, cancelRequested: Boolean(state?.cancelRequestedAt) };
}

const resultData = (unitId: string, e: UnitEvaluation, metrics: { runtimeMs: number; peakRssMb: number }) => ({
  unitId,
  phase: e.phase,
  verdict: e.verdict,
  reasons: e.reasons,
  walkForwardPassed: e.walkForwardPassed,
  holdoutStatus: e.holdoutStatus,
  trialCount: e.trialCount,
  priorTrials: e.priorTrials,
  dataset: toJson(e.dataset),
  provenance: toJson(e.provenance),
  summary: toJson(e.summary),
  detailCanonical: canonicalJson(e.detail),
  resultHash: e.resultHash,
  runtimeMs: Math.round(metrics.runtimeMs),
  peakRssMb: metrics.peakRssMb,
});

export type CompleteOutcome = { status: "RECORDED" | "ALREADY_RECORDED" | "LEASE_LOST"; state?: string };

/**
 * Stores a unit's walk-forward (or data-refusal) result, settles its trial reservation and closes the unit,
 * in one transaction fenced by the lease. A result that already exists is left untouched.
 */
export async function completeUnit(prisma: PrismaClient, input: { unit: UnitRow; owner: string; evaluation: UnitEvaluation; reserved: boolean; metrics: { runtimeMs: number; peakRssMb: number }; now: Date }): Promise<CompleteOutcome> {
  const { unit, evaluation: e } = input;
  if (e.phase === "HOLDOUT") throw new CampaignError("WRONG_PHASE", "holdout results are recorded through the holdout ledger");
  const state: UnitState = e.phase === "DATA_REFUSAL" ? "REFUSED" : "SUCCEEDED";
  return campaignTx(prisma, async (tx) => {
    await lockRun(tx, unit.runId);
    const fenced = await tx.researchCampaignUnit.updateMany({
      where: { id: unit.id, leaseOwner: input.owner, attempts: unit.attempts, state: "RUNNING" },
      data: { state, leaseOwner: null, leaseExpiresAt: null, finishedAt: input.now, lastError: null, version: { increment: 1 } },
    });
    if (fenced.count !== 1) return { status: "LEASE_LOST" as const };
    const existing = await tx.researchCampaignResult.findFirst({ where: { unitId: unit.id, phase: { in: ["WALK_FORWARD", "DATA_REFUSAL"] } }, select: { id: true, resultHash: true } });
    if (existing) {
      await logEvent(tx, { runId: unit.runId, unitId: unit.id, kind: "DUPLICATE_RESULT_IGNORED", actor: input.owner, detail: { kept: existing.resultHash, offered: e.resultHash, identical: existing.resultHash === e.resultHash } });
      await refreshRunState(tx, unit.runId, input.now);
      return { status: "ALREADY_RECORDED" as const, state };
    }
    await tx.researchCampaignResult.create({ data: resultData(unit.id, e, input.metrics) });
    // A refusal before any trial ran holds no reservation; one after trials started settles at what ran.
    if (input.reserved) await settleTrials(tx, { unitId: unit.id, actual: e.trialCount, actor: input.owner });
    await logEvent(tx, { runId: unit.runId, unitId: unit.id, kind: state === "REFUSED" ? "UNIT_REFUSED" : "UNIT_SUCCEEDED", actor: input.owner, detail: { verdict: e.verdict, reasons: e.reasons.slice(0, 5), trialCount: e.trialCount, resultHash: e.resultHash, runtimeMs: Math.round(input.metrics.runtimeMs), peakRssMb: input.metrics.peakRssMb } });
    await refreshRunState(tx, unit.runId, input.now);
    return { status: "RECORDED" as const, state };
  });
}

/** Stores the holdout-phase result (called by the holdout ledger inside its closing transaction). */
export async function insertHoldoutResult(tx: Tx, unitId: string, e: UnitEvaluation, metrics: { runtimeMs: number; peakRssMb: number }): Promise<void> {
  await tx.researchCampaignResult.create({ data: resultData(unitId, e, metrics) });
}

/**
 * Records a failed attempt (the error is kept in the event log). The unit returns to PENDING for a retry, or
 * becomes FAILED when its attempts are used up or the failure cannot be retried. Its trial reservation stays.
 */
export async function failUnit(prisma: PrismaClient, input: { unit: UnitRow; owner: string; error: string; retryable: boolean; maxAttempts: number; now: Date; resources?: Record<string, unknown> }): Promise<{ status: "RETRY" | "FAILED" | "LEASE_LOST" }> {
  const terminal = !input.retryable || input.unit.attempts >= input.maxAttempts;
  return campaignTx(prisma, async (tx) => {
    await lockRun(tx, input.unit.runId);
    const fenced = await tx.researchCampaignUnit.updateMany({
      where: { id: input.unit.id, leaseOwner: input.owner, attempts: input.unit.attempts, state: "RUNNING" },
      data: { state: terminal ? "FAILED" : "PENDING", leaseOwner: null, leaseExpiresAt: null, lastError: input.error.slice(0, 2000), finishedAt: terminal ? input.now : null, version: { increment: 1 } },
    });
    if (fenced.count !== 1) return { status: "LEASE_LOST" as const };
    await logEvent(tx, { runId: input.unit.runId, unitId: input.unit.id, kind: terminal ? "UNIT_FAILED" : "UNIT_ATTEMPT_FAILED", actor: input.owner, detail: { attempt: input.unit.attempts, error: input.error.slice(0, 4000), retryable: input.retryable, ...(input.resources ?? {}) } });
    await refreshRunState(tx, input.unit.runId, input.now);
    return { status: terminal ? ("FAILED" as const) : ("RETRY" as const) };
  });
}

/** Closes a unit as CANCELLED (its executor saw the cancellation). A reservation, if any, stays counted. */
export async function cancelHeldUnit(prisma: PrismaClient, input: { unit: UnitRow; owner: string; now: Date }): Promise<void> {
  await campaignTx(prisma, async (tx) => {
    await lockRun(tx, input.unit.runId);
    const fenced = await tx.researchCampaignUnit.updateMany({ where: { id: input.unit.id, leaseOwner: input.owner, attempts: input.unit.attempts, state: "RUNNING" }, data: { state: "CANCELLED", leaseOwner: null, leaseExpiresAt: null, finishedAt: input.now, lastError: "CANCELLED while running", version: { increment: 1 } } });
    if (fenced.count !== 1) return;
    await logEvent(tx, { runId: input.unit.runId, unitId: input.unit.id, kind: "UNIT_CANCELLED", actor: input.owner, detail: { whileRunning: true } });
    await refreshRunState(tx, input.unit.runId, input.now);
  });
}

async function sweepCancelled(prisma: PrismaClient, runId: string, now: Date, actor: string): Promise<number> {
  return campaignTx(prisma, async (tx) => {
    await lockRun(tx, runId);
    // PENDING units never started; RUNNING units whose lease expired have no executor left to stop.
    const open = await tx.researchCampaignUnit.findMany({ where: { runId, OR: [{ state: "PENDING" }, { state: "RUNNING", leaseExpiresAt: { lte: now } }] }, select: { id: true, version: true, state: true } });
    let n = 0;
    for (const u of open) {
      const done = await tx.researchCampaignUnit.updateMany({ where: { id: u.id, version: u.version }, data: { state: "CANCELLED", leaseOwner: null, leaseExpiresAt: null, finishedAt: now, lastError: u.state === "PENDING" ? "CANCELLED before starting" : "CANCELLED after its executor stopped", version: { increment: 1 } } });
      if (done.count === 1) {
        n += 1;
        await logEvent(tx, { runId, unitId: u.id, kind: "UNIT_CANCELLED", actor, detail: { whileRunning: u.state === "RUNNING" } });
      }
    }
    await refreshRunState(tx, runId, now);
    return n;
  });
}

/** Requests cancellation. Idempotent; pending units close at once, running units when their executor next checks. */
export async function cancelRun(prisma: PrismaClient, input: { runId: string; actor: string; now: Date }) {
  const state = await prisma.researchCampaignRunState.findUnique({ where: { runId: input.runId } });
  if (!state) throw new CampaignError("NOT_FOUND", `run ${input.runId}`);
  // A finished run has nothing left to cancel; marking it cancelled would misdescribe completed evidence.
  if (state.finishedAt && !state.cancelRequestedAt) return { cancelled: 0, state: state.state };
  if (!state.cancelRequestedAt) {
    const set = await prisma.researchCampaignRunState.updateMany({ where: { runId: input.runId, cancelRequestedAt: null }, data: { cancelRequestedAt: input.now, cancelRequestedBy: input.actor } });
    if (set.count === 1) await logEvent(prisma, { runId: input.runId, kind: "CANCEL_REQUESTED", actor: input.actor });
  }
  const cancelled = await sweepCancelled(prisma, input.runId, input.now, input.actor);
  return { cancelled, state: (await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: input.runId } })).state };
}
