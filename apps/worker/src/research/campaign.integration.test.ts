import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeHoldout,
  barsToCsv,
  beginHoldout,
  cancelRun,
  claimUnit,
  completeUnit,
  createCampaign,
  evaluateUnit,
  programmeTrials,
  reserveTrials,
  specOf,
  startRun,
  syntheticFxBreakoutBars,
  type UnitJob,
} from "@odin/evolution/campaign";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRawBars } from "./campaign-data.js";
import { EvaluatorFailure, evaluateHoldout, workRun, type Evaluator, type RunnerDeps } from "./campaign-runner.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/**
 * OPERATION EVIDENCE campaigns against Postgres. Every campaign here is SYNTHETIC (constructed fixtures).
 * Expected values are stated from the rules (one result per unit, reservation before trials, one holdout read),
 * not read back from the implementation.
 */
const CODE = "abc1234";
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const dir = mkdtempSync(join(tmpdir(), "odin-campaign-it-"));
/** The holdout ledger is append-only and remembers every read, so each test run uses its own instrument names. */
const TAG = suffix.toUpperCase();
const EUR = `EUR/X${TAG}`;

function writeCsv(name: string, text: string) {
  writeFileSync(join(dir, name), text);
  return { path: name, sha256: createHash("sha256").update(text).digest("hex") };
}

/**
 * A deliberately strong planted pattern. The programme trial count in a shared test database only ever grows
 * (the ledger is append-only), and a weak pattern stops clearing the deflated-Sharpe bar after a few thousand
 * trials. This one still passes at a million. If these tests ever start failing on "should leave a family
 * pending", the test database has outgrown the fixture: recreate it.
 */
const PLANT = { every: 30, jump: 8, drift: 1.5, len: 12 };
const planted = barsToCsv(syntheticFxBreakoutBars({ start: "2024-06-02T22:00:00Z", bars: 4000, seed: 42, plant: PLANT }));
const noise = barsToCsv(syntheticFxBreakoutBars({ start: "2024-06-02T22:00:00Z", bars: 3000, seed: 7, plant: null }));
const plantedFile = writeCsv("planted.csv", planted);
const noiseFile = writeCsv("noise.csv", noise);

const ALL_STRATEGIES = ["hz_atr_breakout", "hz_vol_expansion", "hz_mtf_trend", "hz_vol_mean_reversion", "hz_regime_breakout", "hz_session_breakout"];

function spec(name: string, over: { datasets?: unknown[]; strategies?: string[]; limits?: Record<string, number>; instrument?: string; file?: { path: string; sha256: string } } = {}) {
  return {
    specVersion: "campaign-spec-1",
    name: `${name} ${suffix}`,
    synthetic: true,
    datasets: over.datasets ?? [{ key: "planted", source: { kind: "FILE", ...(over.file ?? plantedFile) }, market: "FX", instrument: over.instrument ?? EUR, interval: "1h", asOf: "2026-01-01T00:00:00Z" }],
    hypotheses: (over.strategies ?? ["hz_atr_breakout"]).map((id) => ({ kind: "STRATEGY", id })),
    validation: { seed: 1 },
    ml: { seed: 1 },
    limits: { maxTrials: 5000, maxRuntimeMsPerUnit: 120_000, maxMemoryMbPerUnit: 1024, maxConcurrency: 2, maxAttemptsPerUnit: 3, ...(over.limits ?? {}) },
    holdoutPolicy: "WITHHELD_UNLESS_AUTHORIZED",
  };
}

describe.skipIf(!enabled)("research campaigns (Postgres, synthetic fixtures)", () => {
  let prisma: PrismaClient;
  let calls = 0;
  /** Evaluations that read a holdout. */
  let holdoutReads = 0;
  const inProcess: Evaluator = async (job) => {
    calls += 1;
    if (job.mode === "HOLDOUT") holdoutReads += 1;
    const started = Date.now();
    return { evaluation: evaluateUnit(job), runtimeMs: Date.now() - started, peakRssMb: 1 };
  };
  const deps = (owner: string, over: Partial<RunnerDeps> = {}): RunnerDeps => ({ owner, baseDir: dir, codeVersion: CODE, evaluator: inProcess, ...over });
  const declare = async (raw: unknown, rerun?: { reason: string }) => {
    const { campaign } = await createCampaign(prisma, raw, "it");
    const { run } = await startRun(prisma, { campaignId: campaign.id, requestedBy: "it", codeVersion: CODE, ...(rerun ? { rerun: true, reason: rerun.reason } : {}) });
    return { campaign, run };
  };
  const unitsOf = (runId: string) => prisma.researchCampaignUnit.findMany({ where: { runId }, orderBy: { seq: "asc" }, include: { results: true } });
  const trading = async () => {
    const [orders, intents, fills, ledger] = await Promise.all([prisma.order.count(), prisma.tradeIntent.count(), prisma.fill.count(), prisma.ledgerEntry.count()]);
    const engine = await prisma.engineControl.findMany({ orderBy: { id: "asc" } });
    const instances = await prisma.strategyInstance.findMany({ orderBy: { id: "asc" } });
    return JSON.stringify({ orders, intents, fills, ledger, engine, instances });
  };
  let tradingBefore = "";
  /** A unit that passed walk-forward on the planted fixture (shared by the holdout tests). */
  let passed: { unitId: string; strategy: string; runId: string };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    tradingBefore = await trading();
  }, 120_000);

  afterAll(async () => {
    // Nothing on the trading path was created or changed by any campaign in this file.
    expect(await trading()).toBe(tradingBefore);
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("a declaration is one campaign, concurrent starts are one run, and a rerun is a new run with a reason", async () => {
    const raw = spec("identity");
    const a = await createCampaign(prisma, raw, "it");
    const b = await createCampaign(prisma, JSON.parse(JSON.stringify(raw)), "someone-else");
    expect(a.status).toBe("CREATED");
    expect(b.status).toBe("EXISTS");
    expect(b.campaign.id).toBe(a.campaign.id);

    const starts = await Promise.all(Array.from({ length: 6 }, () => startRun(prisma, { campaignId: a.campaign.id, requestedBy: "it", codeVersion: CODE })));
    expect(starts.filter((s) => s.status === "STARTED")).toHaveLength(1);
    expect(new Set(starts.map((s) => s.run.id)).size).toBe(1);
    expect(await prisma.researchCampaignRun.count({ where: { campaignId: a.campaign.id } })).toBe(1);

    await expect(startRun(prisma, { campaignId: a.campaign.id, requestedBy: "it", codeVersion: CODE, rerun: true })).rejects.toThrow(/RERUN_REASON_REQUIRED/);
    await expect(startRun(prisma, { campaignId: a.campaign.id, requestedBy: "it", codeVersion: "unknown" })).rejects.toThrow(/CODE_VERSION_REQUIRED/);
    const rerun = await startRun(prisma, { campaignId: a.campaign.id, requestedBy: "it", codeVersion: CODE, rerun: true, reason: "check reproducibility" });
    expect(rerun.status).toBe("STARTED");
    expect(rerun.run.runNumber).toBe(2);

    // The declaration and the run are immutable in the database itself.
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchCampaign" SET "name" = 'x' WHERE "id" = $1`, a.campaign.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchCampaignRun" WHERE "campaignId" = $1`, a.campaign.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchCampaignUnit" SET "plannedTrials" = 1 WHERE "runId" = $1`, rerun.run.id)).rejects.toThrow(/identity is immutable/);
  });

  it("refuses to work a run under different code and changes nothing", async () => {
    const { run } = await declare(spec("code pin"));
    await expect(workRun(prisma, run.id, deps("w", { codeVersion: "def5678" }))).rejects.toThrow(/CODE_VERSION_MISMATCH/);
    await expect(workRun(prisma, run.id, deps("w", { codeVersion: null }))).rejects.toThrow(/CODE_VERSION_MISMATCH/);
    expect((await unitsOf(run.id)).every((u) => u.state === "PENDING" && u.attempts === 0)).toBe(true);
  });

  it("runs every hypothesis once, keeps rejected ones with their reasons, withholds every holdout, and replays to the same hash", async () => {
    const before = await programmeTrials(prisma);
    const { run } = await declare(spec("full", { datasets: [
      { key: "planted", source: { kind: "FILE", ...plantedFile }, market: "FX", instrument: EUR, interval: "1h", asOf: "2026-01-01T00:00:00Z" },
      { key: "noise", source: { kind: "FILE", ...noiseFile }, market: "FX", instrument: "GBP/USD", interval: "1h", asOf: "2026-01-01T00:00:00Z" },
    ], strategies: ALL_STRATEGIES, limits: { maxConcurrency: 1 } }));
    const out = await workRun(prisma, run.id, deps("worker-a"));
    expect(out.stopped).toBe("NOTHING_CLAIMABLE");
    const units = await unitsOf(run.id);
    expect(units).toHaveLength(12);
    expect(units.every((u) => u.state === "SUCCEEDED" && u.attempts === 1 && u.results.length === 1)).toBe(true);
    expect((await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: run.id } })).state).toBe("COMPLETED");

    // Default operation never reads a holdout.
    expect(units.every((u) => ["NOT_REACHED", "WITHHELD"].includes(u.results[0]!.holdoutStatus))).toBe(true);
    expect(await prisma.researchHoldoutLedger.count({ where: { unitId: { in: units.map((u) => u.id) } } })).toBe(0);
    // The planted edge is found by at least one family; noise passes nothing; every rejection carries a reason.
    const plantedPass = units.filter((u) => u.datasetKey === "planted" && u.results[0]!.walkForwardPassed);
    expect(plantedPass.length).toBeGreaterThan(0);
    expect(units.filter((u) => u.datasetKey === "noise" && u.results[0]!.walkForwardPassed)).toHaveLength(0);
    for (const u of units.filter((x) => !x.results[0]!.walkForwardPassed)) expect(u.results[0]!.reasons.length).toBeGreaterThan(0);
    for (const u of plantedPass) expect(u.results[0]!.verdict).toBe("INSUFFICIENT_EVIDENCE"); // pending holdout is not a candidate
    passed = { unitId: plantedPass[0]!.id, strategy: plantedPass[0]!.hypothesisId, runId: run.id };

    // Programme count rose by exactly the trials that ran; nothing is left outstanding.
    const ran = units.reduce((n, u) => n + u.results[0]!.trialCount, 0);
    const after = await programmeTrials(prisma);
    expect(after.total - before.total).toBe(ran);
    expect(after.campaignOutstanding).toBe(before.campaignOutstanding);
    // Each unit is deflated by everything outside the run plus every OTHER unit of the run at its planned
    // bound: the same number whatever order the units ran in.
    const runPlanned = units.reduce((n, u) => n + u.plannedTrials, 0);
    for (const u of units) expect(u.results[0]!.priorTrials).toBe(before.total + runPlanned - u.plannedTrials);

    // Deterministic replay: the stored inputs (declaration, file hash, frozen prior trials) reproduce the stored hash.
    const { spec: stored, units: plan } = specOf(await prisma.researchCampaign.findFirstOrThrow({ where: { runs: { some: { id: run.id } } } }));
    for (const u of [units[0]!, units[7]!]) {
      const p = plan.find((x) => x.seq === u.seq)!;
      const dataset = stored.datasets.find((d) => d.key === p.datasetKey)!;
      const raw = await loadRawBars(prisma, dataset, dir);
      const job: UnitJob = { mode: "WALK_FORWARD", unit: p, dataset, validation: stored.validation, ml: stored.ml, codeVersion: CODE, priorTrials: u.results[0]!.priorTrials, raw };
      expect(evaluateUnit(job).resultHash).toBe(u.results[0]!.resultHash);
      // A different programme history is a different result (the deflation changes), so the hash moves with it.
      expect(evaluateUnit({ ...job, priorTrials: u.results[0]!.priorTrials + 1 }).resultHash).not.toBe(u.results[0]!.resultHash);
    }

    // Results are immutable, and working the finished run again does nothing.
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchCampaignResult" SET "verdict" = 'VALIDATED_CANDIDATE' WHERE "unitId" = $1`, units[0]!.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchCampaignUnit" SET "state" = 'PENDING' WHERE "id" = $1`, units[0]!.id)).rejects.toThrow(/is terminal/);
    const again = await workRun(prisma, run.id, deps("worker-b"));
    expect(again.handled).toHaveLength(0);
  }, 300_000);

  it("two executors on one run (duplicate delivery) give each unit exactly one result", async () => {
    const { run } = await declare(spec("duplicate delivery", { strategies: ["hz_atr_breakout", "hz_vol_expansion", "hz_mtf_trend"] }));
    const [a, b] = await Promise.all([workRun(prisma, run.id, deps("dup-a")), workRun(prisma, run.id, deps("dup-b"))]);
    const units = await unitsOf(run.id);
    expect(units.every((u) => u.state === "SUCCEEDED" && u.results.length === 1 && u.attempts === 1)).toBe(true);
    expect(a.handled.length + b.handled.length).toBe(3);
    expect(await prisma.researchTrialLedger.count({ where: { unitId: { in: units.map((u) => u.id) }, kind: "RESERVED" } })).toBe(3);
    expect(await prisma.researchTrialLedger.count({ where: { unitId: { in: units.map((u) => u.id) }, kind: "SETTLED" } })).toBe(3);
  }, 120_000);

  it("a crashed attempt keeps its error and its full reservation; the retry reuses both and never recounts", async () => {
    const { run } = await declare(spec("crash retry"));
    const planned = (await unitsOf(run.id))[0]!.plannedTrials;
    const before = await programmeTrials(prisma);
    let attempt = 0;
    const flaky: Evaluator = async (job, limits, signal) => {
      attempt += 1;
      if (attempt === 1) throw new EvaluatorFailure("CRASHED", "evaluator exited with SIGKILL (simulated)");
      return inProcess(job, limits, signal);
    };
    const first = await workRun(prisma, run.id, deps("crash-a", { evaluator: flaky }), { maxUnits: 1 });
    expect(first.handled[0]!.outcome).toBe("RETRY");
    // After the crash: the unit is pending again, and the programme count includes its whole planned grid.
    const mid = await programmeTrials(prisma);
    expect(mid.total - before.total).toBe(planned);
    expect(mid.campaignOutstanding - before.campaignOutstanding).toBe(planned);
    const reservedAt = (await prisma.researchTrialLedger.findFirstOrThrow({ where: { unitId: first.handled[0]!.unitId, kind: "RESERVED" } })).priorTrials;
    expect(reservedAt).toBe(before.total);

    // Another campaign's trials land between the attempts; the retry must still use the frozen count.
    await declare(spec("interleaved")).then(({ run: other }) => workRun(prisma, other.id, deps("crash-other")));
    const second = await workRun(prisma, run.id, deps("crash-b", { evaluator: flaky }));
    expect(second.handled.map((h) => h.outcome)).toEqual(["SUCCEEDED"]);
    const unit = (await unitsOf(run.id))[0]!;
    expect(unit.attempts).toBe(2);
    expect(unit.results).toHaveLength(1);
    expect(unit.results[0]!.priorTrials).toBe(before.total);
    expect(await prisma.researchTrialLedger.count({ where: { unitId: unit.id } })).toBe(2); // one RESERVED, one SETTLED
    const failures = await prisma.researchCampaignEvent.findMany({ where: { unitId: unit.id, kind: "UNIT_ATTEMPT_FAILED" } });
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0]!.detail)).toMatch(/SIGKILL \(simulated\)/);
  }, 120_000);

  it("a unit that never completes is FAILED, stays FAILED, and counts its whole reservation for ever", async () => {
    const { run } = await declare(spec("abandoned", { limits: { maxAttemptsPerUnit: 2 } }));
    const planned = (await unitsOf(run.id))[0]!.plannedTrials;
    const before = await programmeTrials(prisma);
    const broken: Evaluator = async () => {
      throw new EvaluatorFailure("CRASHED", "out of memory (simulated)");
    };
    const out = await workRun(prisma, run.id, deps("oom", { evaluator: broken }));
    expect(out.handled.map((h) => h.outcome)).toEqual(["RETRY", "FAILED"]);
    const unit = (await unitsOf(run.id))[0]!;
    expect(unit.state).toBe("FAILED");
    expect(unit.results).toHaveLength(0);
    expect((await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: run.id } })).state).toBe("COMPLETED_WITH_FAILURES");
    const after = await programmeTrials(prisma);
    expect(after.total - before.total).toBe(planned);
    expect(await prisma.researchTrialLedger.count({ where: { unitId: unit.id, kind: "SETTLED" } })).toBe(0);
    // A runtime limit is not retried: the same evaluation would exceed it again.
    const { run: slow } = await declare(spec("runtime limit"));
    const timeout: Evaluator = async () => {
      throw new EvaluatorFailure("RUNTIME_LIMIT", "evaluation exceeded 1000 ms and was stopped");
    };
    expect((await workRun(prisma, slow.id, deps("slow", { evaluator: timeout }))).handled.map((h) => h.outcome)).toEqual(["FAILED"]);
  }, 60_000);

  it("concurrent reservations from different connections each see the other: the history is never understated", async () => {
    const { run } = await declare(spec("concurrent reserve", { strategies: ["hz_atr_breakout", "hz_vol_expansion"] }));
    const units = await unitsOf(run.id);
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const before = await programmeTrials(prisma);
      const [r0, r1] = await Promise.all([
        reserveTrials(prisma, { unitId: units[0]!.id, runId: run.id, planned: units[0]!.plannedTrials, maxTrials: 5000, actor: "c0" }),
        reserveTrials(other, { unitId: units[1]!.id, runId: run.id, planned: units[1]!.plannedTrials, maxTrials: 5000, actor: "c1" }),
      ]);
      if (r0.status === "REFUSED" || r1.status === "REFUSED") throw new Error("unexpected refusal");
      // Whichever connection won the lock, each unit counts the other at its full planned bound.
      expect(r0.priorTrials).toBe(before.total + units[1]!.plannedTrials);
      expect(r1.priorTrials).toBe(before.total + units[0]!.plannedTrials);
      expect((await programmeTrials(prisma)).total).toBe(before.total + units[0]!.plannedTrials + units[1]!.plannedTrials);
      // Idempotent: asking again returns the same frozen count and adds nothing.
      const again = await reserveTrials(other, { unitId: units[0]!.id, runId: run.id, planned: units[0]!.plannedTrials, maxTrials: 5000, actor: "c1" });
      expect(again).toMatchObject({ status: "ALREADY_RESERVED", priorTrials: r0.priorTrials });
      // The run's declared trial limit is enforced at reservation.
      const { run: tight } = await declare(spec("tight limit", { strategies: ["hz_atr_breakout", "hz_vol_expansion"] }));
      const t = await unitsOf(tight.id);
      const ok = await reserveTrials(prisma, { unitId: t[0]!.id, runId: tight.id, planned: t[0]!.plannedTrials, maxTrials: t[0]!.plannedTrials, actor: "c0" });
      expect(ok.status).toBe("RESERVED");
      expect((await reserveTrials(prisma, { unitId: t[1]!.id, runId: tight.id, planned: t[1]!.plannedTrials, maxTrials: t[0]!.plannedTrials, actor: "c0" })).status).toBe("REFUSED");
    } finally {
      await other.$disconnect();
    }
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchTrialLedger" WHERE "unitId" = $1`, units[0]!.id)).rejects.toThrow(/append-only/);
  });

  it("an executor that dies loses its lease; the unit is reclaimed and the dead executor can write nothing", async () => {
    const { run } = await declare(spec("lease"));
    const t0 = new Date("2030-01-01T00:00:00Z");
    const dead = await claimUnit(prisma, { runId: run.id, owner: "dead", leaseMs: 60_000, now: t0 });
    if (dead.kind !== "CLAIMED") throw new Error("expected a claim");
    // While the lease is live nobody else can take the unit.
    expect((await claimUnit(prisma, { runId: run.id, owner: "other", leaseMs: 60_000, now: new Date(t0.getTime() + 30_000) })).kind).toBe("NONE");
    expect((await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: run.id } })).state).toBe("RUNNING");
    // After expiry (process restart) another executor reclaims and finishes it.
    const later = new Date(t0.getTime() + 61_000);
    const out = await workRun(prisma, run.id, deps("alive", { now: () => later }));
    expect(out.handled.map((h) => h.outcome)).toEqual(["SUCCEEDED"]);
    const unit = (await unitsOf(run.id))[0]!;
    expect(unit.attempts).toBe(2);
    expect(await prisma.researchCampaignEvent.count({ where: { unitId: unit.id, kind: "LEASE_RECLAIMED" } })).toBe(1);
    // The dead executor wakes up and tries to store a (different) result: fenced out, the stored one is kept.
    const stale = evaluateUnit({ mode: "WALK_FORWARD", unit: specOf(await prisma.researchCampaign.findFirstOrThrow({ where: { runs: { some: { id: run.id } } } })).units[0]!, dataset: spec("x").datasets[0] as never, validation: { folds: 4, holdoutFraction: 0.2, seed: 99 }, ml: { seed: 1, bootstrapResamples: 1000, randomControls: 200, prefixProbes: 8 }, codeVersion: CODE, priorTrials: 0, raw: { bars: [], availableAt: null, tickVolumes: null, source: { kind: "FILE" } } });
    expect((await completeUnit(prisma, { unit: dead.unit, owner: "dead", evaluation: stale, reserved: false, metrics: { runtimeMs: 1, peakRssMb: 1 }, now: later })).status).toBe("LEASE_LOST");
    expect((await unitsOf(run.id))[0]!.results.map((r) => r.resultHash)).toEqual([unit.results[0]!.resultHash]);
    expect((await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: run.id } })).state).toBe("COMPLETED");
  }, 60_000);

  it("cancellation closes pending units, cannot be withdrawn, and a cancelled run does no work", async () => {
    const { run } = await declare(spec("cancel", { strategies: ["hz_atr_breakout", "hz_vol_expansion"] }));
    const callsBefore = calls;
    const out = await cancelRun(prisma, { runId: run.id, actor: "operator:it", now: new Date() });
    expect(out).toEqual({ cancelled: 2, state: "CANCELLED" });
    expect((await cancelRun(prisma, { runId: run.id, actor: "operator:it", now: new Date() })).cancelled).toBe(0);
    expect((await workRun(prisma, run.id, deps("after-cancel"))).stopped).toBe("CANCELLED");
    expect(calls).toBe(callsBefore);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchCampaignRunState" SET "cancelRequestedAt" = NULL WHERE "runId" = $1`, run.id)).rejects.toThrow(/cannot be withdrawn/);
    expect((await unitsOf(run.id)).every((u) => u.state === "CANCELLED" && u.results.length === 0)).toBe(true);
  });

  it("refused data is a stored result with its reason and no trials; a file that is not the declared one is never evaluated", async () => {
    // One active Saturday bar: off the FX calendar, and too wide to be a weekend stub.
    const lines = planted.trimEnd().split("\n");
    const bad = writeCsv("offsession.csv", [...lines, "2026-01-03T12:00:00.000Z,1.10,1.12,1.09,1.11,1000"].join("\n") + "\n");
    const before = await programmeTrials(prisma);
    const callsBefore = calls;
    const { run } = await declare(spec("refused data", { datasets: [{ key: "planted", source: { kind: "FILE", ...bad }, market: "FX", instrument: "EUR/USD", interval: "1h", asOf: "2026-02-01T00:00:00Z" }] }));
    expect((await workRun(prisma, run.id, deps("refuse"))).handled.map((h) => h.outcome)).toEqual(["REFUSED"]);
    const unit = (await unitsOf(run.id))[0]!;
    expect(unit.state).toBe("REFUSED");
    expect(unit.results[0]).toMatchObject({ phase: "DATA_REFUSAL", verdict: "REJECTED_DATA", trialCount: 0, holdoutStatus: "NOT_REACHED" });
    expect(unit.results[0]!.reasons.join(" ")).toMatch(/OFF_SESSION/);
    expect(calls).toBe(callsBefore); // refused before the evaluator was started
    expect((await programmeTrials(prisma)).total).toBe(before.total);

    const { run: wrong } = await declare(spec("wrong file", { file: { path: plantedFile.path, sha256: "0".repeat(64) } }));
    expect((await workRun(prisma, wrong.id, deps("wrong"))).handled.map((h) => h.outcome)).toEqual(["FAILED"]);
    const failed = (await unitsOf(wrong.id))[0]!;
    expect(failed.lastError).toMatch(/not the declared dataset/);
    expect(calls).toBe(callsBefore);
  }, 60_000);

  it("a holdout is read only under a current operator authorisation for that exact result", async () => {
    const units = await unitsOf(passed.runId);
    const rejected = units.find((u) => !u.results[0]!.walkForwardPassed)!;
    await expect(authorizeHoldout(prisma, { unitId: rejected.id, operator: "rhys", ttlMs: 3_600_000 })).rejects.toThrow(/NOT_ELIGIBLE.*did not pass walk-forward/);
    await expect(beginHoldout(prisma, { unitId: passed.unitId, actor: "it" })).rejects.toThrow(/NOT_AUTHORIZED.*stays withheld/);
    await expect(authorizeHoldout(prisma, { unitId: passed.unitId, operator: "rhys", ttlMs: 30 * 86_400_000 })).rejects.toThrow(/BAD_TTL/);
    // An expired authorisation does not count.
    const past = new Date(Date.now() - 2 * 3_600_000);
    await authorizeHoldout(prisma, { unitId: passed.unitId, operator: "rhys", ttlMs: 3_600_000, now: past });
    await expect(beginHoldout(prisma, { unitId: passed.unitId, actor: "it" })).rejects.toThrow(/NOT_AUTHORIZED.*expired/);
    expect(await prisma.researchHoldoutLedger.count({ where: { unitId: passed.unitId, kind: "CONSUME_INTENT" } })).toBe(0);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchHoldoutLedger" SET "expiresAt" = now() + interval '1 day' WHERE "unitId" = $1`, passed.unitId)).rejects.toThrow(/append-only/);
  });

  it("an authorised holdout is evaluated exactly once, concurrently and on retry, and stays research-only", async () => {
    const promotionsBefore = await prisma.strategyPromotion.count();
    const auth = await authorizeHoldout(prisma, { unitId: passed.unitId, operator: "rhys", ttlMs: 3_600_000, note: "integration test" });
    expect(auth.authorisation.actor).toBe("operator:rhys");
    expect(auth.priorLooks).toBe(0);
    const readsBefore = holdoutReads;
    const [a, b] = await Promise.all([evaluateHoldout(prisma, passed.unitId, deps("h-a")), evaluateHoldout(prisma, passed.unitId, deps("h-b"))]);
    expect([a.status, b.status].sort()).toEqual(["IN_PROGRESS", "RECORDED"]);
    // Only the call that stored the result reports a verdict.
    expect([a, b].filter((r) => r.verdict !== undefined)).toHaveLength(1);
    expect(holdoutReads - readsBefore).toBe(1);
    expect((await evaluateHoldout(prisma, passed.unitId, deps("h-c"))).status).toBe("ALREADY_CLOSED");
    expect(holdoutReads - readsBefore).toBe(1);

    const results = await prisma.researchCampaignResult.findMany({ where: { unitId: passed.unitId }, orderBy: { createdAt: "asc" } });
    expect(results.map((r) => r.phase)).toEqual(["WALK_FORWARD", "HOLDOUT"]);
    const holdout = results[1]!;
    expect(holdout.holdoutStatus).toBe("EVALUATED");
    expect(["VALIDATED_CANDIDATE", "REJECTED_OVERFIT"]).toContain(holdout.verdict);
    // The walk-forward evidence is untouched and the holdout result was computed for it.
    expect((holdout.summary as { walkForwardHash: string }).walkForwardHash).toBe((results[0]!.summary as { walkForwardHash: string }).walkForwardHash);
    expect(holdout.priorTrials).toBe(results[0]!.priorTrials);
    const ledger = await prisma.researchHoldoutLedger.findMany({ where: { unitId: passed.unitId }, orderBy: { createdAt: "asc" } });
    expect(ledger.filter((l) => l.kind === "CONSUME_INTENT")).toHaveLength(1);
    expect(ledger.filter((l) => l.kind === "RESULT_RECORDED")).toHaveLength(1);
    // The database itself refuses a second intent or close for the unit.
    const intent = ledger.find((l) => l.kind === "CONSUME_INTENT")!;
    const { id: _id, createdAt: _c, ...copy } = intent;
    await expect(prisma.researchHoldoutLedger.create({ data: copy })).rejects.toThrow();
    // Reading the holdout adds no trials and creates nothing that could trade.
    expect(await prisma.researchTrialLedger.count({ where: { unitId: passed.unitId } })).toBe(2);
    expect(await prisma.strategyPromotion.count()).toBe(promotionsBefore);
  }, 120_000);

  it("the same period cannot be bought again: renamed instrument, new dataset key, appended data, new campaign", async () => {
    // The same bars under another spelling and key, and a longer dataset (appended bars) whose holdout overlaps.
    const longer = writeCsv("appended.csv", barsToCsv(syntheticFxBreakoutBars({ start: "2024-06-02T22:00:00Z", bars: 4400, seed: 42, plant: PLANT })));
    const { run } = await declare(spec("second look", { datasets: [
      { key: "renamed", source: { kind: "FILE", ...plantedFile }, market: "FX", instrument: `eur_x${TAG.toLowerCase()}`, interval: "1h", asOf: "2026-01-01T00:00:00Z" },
      { key: "appended", source: { kind: "FILE", ...longer }, market: "FX", instrument: `fx:EURX${TAG}`, interval: "1h", asOf: "2026-01-01T00:00:00Z" },
    ], strategies: [passed.strategy] }));
    await workRun(prisma, run.id, deps("second"));
    const [renamed, appended] = await unitsOf(run.id);
    // Identical bars pass walk-forward exactly as before, so the authorisation question does arise.
    expect(renamed!.results[0]!.walkForwardPassed).toBe(true);
    await expect(authorizeHoldout(prisma, { unitId: renamed!.id, operator: "rhys", ttlMs: 3_600_000 })).rejects.toThrow(/HOLDOUT_ALREADY_CONSUMED.*only bars after that period/);
    if (appended!.results[0]!.walkForwardPassed) await expect(authorizeHoldout(prisma, { unitId: appended!.id, operator: "rhys", ttlMs: 3_600_000 })).rejects.toThrow(/HOLDOUT_ALREADY_CONSUMED/);
    expect(await prisma.researchHoldoutLedger.count({ where: { unitId: { in: [renamed!.id, appended!.id] } } })).toBe(0);
  }, 120_000);

  it("a consumed holdout whose result is lost is recorded as lost, never recomputed, and blocks the period", async () => {
    // A different instrument, so the period is unconsumed; find a family that passes walk-forward on it.
    const { run } = await declare(spec("lost result", { instrument: `AUD/X${TAG}`, strategies: ALL_STRATEGIES, limits: { maxConcurrency: 1 } }));
    await workRun(prisma, run.id, deps("lost-wf"));
    const unit = (await unitsOf(run.id)).find((u) => u.results[0]!.walkForwardPassed)!;
    expect(unit).toBeTruthy();
    await authorizeHoldout(prisma, { unitId: unit.id, operator: "rhys", ttlMs: 3_600_000 });
    let holdoutCalls = 0;
    // Dies while reading the holdout (the walk-forward rehearsal before the intent succeeds).
    const dies: Evaluator = async (job, limits, signal) => {
      if (job.mode !== "HOLDOUT") return inProcess(job, limits, signal);
      holdoutCalls += 1;
      throw new EvaluatorFailure("CRASHED", "evaluator killed after reading the holdout (simulated)");
    };
    const first = await evaluateHoldout(prisma, unit.id, deps("lost-a", { evaluator: dies }));
    expect(first.status).toBe("RESULT_LOST");
    // Retry with a healthy evaluator: the holdout is not read again.
    const readsBefore = holdoutReads;
    const retry = await evaluateHoldout(prisma, unit.id, deps("lost-b"));
    expect(retry.status).toBe("ALREADY_CLOSED");
    expect(holdoutCalls).toBe(1);
    expect(holdoutReads).toBe(readsBefore);
    const result = await prisma.researchCampaignResult.findUniqueOrThrow({ where: { unitId_phase: { unitId: unit.id, phase: "HOLDOUT" } } });
    expect(result).toMatchObject({ verdict: "HOLDOUT_CONSUMED_RESULT_LOST", holdoutStatus: "CONSUMED_RESULT_LOST" });
    expect(result.reasons[0]).toMatch(/not recomputed.*needs bars after/);
    // The intent survives; a fresh authorisation for the same unit is refused.
    await expect(authorizeHoldout(prisma, { unitId: unit.id, operator: "rhys", ttlMs: 3_600_000 })).rejects.toThrow(/ALREADY_CONSUMED/);
  }, 300_000);

  it("an earlier as-of instant cannot turn bars the lineage was already tested on into a holdout", async () => {
    // Same series and family as the shared run, cut earlier: its last 20% lies inside bars the family was
    // already walked forward on (the shared run's pre-holdout span).
    const lines = planted.trimEnd().split("\n");
    const cutAsOf = new Date(Date.parse(lines[3401]!.split(",")[0]!)).toISOString(); // 3,400 bars available
    const { run } = await declare(spec("earlier as-of", { datasets: [{ key: "truncated", source: { kind: "FILE", ...plantedFile }, market: "FX", instrument: EUR, interval: "1h", asOf: cutAsOf }], strategies: ALL_STRATEGIES, limits: { maxConcurrency: 1 } }));
    await workRun(prisma, run.id, deps("asof"));
    const units = await unitsOf(run.id);
    expect((units[0]!.results[0]!.dataset as { bars: number }).bars).toBe(3400);
    const eligible = units.filter((u) => u.results[0]!.walkForwardPassed);
    expect(eligible.length, "the truncated planted series should still leave a family pending").toBeGreaterThan(0);
    for (const u of eligible) await expect(authorizeHoldout(prisma, { unitId: u.id, operator: "rhys", ttlMs: 3_600_000 })).rejects.toThrow(/HOLDOUT_ALREADY_CONSUMED.*(already walked forward|already read an overlapping holdout)/);
    expect(await prisma.researchHoldoutLedger.count({ where: { unitId: { in: units.map((u) => u.id) } } })).toBe(0);
  }, 300_000);

  it("a process that cannot reproduce the walk-forward reads nothing, a read that never started cannot be closed as lost, and a finished run cannot be cancelled", async () => {
    const { run } = await declare(spec("reproduce", { instrument: `NZD/X${TAG}`, strategies: ALL_STRATEGIES, limits: { maxConcurrency: 1 } }));
    await workRun(prisma, run.id, deps("reproduce-wf"));
    const first = (await unitsOf(run.id)).find((u) => u.results[0]!.walkForwardPassed)!;
    expect(first, "the planted pattern should leave a family pending").toBeTruthy();

    // Closing a read as lost needs a read: a unit with no intent cannot be closed.
    const { recordHoldoutLost } = await import("@odin/evolution/campaign");
    await expect(recordHoldoutLost(prisma, { unitId: first.id, actor: "it", why: "nothing was read" })).rejects.toThrow(/NO_INTENT/);
    expect(await prisma.researchCampaignResult.count({ where: { unitId: first.id, phase: "HOLDOUT" } })).toBe(0);

    // A process whose walk-forward differs (other runtime, other build) is refused before anything is consumed.
    await authorizeHoldout(prisma, { unitId: first.id, operator: "rhys+ops@example.com", ttlMs: 3_600_000 });
    const drifting: Evaluator = async (job, limits, signal) => {
      const out = await inProcess(job, limits, signal);
      return { ...out, evaluation: { ...out.evaluation, walkForwardHash: "0".repeat(64) } };
    };
    const readsBefore = holdoutReads;
    await expect(evaluateHoldout(prisma, first.id, deps("drift", { evaluator: drifting }))).rejects.toThrow(/WALK_FORWARD_NOT_REPRODUCED.*the holdout was not read/);
    expect(holdoutReads).toBe(readsBefore);
    expect(await prisma.researchHoldoutLedger.count({ where: { unitId: first.id, kind: "CONSUME_INTENT" } })).toBe(0);
    // The authorisation is still good for a process that does reproduce it.
    expect((await evaluateHoldout(prisma, first.id, deps("ok"))).status).toBe("RECORDED");
    expect(holdoutReads).toBe(readsBefore + 1);

    // Everything in this run is finished: cancelling it changes nothing.
    expect(await cancelRun(prisma, { runId: run.id, actor: "operator:it", now: new Date() })).toEqual({ cancelled: 0, state: "COMPLETED" });
    expect((await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: run.id } })).cancelRequestedAt).toBeNull();
  }, 300_000);

  it("two executors with a concurrency limit of one never hold two units, and the run still finishes COMPLETED", async () => {
    const { run } = await declare(spec("limit one", { strategies: ["hz_atr_breakout", "hz_vol_expansion", "hz_mtf_trend", "hz_vol_mean_reversion"], limits: { maxConcurrency: 1 } }));
    let active = 0;
    let peak = 0;
    const tracked: Evaluator = async (job, limits, signal) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 150)); // hold the unit across an await, so a second claim could interleave
      try {
        return await inProcess(job, limits, signal);
      } finally {
        active -= 1;
      }
    };
    const work = async (owner: string) => {
      const handled = [];
      for (let i = 0; i < 40; i += 1) {
        const out = await workRun(prisma, run.id, deps(owner, { evaluator: tracked }));
        handled.push(...out.handled);
        if (out.stopped === "NOTHING_CLAIMABLE") break;
        await new Promise((r) => setTimeout(r, 50)); // CONCURRENCY_LIMIT: the other executor holds the slot
      }
      return handled;
    };
    const [a, b] = await Promise.all([work("one-a"), work("one-b")]);
    expect(peak).toBe(1);
    expect(a.length + b.length).toBe(4);
    expect((await unitsOf(run.id)).every((u) => u.state === "SUCCEEDED" && u.results.length === 1)).toBe(true);
    expect((await prisma.researchCampaignRunState.findUniqueOrThrow({ where: { runId: run.id } })).state).toBe("COMPLETED");
  }, 120_000);
});
