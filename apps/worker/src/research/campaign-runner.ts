import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  beginHoldout,
  CampaignError,
  cancelHeldUnit,
  claimUnit,
  completeUnit,
  evaluateUnit,
  failUnit,
  holdoutContext,
  logEvent,
  preflightDataset,
  recordHoldoutLost,
  recordHoldoutResult,
  renewLease,
  reserveTrials,
  specOf,
  type CampaignSpec,
  type PlannedUnit,
  type RawBars,
  type UnitEvaluation,
  type UnitJob,
  type UnitRow,
} from "@odin/evolution/campaign";
import type { PrismaClient } from "@odin/shared/db";
import { DatasetLoadError, loadRawBars } from "./campaign-data.js";

/**
 * Campaign supervisor. It claims units under a database lease, loads and preflights the declared data, reserves
 * the unit's trials, runs the deterministic evaluation in a separate process with a runtime and a memory limit,
 * and stores the result. It runs in the campaign CLI process, never inside the trading worker's event loop.
 */

export type EvaluatorLimits = { maxRuntimeMs: number; maxMemoryMb: number };
export type EvaluatorResult = { evaluation: UnitEvaluation; runtimeMs: number; peakRssMb: number };
export class EvaluatorFailure extends Error {
  constructor(public readonly kind: "RUNTIME_LIMIT" | "CRASHED" | "ERROR" | "KILLED", message: string) {
    super(`${kind}: ${message}`);
    this.name = "EvaluatorFailure";
  }
}
/** Runs one job. `signal` aborts it (cancellation or a lost lease). */
export type Evaluator = (job: UnitJob, limits: EvaluatorLimits, signal: AbortSignal) => Promise<EvaluatorResult>;

/** The supported evaluator: a child process with no database, no network, a heap limit and a kill timer. */
export const childProcessEvaluator: Evaluator = (job, limits, signal) =>
  new Promise<EvaluatorResult>((resolvePromise, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "odin-campaign-"));
    const jobPath = join(dir, "job.json");
    const outPath = join(dir, "out.json");
    writeFileSync(jobPath, JSON.stringify(job));
    const child = spawn(process.execPath, [`--max-old-space-size=${limits.maxMemoryMb}`, resolve(__dirname, "campaign-evaluator.js"), jobPath, outPath], { stdio: ["ignore", "ignore", "pipe"], env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: process.env.PATH ?? "" } });
    let stderr = "";
    let why: EvaluatorFailure | null = null;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      why = new EvaluatorFailure("RUNTIME_LIMIT", `evaluation exceeded ${limits.maxRuntimeMs} ms and was stopped`);
      child.kill("SIGKILL");
    }, limits.maxRuntimeMs);
    const onAbort = () => {
      why = new EvaluatorFailure("KILLED", String(signal.reason ?? "aborted"));
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        fn();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    child.on("error", (error) => done(() => reject(new EvaluatorFailure("CRASHED", error.message))));
    child.on("exit", (code, sig) =>
      done(() => {
        if (why) return reject(why);
        if (code !== 0) return reject(new EvaluatorFailure("CRASHED", `evaluator exited with ${sig ?? `code ${code}`} (memory limit ${limits.maxMemoryMb} MB); ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
        let out: { ok: boolean; evaluation?: UnitEvaluation; error?: string; runtimeMs: number; peakRssMb: number };
        try {
          out = JSON.parse(readFileSync(outPath, "utf8")) as typeof out;
        } catch {
          return reject(new EvaluatorFailure("CRASHED", "evaluator wrote no result"));
        }
        if (!out.ok || !out.evaluation) return reject(new EvaluatorFailure("ERROR", out.error ?? "unknown evaluation error"));
        resolvePromise({ evaluation: out.evaluation, runtimeMs: out.runtimeMs, peakRssMb: out.peakRssMb });
      }),
    );
  });

/** The git commit of the running code: GIT_COMMIT, else HEAD of a clean checkout. Null when it cannot be pinned. */
export function currentCodeVersion(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  if (env.GIT_COMMIT && /^[a-f0-9]{7,40}$/.test(env.GIT_COMMIT)) return env.GIT_COMMIT;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[a-f0-9]{40}$/.test(head) && dirty === "" ? head : null;
  } catch {
    return null;
  }
}

export type RunnerDeps = {
  owner: string;
  /** Directory relative FILE dataset paths resolve against. */
  baseDir: string;
  codeVersion: string | null;
  evaluator?: Evaluator;
  leaseMs?: number;
  now?: () => Date;
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

export type UnitOutcome = { unitId: string; seq: number; outcome: "SUCCEEDED" | "REFUSED" | "RETRY" | "FAILED" | "CANCELLED" | "LEASE_LOST" | "ALREADY_RECORDED"; detail: string };

function jobFor(spec: CampaignSpec, planned: PlannedUnit, raw: RawBars, codeVersion: string, priorTrials: number, mode: UnitJob["mode"], expectedWalkForwardHash?: string): UnitJob {
  const dataset = spec.datasets.find((d) => d.key === planned.datasetKey)!;
  return { mode, unit: { hypothesisKind: planned.hypothesisKind, hypothesisId: planned.hypothesisId, horizonBars: planned.horizonBars, searchSpace: planned.searchSpace, searchSpaceHash: planned.searchSpaceHash, lineageKey: planned.lineageKey }, dataset, validation: spec.validation, ml: spec.ml, codeVersion, priorTrials, raw, expectedWalkForwardHash };
}

/**
 * Works a run: claims and executes units one at a time until none is claimable or `maxUnits` were handled.
 * Safe to call from several processes and to call again after a crash: leases decide who holds a unit.
 */
export async function workRun(prisma: PrismaClient, runId: string, deps: RunnerDeps, options: { maxUnits?: number } = {}): Promise<{ handled: UnitOutcome[]; stopped: string }> {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? 60_000;
  const evaluator = deps.evaluator ?? childProcessEvaluator;
  const run = await prisma.researchCampaignRun.findUnique({ where: { id: runId }, include: { campaign: true } });
  if (!run) throw new CampaignError("NOT_FOUND", `run ${runId}`);
  // Checked before anything is claimed, so an executor on other code changes nothing.
  if (deps.codeVersion !== run.codeVersion) throw new CampaignError("CODE_VERSION_MISMATCH", `run ${runId} is pinned to ${run.codeVersion}; this process runs ${deps.codeVersion ?? "unpinned code"}. Check out that commit, or start an intentional rerun`);
  const { spec, units: plan } = specOf(run.campaign);
  const handled: UnitOutcome[] = [];
  const rawCache = new Map<string, RawBars>();
  for (;;) {
    if (options.maxUnits !== undefined && handled.length >= options.maxUnits) return { handled, stopped: "MAX_UNITS" };
    const claim = await claimUnit(prisma, { runId, owner: deps.owner, leaseMs, now: now() });
    if (claim.kind === "NONE") return { handled, stopped: claim.reason };
    let unit: UnitRow = claim.unit;
    const planned = plan.find((p) => p.seq === unit.seq)!;
    const dataset = spec.datasets.find((d) => d.key === planned.datasetKey)!;
    const push = (outcome: UnitOutcome["outcome"], detail: string) => {
      handled.push({ unitId: unit.id, seq: unit.seq, outcome, detail });
      deps.log?.(`unit ${unit.seq} ${planned.datasetKey}/${planned.hypothesisId}: ${outcome}`, { detail });
    };
    const fail = async (error: string, retryable: boolean, resources?: Record<string, unknown>) => {
      const r = await failUnit(prisma, { unit, owner: deps.owner, error, retryable, maxAttempts: spec.limits.maxAttemptsPerUnit, now: now(), resources });
      push(r.status, error);
    };

    // 1. Declared data, loaded once per dataset and process. Nothing expensive has run yet.
    let raw = rawCache.get(dataset.key);
    if (!raw) {
      try {
        raw = await loadRawBars(prisma, dataset, deps.baseDir);
        rawCache.set(dataset.key, raw);
      } catch (error) {
        // A missing or different file is not a transient condition: retrying would evaluate other data.
        await fail(error instanceof Error ? error.message : String(error), !(error instanceof DatasetLoadError));
        continue;
      }
    }
    // 2. Preflight in this process (cheap). A refusal is a result: stored, with its reasons, and no trial is counted.
    const pre = preflightDataset(dataset, raw);
    if (!pre.ok) {
      const evaluation = evaluateUnit(jobFor(spec, planned, raw, run.codeVersion, 0, "WALK_FORWARD"));
      const done = await completeUnit(prisma, { unit, owner: deps.owner, evaluation, reserved: false, metrics: { runtimeMs: 0, peakRssMb: 0 }, now: now() });
      push(done.status === "LEASE_LOST" ? "LEASE_LOST" : "REFUSED", pre.reasons.join("; "));
      continue;
    }
    // 3. The first unit of a dataset pins its content for the run; a later unit or retry must see the same bars.
    const pins = await prisma.researchCampaignEvent.findMany({ where: { runId, kind: "DATASET_PINNED" }, select: { detail: true } });
    const pinned = pins.map((p) => p.detail as { datasetKey?: string; contentHash?: string }).find((d) => d.datasetKey === dataset.key);
    if (!pinned) await logEvent(prisma, { runId, unitId: unit.id, kind: "DATASET_PINNED", actor: deps.owner, detail: { datasetKey: dataset.key, contentHash: pre.identity.contentHash, bars: pre.identity.bars, firstT: pre.identity.firstT, lastT: pre.identity.lastT } });
    else if (pinned.contentHash !== pre.identity.contentHash) {
      await fail(`DATASET_CHANGED: ${dataset.key} now hashes to ${pre.identity.contentHash.slice(0, 16)}, but this run pinned ${String(pinned.contentHash).slice(0, 16)}; the run cannot mix datasets. Start an intentional rerun`, false);
      continue;
    }
    // 4. Trials are reserved, and committed, before the first one runs. A retry finds its own reservation.
    const reservation = await reserveTrials(prisma, { unitId: unit.id, runId, planned: planned.plannedTrials, maxTrials: spec.limits.maxTrials, actor: deps.owner });
    if (reservation.status === "REFUSED") {
      await fail(reservation.reason, false);
      continue;
    }
    // 5. Evaluate in a separate process, renewing the lease and watching for cancellation.
    const abort = new AbortController();
    let leaseLost = false;
    let cancelled = false;
    let beating = false;
    const heartbeat = setInterval(() => {
      if (beating) return;
      beating = true;
      void renewLease(prisma, { unit, owner: deps.owner, leaseMs, now: now() })
        .then((check) => {
          if (!check.ok) {
            leaseLost = true;
            abort.abort("lease lost to another executor");
          } else {
            unit = check.unit;
            if (check.cancelRequested) {
              cancelled = true;
              abort.abort("run cancelled");
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          beating = false;
        });
    }, Math.max(1_000, Math.floor(leaseMs / 4)));
    let result: EvaluatorResult | null = null;
    let failure: EvaluatorFailure | Error | null = null;
    try {
      result = await evaluator(jobFor(spec, planned, raw, run.codeVersion, reservation.priorTrials, "WALK_FORWARD"), { maxRuntimeMs: spec.limits.maxRuntimeMsPerUnit, maxMemoryMb: spec.limits.maxMemoryMbPerUnit }, abort.signal);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearInterval(heartbeat);
      // Let an in-flight renewal finish so `unit.version` is current before the fenced write below.
      for (let i = 0; i < 100 && beating; i += 1) await new Promise((r) => setTimeout(r, 20));
    }
    if (leaseLost) {
      push("LEASE_LOST", "another executor took the unit over; nothing was written by this one");
      continue;
    }
    if (cancelled) {
      await cancelHeldUnit(prisma, { unit, owner: deps.owner, now: now() });
      push("CANCELLED", "run cancelled while the unit was running; its trial reservation stays counted");
      continue;
    }
    if (!result) {
      const kind = failure instanceof EvaluatorFailure ? failure.kind : "ERROR";
      // A crash may be transient; a runtime limit or an evaluation error repeats deterministically.
      await fail(failure?.message ?? "evaluation failed", kind === "CRASHED", { limits: spec.limits });
      continue;
    }
    const done = await completeUnit(prisma, { unit, owner: deps.owner, evaluation: result.evaluation, reserved: true, metrics: { runtimeMs: result.runtimeMs, peakRssMb: result.peakRssMb }, now: now() });
    push(done.status === "LEASE_LOST" ? "LEASE_LOST" : done.status === "ALREADY_RECORDED" ? "ALREADY_RECORDED" : result.evaluation.phase === "DATA_REFUSAL" ? "REFUSED" : "SUCCEEDED", `${result.evaluation.verdict}: ${result.evaluation.reasons[0] ?? ""}`);
  }
}

/**
 * Evaluates one authorised holdout, once. The consume intent is committed before the evaluator starts; if the
 * evaluation then fails for any reason the result is recorded as lost and is never recomputed.
 */
export async function evaluateHoldout(prisma: PrismaClient, unitId: string, deps: RunnerDeps): Promise<{ status: string; verdict?: string; reasons?: string[] }> {
  const evaluator = deps.evaluator ?? childProcessEvaluator;
  const unit = await prisma.researchCampaignUnit.findUnique({ where: { id: unitId }, include: { run: { include: { campaign: true } } } });
  if (!unit) throw new CampaignError("NOT_FOUND", `unit ${unitId}`);
  if (deps.codeVersion !== unit.run.codeVersion) throw new CampaignError("CODE_VERSION_MISMATCH", `the run is pinned to ${unit.run.codeVersion}; this process runs ${deps.codeVersion ?? "unpinned code"}`);
  const { spec, units: plan } = specOf(unit.run.campaign);
  const planned = plan.find((p) => p.seq === unit.seq)!;
  const dataset = spec.datasets.find((d) => d.key === planned.datasetKey)!;
  // Loaded and checked before the intent, so an unreadable or changed dataset costs no holdout.
  const raw = await loadRawBars(prisma, dataset, deps.baseDir);
  const pre = preflightDataset(dataset, raw);
  const begin = await beginHoldoutChecked(prisma, unitId, deps.owner, pre.ok ? pre.identity.contentHash : null, deps.now?.());
  if (begin.status !== "INTENT_COMMITTED") return { status: begin.status };
  try {
    const result = await evaluator(jobFor(spec, planned, raw, unit.run.codeVersion, begin.context.priorTrials, "HOLDOUT", begin.context.walkForwardHash), { maxRuntimeMs: spec.limits.maxRuntimeMsPerUnit, maxMemoryMb: spec.limits.maxMemoryMbPerUnit }, new AbortController().signal);
    const stored = await recordHoldoutResult(prisma, { unitId, actor: deps.owner, evaluation: result.evaluation, metrics: { runtimeMs: result.runtimeMs, peakRssMb: result.peakRssMb } });
    return { status: stored, verdict: result.evaluation.verdict, reasons: result.evaluation.reasons };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const closed = await recordHoldoutLost(prisma, { unitId, actor: deps.owner, why });
    return { status: closed, reasons: [why] };
  }
}

async function beginHoldoutChecked(prisma: PrismaClient, unitId: string, actor: string, contentHash: string | null, now?: Date) {
  const context = await holdoutContext(prisma, unitId);
  if (contentHash !== context.datasetHash) throw new CampaignError("DATASET_CHANGED", `the dataset no longer matches the walk-forward result (${contentHash?.slice(0, 16) ?? "refused"} vs ${context.datasetHash.slice(0, 16)}); the holdout was not read`);
  return beginHoldout(prisma, { unitId, actor, now });
}
