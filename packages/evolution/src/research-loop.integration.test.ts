import { createHash } from "node:crypto";
import type { LlmRequest, LlmResult, ModelProvider } from "@odin/agent-core";
import { chronologicalSplits } from "@odin/backtest";
import { DEFAULT_STRATEGY, d, newId } from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { compileStrategySource } from "./compile-strategy.js";
import { FixtureModelProvider } from "./fixture-provider.js";
import type { forgeStrategyModule } from "./forge.js";
import {
  approvalSubject,
  claimResearchExperiments,
  reserveResearchBudget,
  enqueueResearchExperiment,
  listResearchExperiments,
  recordResearchApproval,
  runResearchLoopTick,
  setResearchLoopControl,
  type ResearchLoopDeps,
} from "./research-loop.js";
import { pinResearchDataset, type PinnedDataset } from "./research-dataset.js";
import { DEFAULT_ASSIGNMENTS } from "./router.js";
import type { executeCompiledStrategy } from "./sandbox-runner.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const SOURCE = `export function onBar(input) {\n  return { intent: "HOLD", reasonCodes: ["LOOP_TEST"] };\n}\n`;

/** Counts calls; delegates to an explicit FIXTURE provider (test-only, labelled FIXTURE). */
class CountingProvider implements ModelProvider {
  readonly id = "fixture";
  calls = 0;
  constructor(private readonly inner: FixtureModelProvider) {}
  async completeJson<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResult<T>> {
    this.calls += 1;
    return this.inner.completeJson(request, schema);
  }
}

function fixtureProviders() {
  const oracle = new CountingProvider(
    new FixtureModelProvider({
      deep_hypothesis: {
        title: "Momentum persists after volume spikes",
        falsifier: "Returns after spikes are not above baseline over the untouched window",
        conditions: "Five-minute volume above twice the hourly mean",
      },
    }),
  );
  const forge = new CountingProvider(new FixtureModelProvider({ engineering_source: { source: SOURCE } }));
  const challenge = new CountingProvider(new FixtureModelProvider({ challenge_review: { verdict: "PASS", findings: [] } }));
  const providers = new Map<string, ModelProvider>([
    ["openai-primary", oracle],
    ["anthropic-primary", forge],
    ["challenge-primary", challenge],
  ]);
  return { providers, oracle, forge, challenge, total: () => oracle.calls + forge.calls + challenge.calls };
}

/** Test double for the forge: records calls and returns the artifact the real compiler produces. */
function countingForge() {
  const calls: string[] = [];
  const fn: typeof forgeStrategyModule = async (input) => {
    calls.push(input.hypothesis.id ?? "");
    const compiled = compileStrategySource(input.source ?? "");
    if (!compiled.ok) throw new Error("fixture source must compile");
    return {
      ok: true,
      workspacePath: "/nonexistent/test-forge",
      manifest: { id: "strat_loop_test", version: "0.1.0", instrumentIds: input.hypothesis.instrumentIds, hypothesisId: input.hypothesis.id, entrypoint: "strategy.js" },
      sourceHash: createHash("sha256").update(input.source ?? "").digest("hex"),
      artifactHash: compiled.artifactHash,
      signals: [],
      integrity: {} as never,
      provenance: "PROVIDED_SOURCE",
      signalsClaimed: true,
    };
  };
  return { fn, calls };
}

const holdExecutor: typeof executeCompiledStrategy = async (input) => ({
  ok: true,
  contained: true,
  signalsClaimed: true,
  exitStatus: 0,
  timedOut: false,
  executedHash: input.artifactHash,
  signals: input.bars.map((bar) => ({ instrumentId: bar.instrumentId, intent: "HOLD" as const, reasonCodes: ["LOOP_TEST"] })),
  error: null,
  code: "EXECUTED",
  runner: {} as never,
});

const HOUR = 3_600_000;

/** Forge context as FORGE records it, for experiments created directly at TEST. */
const forgedContext = (strategyId = "strat_loop_test", source = SOURCE) => {
  const compiled = compileStrategySource(source);
  if (!compiled.ok) throw new Error("fixture source must compile");
  return {
    strategyId,
    version: "0.1.0",
    source,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    artifactHash: compiled.artifactHash,
    modelIdentifier: "FIXTURE",
    endpointId: "anthropic-primary",
  };
};

describe.skipIf(!enabled)("ASCEND-08 research loop (database)", () => {
  let prisma: PrismaClient;
  let createdEngine = false;

  /**
   * Events, approvals and experiments are append-only and refuse TRUNCATE, so tests never wipe them.
   * Cleanup abandons every non-terminal experiment (an allowed transition) and clears only the
   * mutable tables. Tests that depend on the UTC-day count run on a fresh day (`freshNow`).
   */
  const reset = async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE "ResearchExperiment" SET "state" = 'ABANDONED', "blockedState" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = 'test cleanup', "updatedAt" = now()
       WHERE "state" NOT IN ('REJECTED', 'FAILED', 'ABANDONED')`,
    );
    await prisma.researchLoopControl.deleteMany({});
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "ModelUsageLog" RESTART IDENTITY CASCADE`);
    await prisma.hypothesis.deleteMany({ where: { createdBy: "ascend08-test" } });
  };

  /** Noon UTC on a day after every existing experiment, so the daily cap starts from zero. */
  const freshNow = async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ max: Date | null }>>(`SELECT max("createdAt") AS max FROM "ResearchExperiment"`);
    const latest = Math.max(rows[0]?.max?.getTime() ?? 0, Date.now());
    const day = new Date(latest + 2 * 86_400_000);
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12));
  };

  const setAutonomy = (level: number, maxResearchBudgetUsd = "5") =>
    prisma.autonomyControl.upsert({
      where: { id: "primary" },
      create: { id: "primary", level, maxResearchBudgetUsd },
      update: { level, maxResearchBudgetUsd, allowRiskLimitMutation: false, realMoneyExecutionEnabled: false, allowUnreviewedCodeDeploy: false },
    });

  /**
   * A versioned warehouse dataset (bars are append-only, so every test seeds its own uniquely keyed dataset).
   * EQUITY_ETF so the cost model needs no observation; hourly bars ending 48 h before the wall clock.
   */
  const seedDataset = async (instrumentKey: string, options: { bars?: number; sourceId?: string } = {}) => {
    const id = newId("hds");
    const count = options.bars ?? 600;
    const end = Date.now() - 48 * HOUR;
    const first = end - count * HOUR;
    await prisma.historicalDataset.create({
      data: {
        id,
        sourceId: options.sourceId ?? "genesis-test",
        instrumentKey,
        instrumentKind: "EQUITY_ETF",
        cohort: "BROAD_ETF",
        interval: "1h",
        licence: toJson({ licence: "test fixture" }),
        versionHash: createHash("sha256").update(`version:${id}`).digest("hex"),
        barCount: count,
        firstOpenTime: new Date(first),
        lastOpenTime: new Date(end - HOUR),
      },
    });
    await prisma.historicalBar.createMany({
      data: Array.from({ length: count }, (_, i) => {
        const openTime = new Date(first + i * HOUR);
        const price = (100 + Math.sin(i / 9) * 3).toFixed(6);
        return { datasetId: id, openTime, availableAt: new Date(openTime.getTime() + HOUR), open: price, high: price, low: price, close: price, volume: "1000", hash: createHash("sha256").update(`${id}:${i}`).digest("hex"), collectedAt: new Date() };
      }),
    });
    return id;
  };
  const datasetOf = new Map<string, string>();
  const instrumentOf = (hypothesisId: string) => `GTEST_${hypothesisId}`;
  const pinFor = async (hypothesisId: string, asOf = new Date()): Promise<PinnedDataset> => {
    const pin = await pinResearchDataset(prisma, { instrumentIds: [instrumentOf(hypothesisId)], asOf });
    if (!pin.ok) throw new Error(pin.detail);
    return pin.pinned;
  };

  const hypothesis = async (status = "OPEN", options: { withDataset?: boolean } = {}) => {
    const id = newId("hyp");
    if (options.withDataset !== false) datasetOf.set(id, await seedDataset(instrumentOf(id)));
    await prisma.hypothesis.create({
      data: {
        id,
        title: `Loop test ${id.slice(-6)}`,
        market: "SPOT_CRYPTO_PAIR",
        instrumentIds: [instrumentOf(id)],
        conditions: "Volume spike on a liquid pair",
        claimedAdvantage: "Short-horizon momentum after spikes",
        entryRules: "Enter after a confirmed spike",
        exitRules: "Exit after one hour or on reversal",
        riskRules: "Engine risk limits apply unchanged",
        rationale: "Order-flow imbalance persists briefly",
        successCriteria: "Positive untouched-window expectancy",
        failureModes: "Spikes revert immediately",
        status,
        createdBy: "ascend08-test",
      },
    });
    return id;
  };

  const restated = { title: "t", falsifier: "falsifier text", conditions: "conditions text" };

  const experiment = async (
    state: string,
    extra: { context?: Record<string, unknown>; attempts?: number; hypothesisId?: string; blockedState?: string } = {},
  ) => {
    const id = newId("rexp");
    await prisma.researchExperiment.create({
      data: {
        id,
        hypothesisId: extra.hypothesisId ?? (await hypothesis("TESTING")),
        state,
        blockedState: extra.blockedState ?? null,
        attempts: extra.attempts ?? 0,
        context: toJson(extra.context ?? {}),
        createdBy: "ascend08-test",
      },
    });
    return id;
  };

  // Intake is off by default (maxExperimentsPerDay 0) so tests control exactly which experiments exist.
  const control = (overrides: Record<string, unknown> = {}) =>
    setResearchLoopControl(
      prisma,
      { enabled: true, maxExperimentsPerDay: 0, maxConcurrentExperiments: 10, maxAttemptsPerExperiment: 3, tickRuntimeMs: 70_000, leaseMs: 140_000, ...overrides },
      "ascend08-test",
    );

  const state = async (id: string) => prisma.researchExperiment.findUniqueOrThrow({ where: { id } });
  const transitions = (id: string) => prisma.researchExperimentEvent.findMany({ where: { experimentId: id, kind: "TRANSITION" }, orderBy: { createdAt: "asc" } });
  const subjectOf = async (id: string, action: "forge_code" | "run_backtest" | "promote_paper") => approvalSubject(await state(id), action)!.subjectHash;
  /** What an operator does: read the pending request's subject, then approve exactly that. */
  const approve = async (id: string, action: "forge_code" | "run_backtest" | "promote_paper", ttlMinutes = 60) =>
    recordResearchApproval(prisma, id, { action, subjectHash: approvalSubject(await state(id), action)?.subjectHash ?? "0".repeat(64), ttlMinutes }, "op@odin.local");
  const otherHash = createHash("sha256").update("some other subject").digest("hex");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    if (!(await prisma.engineControl.findUnique({ where: { id: "primary" } }))) {
      await prisma.engineControl.create({ data: { id: "primary", status: "STOPPED", config: toJson(DEFAULT_STRATEGY) } });
      createdEngine = true;
    }
  });

  beforeEach(async () => {
    await reset();
    await setAutonomy(2);
  });

  afterAll(async () => {
    await reset();
    await setAutonomy(1);
    if (createdEngine) await prisma.engineControl.delete({ where: { id: "primary" } }).catch(() => undefined);
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("is a no-op when the kill switch is off or missing, and below autonomy level 2", async () => {
    await hypothesis();
    const before = await prisma.researchExperiment.count();
    const fx = fixtureProviders();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers } };

    expect((await runResearchLoopTick(prisma, deps)).status).toBe("DISABLED"); // no control row
    // A control row created with schema defaults is off: the loop stays disabled by default.
    await prisma.researchLoopControl.create({ data: { id: "primary", maxExperimentsPerDay: 10 } });
    expect((await prisma.researchLoopControl.findUniqueOrThrow({ where: { id: "primary" } })).enabled).toBe(false);
    expect((await runResearchLoopTick(prisma, deps)).reason).toBe("Kill switch is off");
    await control({ enabled: false, maxExperimentsPerDay: 10 });
    const off = await runResearchLoopTick(prisma, deps);
    expect(off.status).toBe("DISABLED");
    expect(off.reason).toBe("Kill switch is off");

    await control({ enabled: true, maxExperimentsPerDay: 10 });
    await setAutonomy(1);
    expect((await runResearchLoopTick(prisma, deps)).status).toBe("AUTONOMY_INSUFFICIENT");
    await setAutonomy(4);
    expect((await runResearchLoopTick(prisma, deps)).status).toBe("AUTONOMY_INSUFFICIENT");

    expect(await prisma.researchExperiment.count()).toBe(before);
    expect(await prisma.modelUsageLog.count()).toBe(0);
    expect(fx.total()).toBe(0);
  });

  it("blocks forging without approval; refuses early, expired, future, wrong-action and wrong-subject approvals; proceeds with a valid one", async () => {
    const now = await freshNow();
    await control({ maxExperimentsPerDay: 1 });
    const hypothesisId = await hypothesis();
    const queued = await enqueueResearchExperiment(prisma, { hypothesisId }, "op@odin.local", now);
    expect(queued.created).toHaveLength(1);
    const id = queued.created[0]!;
    const fx = fixtureProviders();
    const forge = countingForge();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers }, forge: forge.fn };

    // M2: nothing has asked for approval yet, so an early approval is refused (the API answers 409).
    const early = await recordResearchApproval(prisma, id, { action: "run_backtest", subjectHash: otherHash }, "op@odin.local", now);
    expect(early).toEqual({ ok: false, error: "APPROVAL_NOT_REQUESTED: experiment is in OBSERVE" });
    expect(await prisma.researchApproval.count({ where: { experimentId: id } })).toBe(0);

    expect((await runResearchLoopTick(prisma, deps, now)).advanced).toEqual([expect.objectContaining({ id, from: "OBSERVE", to: "HYPOTHESISE" })]);
    expect((await runResearchLoopTick(prisma, deps, now)).advanced).toEqual([expect.objectContaining({ id, from: "HYPOTHESISE", to: "FORGE" })]);
    expect(fx.oracle.calls).toBe(1);
    expect(await prisma.modelUsageLog.count()).toBe(1); // onUsage persisted the call

    // Level 2: forge_code requires approval. None exists, so the forge is not executed.
    const third = await runResearchLoopTick(prisma, deps, now);
    expect(third.advanced).toEqual([expect.objectContaining({ id, from: "FORGE", to: "BLOCKED_APPROVAL" })]);
    expect((await state(id)).blockedState).toBe("FORGE");
    expect(fx.forge.calls).toBe(0);
    expect(forge.calls).toHaveLength(0);
    const subject = await subjectOf(id, "forge_code");
    const [listed] = (await listResearchExperiments(prisma)).filter((row) => row.id === id);
    expect(listed?.approvalRequest).toEqual(expect.objectContaining({ action: "forge_code", subjectHash: subject }));

    // Expired, future-dated and other-subject approvals (inserted directly) are all refused at the gate.
    const t = Date.now();
    const insert = (approvedAt: number, expiresAt: number, subjectHash: string) =>
      prisma.researchApproval.create({
        data: { id: newId("rapr"), experimentId: id, action: "forge_code", approvedBy: "op", approvedAt: new Date(approvedAt), expiresAt: new Date(expiresAt), subjectHash },
      });
    await insert(t - 7_200_000, t - 3_600_000, subject);
    await insert(t + 3_600_000, t + 7_200_000, subject);
    await insert(t - 1_000, t + 3_600_000, otherHash);
    // Through the operator surface: wrong action and wrong subject are refused outright.
    expect((await recordResearchApproval(prisma, id, { action: "promote_paper", subjectHash: subject }, "op@odin.local")).ok).toBe(false);
    const mismatch = await recordResearchApproval(prisma, id, { action: "forge_code", subjectHash: otherHash }, "op@odin.local");
    expect(mismatch.ok ? "" : mismatch.error).toMatch(/^SUBJECT_MISMATCH/);
    const stillBlocked = await runResearchLoopTick(prisma, deps, now);
    expect(stillBlocked.advanced).toEqual([]);
    expect(stillBlocked.held).toEqual([expect.objectContaining({ id, reason: "AWAITING_APPROVAL: forge_code" })]);
    expect(forge.calls).toHaveLength(0);

    const approval = await approve(id, "forge_code");
    expect(approval.ok).toBe(true);
    const unblocked = await runResearchLoopTick(prisma, deps, now);
    expect(unblocked.advanced).toEqual([expect.objectContaining({ id, from: "BLOCKED_APPROVAL", to: "FORGE" })]);
    expect(forge.calls).toHaveLength(0); // one state per tick: unblocking does not also forge

    const forged = await runResearchLoopTick(prisma, deps, now);
    expect(forged.advanced).toEqual([expect.objectContaining({ id, from: "FORGE", to: "TEST" })]);
    expect(forge.calls).toEqual([hypothesisId]);
    expect(fx.forge.calls).toBe(1);
    const forgeEvent = (await transitions(id)).find((row) => row.fromState === "FORGE" && row.toState === "TEST");
    expect((forgeEvent?.evidence as Record<string, unknown>).approvalId).toBe(approval.ok ? approval.approval.id : null);

    // run_backtest needs its own approval, bound to the forged artifact; the forge approval does not carry over.
    const testTick = await runResearchLoopTick(prisma, deps, now);
    expect(testTick.advanced).toEqual([expect.objectContaining({ id, from: "TEST", to: "BLOCKED_APPROVAL" })]);
    expect((await state(id)).blockedState).toBe("TEST");
    expect(await subjectOf(id, "run_backtest")).not.toBe(subject);
  });

  it("refuses an approval that expires during the tick (validity is checked at gate time)", async () => {
    await control();
    const id = await experiment("BLOCKED_APPROVAL", { blockedState: "FORGE", context: { hypothesis: restated } });
    const t = Date.now();
    await prisma.researchApproval.create({
      data: { id: newId("rapr"), experimentId: id, action: "forge_code", approvedBy: "op", approvedAt: new Date(t - 1_000), expiresAt: new Date(t + 400), subjectHash: await subjectOf(id, "forge_code") },
    });
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, afterClaim: () => sleep(800) }, new Date(t));
    expect(tick.advanced).toEqual([]);
    expect(tick.held).toEqual([expect.objectContaining({ id, reason: "AWAITING_APPROVAL: forge_code" })]);
    expect((await state(id)).state).toBe("BLOCKED_APPROVAL");
  });

  it("does not ask for approval at level 3 and measures with the real simulation; a weak candidate is rejected without a model call", async () => {
    await setAutonomy(3);
    await control();
    const fx = fixtureProviders();
    const forge = countingForge();
    const now = new Date();
    const deps: ResearchLoopDeps = {
      owner: "t1",
      router: { env: {}, providers: fx.providers },
      forge: forge.fn,
      execute: holdExecutor,
    };
    const hypothesisId = await hypothesis("TESTING");
    const id = await experiment("FORGE", { hypothesisId, context: { hypothesis: restated, dataset: await pinFor(hypothesisId, now) } });
    expect((await runResearchLoopTick(prisma, deps, now)).advanced).toEqual([expect.objectContaining({ id, from: "FORGE", to: "TEST" })]);
    expect((await runResearchLoopTick(prisma, deps, now)).advanced).toEqual([expect.objectContaining({ id, from: "TEST", to: "CHALLENGE" })]);
    const measured = (await state(id)).context as Record<string, Record<string, unknown>>;
    expect(measured.test!.observationCount).toBe(600);
    expect(measured.test!.dataset).toEqual(expect.objectContaining({ datasetId: datasetOf.get(hypothesisId), barCount: 600, instrumentKey: instrumentOf(hypothesisId) }));
    expect((measured.test!.cost as Record<string, unknown>).bpsPerSide).toBeGreaterThan(0);
    expect(measured.test!.measuredReturnPct).toBeNull(); // HOLD-only: no closed trades, nothing invented
    expect(measured.test!.measuredSampleSize).toBe(0);
    // The untouched holdout was looked at once: consumed under the candidate's name-independent key.
    expect(await prisma.researchHoldoutAccess.count({ where: { runId: `rexp:${id}`, datasetId: datasetOf.get(hypothesisId) } })).toBe(1);
    const challenged = await runResearchLoopTick(prisma, deps, now);
    expect(challenged.advanced).toEqual([expect.objectContaining({ id, from: "CHALLENGE", to: "REJECTED", reason: expect.stringMatching(/^CHALLENGE_ADVERSARY_REJECT: .*INSUFFICIENT_SAMPLE/) })]);
    expect(await prisma.researchExperimentEvent.count({ where: { experimentId: id, kind: "ADVERSARY_REJECTED" } })).toBe(1);
    expect(fx.challenge.calls).toBe(0);
    expect((await runResearchLoopTick(prisma, deps, now)).claimed).toEqual([]);
  });

  const passingContext = () => {
    const endAt = new Date(Date.now() - 3_600_000).toISOString();
    const startAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return {
      hypothesis: restated,
      forge: {
        strategyId: "strat_loop_challenge",
        version: "0.1.0",
        sourceHash: createHash("sha256").update("source").digest("hex"),
        artifactHash: createHash("sha256").update("artifact").digest("hex"),
        modelIdentifier: "FIXTURE",
        endpointId: "anthropic-primary",
      },
      // A TEST-stage record as the loop writes it (test fixture data; the stage itself is exercised above).
      test: {
        datasetHash: createHash("sha256").update("dataset").digest("hex"),
        startAt,
        endAt,
        observationCount: 400,
        blocked: false,
        measuredReturnPct: "12.500000",
        measuredSampleSize: 60,
        maxDrawdownPct: "5.000000",
        untouchedReturnPct: "4.000000",
        untouchedSampleSize: 40,
        splits: chronologicalSplits(startAt, endAt),
        statisticsRecorded: true,
        // GENESIS Phase 8 fields the adversarial reviewer requires.
        measuredAt: new Date().toISOString(),
        dataset: { datasetId: "hds_fixture", versionHash: "f".repeat(64), instrumentKey: "GTEST_fixture", interval: "1h", asOf: endAt, maxAvailableAt: endAt, barCount: 600, adapter: "genesis-pit-1" },
        cost: { bpsPerSide: 10, roundTripBps: 20, basis: "test fixture cost", isProxy: true, model: "QUOTED_SPREAD_FEE" },
        folds: [1, 2, 3, 4].map((fold) => ({ fold, trades: 10, netReturn: 0.02 })),
        fullNetReturnDoubleCost: 0.05,
        candidate: { fingerprint: "a".repeat(64), holdoutStrategyId: `rlc_${newId("x")}`, strategyId: "strat_loop_challenge" },
        redundancy: { checked: ["DUPLICATE_EXPERIMENT", "RENAMED_CANDIDATE", "HOLDOUT_REUSED"] },
      },
    };
  };

  it("CHALLENGE passes only with a separated reviewer; VALIDATE persists a PENDING report", async () => {
    await control();
    const fx = fixtureProviders();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers } };
    const id = await experiment("CHALLENGE", { context: passingContext() });
    const challenged = await runResearchLoopTick(prisma, deps);
    expect(challenged.advanced).toEqual([expect.objectContaining({ id, from: "CHALLENGE", to: "VALIDATE" })]);
    expect(fx.challenge.calls).toBe(1);
    const challenge = ((await state(id)).context as Record<string, Record<string, unknown>>).challenge!;
    expect(challenge.separated).toEqual({ separated: true, forgeEndpointId: "anthropic-primary", challengeEndpointId: "challenge-primary" });
    expect((challenge.model as Record<string, unknown>).endpointId).toBe("challenge-primary");

    const validated = await runResearchLoopTick(prisma, deps);
    expect(validated.advanced).toHaveLength(1);
    const after = await state(id);
    const validate = (after.context as Record<string, Record<string, unknown>>).validate!;
    const report = await prisma.experimentReport.findUniqueOrThrow({ where: { id: String(validate.reportId) } });
    expect(report.approvalStatus).toBe("PENDING"); // the loop never approves its own result
    expect(report.approvedBy).toBeNull();
    expect(report.contentHash).toBe(validate.contentHash);
    expect(after.state).toBe(validate.outOfSampleValidated ? "PAPER" : "REJECTED");
    expect(await prisma.lifecycleAudit.count({ where: { strategyId: "strat_loop_challenge", toState: "CHALLENGED" } })).toBeGreaterThan(0);
  });

  it("CHALLENGE fails the experiment when the reviewer shares the forge endpoint", async () => {
    await control();
    const fx = fixtureProviders();
    const assignments = DEFAULT_ASSIGNMENTS.map((row) => (row.agentOrTask === "CHALLENGE" ? { ...row, primaryEndpointId: "anthropic-primary" } : row));
    const id = await experiment("CHALLENGE", { context: passingContext() });
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: fx.providers, assignments } });
    expect(tick.advanced).toEqual([expect.objectContaining({ id, from: "CHALLENGE", to: "FAILED", reason: expect.stringMatching(/^REVIEWER_NOT_SEPARATED/) })]);
    expect(fx.total()).toBe(0);
  });

  it("makes no model call once the persistent daily budget is spent", async () => {
    await setAutonomy(2, "1");
    await control();
    await prisma.modelUsageLog.create({
      data: { id: newId("mul"), agentOrTask: "ORACLE", endpointId: "openai-primary", provider: "fixture", model: "FIXTURE", tier: "DEEP_RESEARCHERS", ok: true, latencyMs: 1, promptTokensEst: 1, completionTokensEst: 1, costUsdEst: "1.00000000" },
    });
    const fx = fixtureProviders();
    const id = await experiment("HYPOTHESISE");
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: fx.providers } });
    expect(tick.held).toEqual([expect.objectContaining({ id, reason: expect.stringMatching(/^BUDGET_EXHAUSTED/) })]);
    expect(tick.modelCalls).toBe(0);
    expect(fx.total()).toBe(0);
    expect(await prisma.modelUsageLog.count()).toBe(1);
    const row = await state(id);
    expect(row.state).toBe("HYPOTHESISE");
    expect(row.attempts).toBe(0);
    expect(row.leaseOwner).toBeNull();
  });

  it("enforces the daily experiment cap and the concurrency cap", async () => {
    let now = await freshNow();
    await control({ maxExperimentsPerDay: 2, maxConcurrentExperiments: 10 });
    for (let index = 0; index < 4; index += 1) await hypothesis();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {} } };
    expect((await runResearchLoopTick(prisma, deps, now)).created).toHaveLength(2);
    expect((await runResearchLoopTick(prisma, deps, now)).created).toHaveLength(0);
    const extra = await enqueueResearchExperiment(prisma, { hypothesisId: await hypothesis() }, "op@odin.local", now);
    expect(extra.created).toEqual([]);
    expect(extra.refused).toMatch(/^DAILY_CAP/);

    await reset();
    now = await freshNow();
    await control({ maxExperimentsPerDay: 10, maxConcurrentExperiments: 1 });
    for (let index = 0; index < 3; index += 1) await hypothesis();
    expect((await runResearchLoopTick(prisma, deps, now)).created).toHaveLength(1);
    const refused = await enqueueResearchExperiment(prisma, { hypothesisId: await hypothesis() }, "op@odin.local", now);
    expect(refused.refused).toMatch(/^CONCURRENCY_CAP/);
  });

  it("fails an experiment with the reason once the retry ceiling is reached (no key: model step UNAVAILABLE)", async () => {
    await control({ maxAttemptsPerExperiment: 2 });
    const id = await experiment("HYPOTHESISE");
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {} } }; // no API keys, no providers
    const first = await runResearchLoopTick(prisma, deps);
    expect(first.attemptsFailed).toEqual([expect.objectContaining({ id, reason: expect.stringMatching(/^MODEL_UNAVAILABLE \(HYPOTHESISE\)/) })]);
    expect((await state(id)).attempts).toBe(1);
    const second = await runResearchLoopTick(prisma, deps);
    expect(second.advanced).toEqual([expect.objectContaining({ id, from: "HYPOTHESISE", to: "FAILED" })]);
    const row = await state(id);
    expect(row.state).toBe("FAILED");
    expect(row.attempts).toBe(2);
    expect(row.lastError).toMatch(/^RETRY_CEILING: 2\/2 attempts; last error: MODEL_UNAVAILABLE/);
    expect(await prisma.modelUsageLog.count()).toBe(0); // nothing was called, nothing was charged
    expect((await runResearchLoopTick(prisma, deps)).claimed).toEqual([]);
  });

  it("an unexpected commit failure counts an attempt, reaches FAILED at the ceiling, and leaves nothing leased (M1)", async () => {
    await control({ maxAttemptsPerExperiment: 2 });
    const victim = await experiment("OBSERVE");
    const others = [await experiment("OBSERVE"), await experiment("OBSERVE")];
    const deps: ResearchLoopDeps = {
      owner: "t1",
      router: { env: {} },
      beforeCommit: async (experimentId) => {
        if (experimentId === victim) throw new Error("injected: connection reset during commit");
      },
    };
    const first = await runResearchLoopTick(prisma, deps);
    expect(first.attemptsFailed).toEqual([expect.objectContaining({ id: victim, reason: expect.stringMatching(/^TICK_ERROR: injected/) })]);
    expect(first.advanced.map((row) => row.id).sort()).toEqual([...others].sort());
    expect(first.errors).toEqual([]);
    expect(await prisma.researchExperiment.count({ where: { leaseOwner: { not: null } } })).toBe(0);
    expect((await state(victim)).state).toBe("OBSERVE");
    expect((await state(victim)).attempts).toBe(1);

    const second = await runResearchLoopTick(prisma, deps);
    expect(second.advanced).toEqual(expect.arrayContaining([expect.objectContaining({ id: victim, to: "FAILED" })]));
    const row = await state(victim);
    expect(row.state).toBe("FAILED");
    expect(row.lastError).toMatch(/^RETRY_CEILING: 2\/2 attempts; last error: TICK_ERROR: injected/);
    expect(await prisma.researchExperiment.count({ where: { leaseOwner: { not: null } } })).toBe(0);
    expect((await runResearchLoopTick(prisma, deps)).claimed).not.toContain(victim);
  });

  it("releases every claimed lease even when the tick itself throws", async () => {
    await control();
    const ids = [await experiment("OBSERVE"), await experiment("OBSERVE")];
    await expect(
      runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, afterClaim: async () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow("boom");
    for (const id of ids) {
      const row = await state(id);
      expect(row.leaseOwner).toBeNull();
      expect(row.state).toBe("OBSERVE");
    }
  });

  it("stops and releases leases when the kill switch is turned off mid-tick", async () => {
    await control();
    const ids = [await experiment("OBSERVE"), await experiment("OBSERVE")];
    const tick = await runResearchLoopTick(prisma, {
      owner: "t1",
      router: { env: {} },
      afterClaim: async () => {
        await setResearchLoopControl(prisma, { enabled: false }, "op@odin.local");
      },
    });
    expect(tick.claimed.sort()).toEqual([...ids].sort());
    expect(tick.stoppedEarly).toBe("KILL_SWITCH_OFF");
    expect(tick.advanced).toEqual([]);
    for (const id of ids) {
      const row = await state(id);
      expect(row.leaseOwner).toBeNull();
      expect(row.state).toBe("OBSERVE");
    }
  });

  it("two concurrent ticks never claim or advance the same experiment twice", async () => {
    await control({ maxConcurrentExperiments: 4 });
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) ids.push(await experiment("OBSERVE"));
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const now = new Date();
      // Barrier: neither tick advances anything until both have claimed, so both hold leases at once.
      let arrived = 0;
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const afterClaim = async () => {
        arrived += 1;
        if (arrived === 2) open();
        await gate;
      };
      const [a, b] = await Promise.all([
        runResearchLoopTick(prisma, { owner: "tick-a", router: { env: {} }, afterClaim }, now),
        runResearchLoopTick(other, { owner: "tick-b", router: { env: {} }, afterClaim }, now),
      ]);
      expect(a.claimed.length + b.claimed.length).toBe(6);
      const overlap = a.claimed.filter((id) => b.claimed.includes(id));
      expect(overlap).toEqual([]);
      expect(a.leaseLost).toEqual([]);
      expect(b.leaseLost).toEqual([]);
      for (const id of ids) {
        expect(await transitions(id)).toHaveLength(1);
        expect((await state(id)).state).toBe("HYPOTHESISE");
      }
    } finally {
      await other.$disconnect();
    }
  });

  it("a tick cannot claim an experiment another live tick holds", async () => {
    await control({ maxConcurrentExperiments: 2 });
    const id = await experiment("OBSERVE");
    const now = new Date();
    let inner: Awaited<ReturnType<typeof runResearchLoopTick>> | null = null;
    const outer = await runResearchLoopTick(
      prisma,
      {
        owner: "tick-a",
        router: { env: {} },
        afterClaim: async () => {
          inner = await runResearchLoopTick(prisma, { owner: "tick-b", router: { env: {} } }, now);
        },
      },
      now,
    );
    expect(outer.claimed).toEqual([id]);
    expect(inner!.claimed).toEqual([]);
    expect(inner!.advanced).toEqual([]);
    expect(outer.advanced).toEqual([expect.objectContaining({ id, from: "OBSERVE", to: "HYPOTHESISE" })]);
    expect(await transitions(id)).toHaveLength(1);
  });

  it("a tick whose lease expired and was reclaimed cannot commit its stale result (version compare-and-set)", async () => {
    await control({ tickRuntimeMs: 70_000, leaseMs: 140_000 });
    const id = await experiment("OBSERVE");
    const t0 = new Date();
    let reclaimer: Awaited<ReturnType<typeof runResearchLoopTick>> | null = null;
    const slow = await runResearchLoopTick(
      prisma,
      {
        owner: "slow-tick",
        router: { env: {} },
        afterClaim: async () => {
          reclaimer = await runResearchLoopTick(prisma, { owner: "reclaimer", router: { env: {} } }, new Date(t0.getTime() + 141_000));
        },
      },
      t0,
    );
    expect(reclaimer!.reclaimed).toEqual([id]);
    expect(reclaimer!.advanced).toEqual([expect.objectContaining({ id, from: "OBSERVE", to: "HYPOTHESISE" })]);
    expect(slow.advanced).toEqual([]);
    expect(slow.leaseLost).toEqual([id]);
    expect(await transitions(id)).toHaveLength(1);
    expect((await state(id)).state).toBe("HYPOTHESISE");
  });

  it("reclaims an expired lease after a worker crash and advances the experiment once", async () => {
    await control();
    const id = await experiment("OBSERVE");
    const t0 = new Date();
    const dead = await claimResearchExperiments(prisma, { owner: "crashed-worker", now: t0, leaseMs: 200_000, limit: 5 });
    expect(dead.claimed.map((row) => row.id)).toEqual([id]);

    const early = await runResearchLoopTick(prisma, { owner: "survivor", router: { env: {} } }, new Date(t0.getTime() + 30_000));
    expect(early.claimed).toEqual([]);

    const later = await runResearchLoopTick(prisma, { owner: "survivor", router: { env: {} } }, new Date(t0.getTime() + 201_000));
    expect(later.reclaimed).toEqual([id]);
    expect(later.advanced).toEqual([expect.objectContaining({ id, from: "OBSERVE", to: "HYPOTHESISE" })]);
    const reclaimedEvent = await prisma.researchExperimentEvent.findFirst({ where: { experimentId: id, kind: "LEASE_RECLAIMED" } });
    expect((reclaimedEvent?.evidence as Record<string, unknown>).previousOwner).toBe("crashed-worker");
    expect(await transitions(id)).toHaveLength(1);
    expect((await state(id)).leaseOwner).toBeNull();
  });

  it("leaves EngineControl, promotions and risk configuration byte-identical; PAPER is a research label only", async () => {
    const snapshot = async () => {
      const tables = ["EngineControl", "StrategyPromotion", "PromotionApproval", "EngineConfigRevision", "StrategyInstance", "StrategyAllocation", "RiskReservation", "AccountSafetyState"];
      const parts: string[] = [];
      for (const table of tables) {
        const rows = await prisma.$queryRawUnsafe<Array<{ j: unknown }>>(`SELECT row_to_json(t)::text AS j FROM "${table}" t ORDER BY 1`);
        parts.push(`${table}:${createHash("sha256").update(rows.map((row) => String(row.j)).join("\n")).digest("hex")}`);
      }
      const autonomy = await prisma.autonomyControl.findUniqueOrThrow({ where: { id: "primary" } });
      parts.push(`autonomy:${autonomy.allowRiskLimitMutation}:${autonomy.realMoneyExecutionEnabled}:${autonomy.allowUnreviewedCodeDeploy}`);
      parts.push(`DEFAULT_STRATEGY:${createHash("sha256").update(JSON.stringify(DEFAULT_STRATEGY)).digest("hex")}`);
      return parts;
    };
    const before = await snapshot();
    const now = await freshNow();
    await control({ maxExperimentsPerDay: 5 });
    const fx = fixtureProviders();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers }, forge: countingForge().fn };
    await hypothesis();
    const contentHash = createHash("sha256").update("report").digest("hex");
    const paper = await experiment("PAPER", { context: { forge: { strategyId: "strat_loop_test" }, validate: { reportId: "rpt_loop_test", contentHash } } });
    for (let index = 0; index < 4; index += 1) await runResearchLoopTick(prisma, deps, now);
    expect((await state(paper)).state).toBe("BLOCKED_APPROVAL");
    expect((await approve(paper, "promote_paper")).ok).toBe(true);
    await runResearchLoopTick(prisma, deps, now);
    await runResearchLoopTick(prisma, deps, now);
    expect((await state(paper)).state).toBe("REVIEW");
    const label = await prisma.lifecycleAudit.findFirst({ where: { strategyId: "strat_loop_test", toState: "PAPER_CANDIDATE" }, orderBy: { createdAt: "desc" } });
    expect((label?.evidence as Record<string, unknown>).experimentId).toBe(paper);
    // REVIEW is never claimed again; only an operator acts on it.
    const after = await runResearchLoopTick(prisma, deps, now);
    expect(after.claimed).not.toContain(paper);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses limits that would starve model stages or let a lease lapse mid-tick", async () => {
    await expect(control({ tickRuntimeMs: 60_000, leaseMs: 300_000 })).rejects.toThrow();
    await expect(control({ tickRuntimeMs: 100_000, leaseMs: 150_000 })).rejects.toThrow(/at least twice/);
    await expect(
      prisma.researchLoopControl.create({ data: { id: "primary", tickRuntimeMs: 100_000, leaseMs: 150_000 } }),
    ).rejects.toThrow();
    await expect(prisma.researchLoopControl.create({ data: { id: "primary", tickRuntimeMs: 60_000, leaseMs: 600_000 } })).rejects.toThrow();
    await expect(prisma.researchLoopControl.create({ data: { id: "primary", maxConcurrentExperiments: 50 } })).rejects.toThrow();
  });

  it("append-only triggers reject UPDATE, DELETE and TRUNCATE; terminal experiments are frozen", async () => {
    const id = await experiment("BLOCKED_APPROVAL", { blockedState: "FORGE", context: { hypothesis: restated } });
    await prisma.researchExperimentEvent.create({
      data: { id: newId("rxev"), experimentId: id, kind: "CREATED", toState: "OBSERVE", actor: "t", evidence: {}, evidenceHash: "x" },
    });
    expect((await approve(id, "forge_code")).ok).toBe(true);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchExperimentEvent" SET "reason" = 'x'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchExperimentEvent"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "ResearchExperimentEvent"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchApproval" SET "expiresAt" = "expiresAt" + interval '1 day'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchApproval"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "ResearchApproval"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "ResearchExperiment" CASCADE`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchExperiment"`)).rejects.toThrow(/never deleted/);
    await prisma.researchExperiment.update({ where: { id }, data: { state: "FAILED", blockedState: null } });
    await expect(prisma.researchExperiment.update({ where: { id }, data: { state: "OBSERVE" } })).rejects.toThrow(/terminal/);
    await expect(prisma.researchExperiment.update({ where: { id }, data: { lastError: "rewritten" } })).rejects.toThrow(/frozen/);
    await expect(prisma.researchExperiment.update({ where: { id }, data: { context: toJson({ forged: "after the fact" }) } })).rejects.toThrow(/frozen/);
    await expect(
      prisma.researchApproval.create({ data: { id: newId("rapr"), experimentId: id, action: "mutate_risk_limits", approvedBy: "op", expiresAt: new Date(Date.now() + 60_000), subjectHash: otherHash } }),
    ).rejects.toThrow();
    await expect(
      prisma.researchApproval.create({ data: { id: newId("rapr"), experimentId: id, action: "forge_code", approvedBy: "op", expiresAt: new Date(Date.now() + 60_000), subjectHash: "not-a-hash" } }),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------------------------------
  // GENESIS Phase 8
  // -------------------------------------------------------------------------------------------------

  /** An experiment ready for TEST on the hypothesis' own seeded dataset (level 3: no approval needed). */
  const atTest = async (options: { hypothesisId?: string; pin?: Partial<PinnedDataset>; strategyId?: string; source?: string; now?: Date } = {}) => {
    const hypothesisId = options.hypothesisId ?? (await hypothesis("TESTING"));
    const pinned = { ...(await pinFor(hypothesisId, options.now ?? new Date())), ...(options.pin ?? {}) };
    const id = await experiment("TEST", { hypothesisId, context: { hypothesis: restated, dataset: pinned, forge: forgedContext(options.strategyId, options.source) } });
    return { id, hypothesisId, pinned };
  };
  const recordingExecutor = () => {
    const seen: Array<{ bars: number; maxReceivedAt: number }> = [];
    const fn: typeof executeCompiledStrategy = async (input) => {
      seen.push({ bars: input.bars.length, maxReceivedAt: Math.max(...input.bars.map((bar) => Date.parse(bar.receivedAt))) });
      return holdExecutor(input);
    };
    return { fn, seen };
  };
  const eventsOf = (id: string, kind: string) => prisma.researchExperimentEvent.findMany({ where: { experimentId: id, kind } });

  it("TEST reads only bars available at or before the pinned as-of time and records dataset id, version, window and count", async () => {
    await setAutonomy(3);
    await control();
    const hypothesisId = await hypothesis("TESTING");
    const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: datasetOf.get(hypothesisId)! } });
    // As of the close of bar 549: 550 bars usable, 50 later bars must never reach the sandbox.
    const asOf = new Date(dataset.firstOpenTime!.getTime() + 550 * HOUR);
    const { id } = await atTest({ hypothesisId, pin: { asOf: asOf.toISOString() } });
    const exec = recordingExecutor();
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: exec.fn });
    expect(tick.advanced).toEqual([expect.objectContaining({ id, from: "TEST", to: "CHALLENGE" })]);
    expect(exec.seen).toEqual([{ bars: 550, maxReceivedAt: asOf.getTime() }]);
    const test = ((await state(id)).context as Record<string, Record<string, unknown>>).test!;
    expect(test.dataset).toEqual(expect.objectContaining({ datasetId: dataset.id, versionHash: dataset.versionHash, barCount: 550, excludedAfterAsOf: 50, maxAvailableAt: asOf.toISOString(), asOf: asOf.toISOString() }));
    const event = (await transitions(id)).find((row) => row.toState === "CHALLENGE");
    expect(((event?.evidence as Record<string, Record<string, unknown>>).dataset)?.windowHash).toBe((test.dataset as Record<string, unknown>).windowHash);
  });

  it("refuses a stale dataset version and an instrument mismatch with typed, recorded failures (nothing executed)", async () => {
    await setAutonomy(3);
    await control();
    const exec = recordingExecutor();
    const stale = await atTest({ pin: { versionHash: "0".repeat(64) } });
    const otherHypothesis = await hypothesis("TESTING");
    const foreign = await pinFor(otherHypothesis);
    const mismatch = await atTest({ pin: { datasetId: foreign.datasetId, versionHash: foreign.versionHash, instrumentKey: foreign.instrumentKey } });
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: exec.fn });
    expect(tick.advanced).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: stale.id, from: "TEST", to: "FAILED", reason: expect.stringMatching(/^DATASET_VERSION_STALE/) }),
        expect.objectContaining({ id: mismatch.id, from: "TEST", to: "FAILED", reason: expect.stringMatching(/^INSTRUMENT_MISMATCH/) }),
      ]),
    );
    expect(exec.seen).toEqual([]);
    expect((await eventsOf(stale.id, "DATASET_REFUSED"))[0]?.evidence).toEqual(expect.objectContaining({ code: "DATASET_VERSION_STALE", stage: "TEST" }));
    expect((await eventsOf(mismatch.id, "DATASET_REFUSED"))[0]?.evidence).toEqual(expect.objectContaining({ code: "INSTRUMENT_MISMATCH" }));
  });

  it("HYPOTHESISE records DATASET_UNAVAILABLE without a model call when the hypothesis has no dataset", async () => {
    await control();
    const fx = fixtureProviders();
    const id = await experiment("HYPOTHESISE", { hypothesisId: await hypothesis("TESTING", { withDataset: false }) });
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: fx.providers } });
    expect(tick.advanced).toEqual([expect.objectContaining({ id, to: "FAILED", reason: expect.stringMatching(/^DATASET_UNAVAILABLE/) })]);
    expect(fx.total()).toBe(0);
    expect(await eventsOf(id, "DATASET_REFUSED")).toHaveLength(1);
  });

  it("refuses a near-duplicate before TEST, even before asking for approval, and records REDUNDANCY_REFUSED", async () => {
    await setAutonomy(3);
    await control();
    const first = await atTest();
    await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: holdExecutor });
    expect((await state(first.id)).state).toBe("CHALLENGE");
    await prisma.researchExperiment.update({ where: { id: first.id }, data: { state: "ABANDONED", lastError: "test" } });

    await setAutonomy(2); // level 2 would ask for run_backtest approval; the duplicate is refused first
    const exec = recordingExecutor();
    const duplicate = await atTest({ hypothesisId: first.hypothesisId });
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: exec.fn });
    expect(tick.advanced).toEqual([expect.objectContaining({ id: duplicate.id, from: "TEST", to: "REJECTED", reason: expect.stringMatching(/^REDUNDANT_DUPLICATE_EXPERIMENT/) })]);
    expect(exec.seen).toEqual([]);
    expect((await eventsOf(duplicate.id, "REDUNDANCY_REFUSED"))[0]?.evidence).toEqual(expect.objectContaining({ code: "DUPLICATE_EXPERIMENT", priorExperimentId: first.id }));
  });

  it("refuses a renamed candidate (same canonical source on a new dataset version) and a reused holdout", async () => {
    await setAutonomy(3);
    await control();
    const first = await atTest();
    await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: holdExecutor });
    expect((await state(first.id)).state).toBe("CHALLENGE");
    await prisma.researchExperiment.update({ where: { id: first.id }, data: { state: "ABANDONED", lastError: "test" } });

    // Same instrument and interval, another source: a new dataset version, so not a duplicate.
    const sibling = await seedDataset(instrumentOf(first.hypothesisId), { sourceId: "genesis-test-sibling", bars: 700 });
    const reformatted = `/* the same code under a new name */\nexport function onBar( input ) { return { intent: "HOLD", reasonCodes: ["LOOP_TEST"] }; }\n`;
    const renamed = await atTest({ hypothesisId: first.hypothesisId, strategyId: "strat_renamed_copy", source: reformatted });
    expect(renamed.pinned.datasetId).toBe(sibling); // most bars wins the pin
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: holdExecutor });
    expect(tick.advanced).toEqual([expect.objectContaining({ id: renamed.id, to: "REJECTED", reason: expect.stringMatching(/^REDUNDANT_RENAMED_CANDIDATE/) })]);

    // A holdout the registry already consumed for this strategy (here by the ASCEND-03 CLI) is never looked at again.
    const fresh = await hypothesis("TESTING");
    await prisma.researchHoldoutAccess.create({ data: { id: newId("rhoa"), strategyId: "strat_cli_owned", strategyVersion: "1.0.0", datasetId: datasetOf.get(fresh)!, runId: "run_cli" } });
    const reused = await atTest({ hypothesisId: fresh, strategyId: "strat_cli_owned", source: `export function onBar(input) {\n  return { intent: "HOLD", reasonCodes: ["CLI"] };\n}\n` });
    const second = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: holdExecutor });
    expect(second.advanced).toEqual([expect.objectContaining({ id: reused.id, to: "REJECTED", reason: expect.stringMatching(/^REDUNDANT_HOLDOUT_REUSED/) })]);
    expect((await eventsOf(reused.id, "REDUNDANCY_REFUSED"))[0]?.evidence).toEqual(expect.objectContaining({ code: "HOLDOUT_REUSED" }));
  });

  it("autonomous intake follows the deterministic scorer and retries a failed hypothesis only on new data", async () => {
    const now = await freshNow();
    await control({ maxExperimentsPerDay: 10, maxConcurrentExperiments: 10 });
    const noData = await hypothesis("OPEN", { withDataset: false });
    const withData = await hypothesis("OPEN");
    const first = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} } }, now);
    expect(first.intake?.queued.map((row) => row.hypothesisId)).toEqual([withData, noData]); // data first, then the 0-score gap
    const created = await prisma.researchExperimentEvent.findFirst({ where: { kind: "CREATED", experiment: { hypothesisId: withData } } });
    expect((created?.evidence as Record<string, Record<string, unknown>>).selection).toEqual(expect.objectContaining({ rank: 1 }));

    // End the experiment after it pinned the dataset; with the same data it is not queued again.
    const rows = await prisma.researchExperiment.findMany({ where: { hypothesisId: { in: [withData, noData] } } });
    const pinned = await pinFor(withData, now);
    for (const row of rows) {
      await prisma.researchExperiment.update({ where: { id: row.id }, data: { state: "FAILED", lastError: "test", context: toJson(row.hypothesisId === withData ? { dataset: pinned } : {}) } });
    }
    const again = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} } }, now);
    expect(again.created).toEqual([]);
    expect(Object.fromEntries((again.intake?.skipped ?? []).map((row) => [row.hypothesisId, row.reason]))).toEqual(expect.objectContaining({ [withData]: "NO_NEW_EVIDENCE", [noData]: "NO_NEW_EVIDENCE" }));

    // New data (re-import changed the versionHash): the failed hypothesis is queued again, scored for new data.
    await prisma.historicalDataset.update({ where: { id: datasetOf.get(withData)! }, data: { versionHash: createHash("sha256").update(newId("v")).digest("hex") } });
    const retried = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} } }, now);
    expect(retried.intake?.queued).toEqual([expect.objectContaining({ hypothesisId: withData, components: expect.objectContaining({ newData: 300 }) })]);
  });

  it("budget reservations serialise across connections and fail closed; an orphaned reservation still counts", async () => {
    await setAutonomy(2, "1");
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const now = new Date();
      const reserve = (client: PrismaClient, experimentId: string) =>
        reserveResearchBudget(client, { now, capUsd: "1", reserveUsd: "0.99990000", agent: "ORACLE", endpointId: "openai-primary", tier: "DEEP_RESEARCHERS", experimentId });
      const [a, b] = await Promise.all([reserve(prisma, "rexp_a"), reserve(other, "rexp_b")]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1); // 0.9999 twice > 1: only one may hold it
      expect(await prisma.modelUsageLog.count({ where: { costKind: "RESERVED" } })).toBe(1);

      // The holder "crashed": its reservation stays counted, so a tick makes no call (BUDGET_EXHAUSTED, HELD event).
      await control();
      const fx = fixtureProviders();
      const id = await experiment("HYPOTHESISE");
      const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: fx.providers } }, now);
      expect(tick.held).toEqual([expect.objectContaining({ id, reason: expect.stringMatching(/^BUDGET_EXHAUSTED: RESERVATION_REFUSED/) })]);
      expect(fx.total()).toBe(0);
      expect(await eventsOf(id, "HELD")).toHaveLength(1);
      // The same hold on the next tick is not logged again.
      await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: fx.providers } }, now);
      expect(await eventsOf(id, "HELD")).toHaveLength(1);
      expect(d((await researchSpend(now))).gte("0.9999")).toBe(true);
    } finally {
      await other.$disconnect();
    }
  });

  it("a successful model call settles its reservation (no RESERVED row remains; usage is recorded)", async () => {
    await control();
    const fx = fixtureProviders();
    const id = await experiment("HYPOTHESISE");
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: fx.providers } });
    expect(tick.advanced).toEqual([expect.objectContaining({ id, from: "HYPOTHESISE", to: "FORGE" })]);
    expect(await prisma.modelUsageLog.count({ where: { costKind: "RESERVED" } })).toBe(0);
    expect(await prisma.modelUsageLog.count()).toBe(1);
    expect(((await state(id)).context as Record<string, Record<string, unknown>>).dataset?.datasetId).toBeTruthy();
  });

  it("review M1: with two datasets per hypothesis, a failed hypothesis is not re-queued for the never-pinned dataset, and one hypothesis gets one holdout look per dataset version", async () => {
    const now = await freshNow();
    await control({ maxExperimentsPerDay: 10, maxConcurrentExperiments: 10 });
    const hypothesisId = await hypothesis("OPEN");
    // A second, smaller dataset of the same instrument: the pin never chooses it.
    await seedDataset(instrumentOf(hypothesisId), { sourceId: "genesis-test-small", bars: 520 });
    const first = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} } }, now);
    expect(first.created).toHaveLength(1);
    const pinned = await pinFor(hypothesisId, now);
    expect(pinned.datasetId).toBe(datasetOf.get(hypothesisId)); // 600 bars beats 520
    await prisma.researchExperiment.update({ where: { id: first.created[0]! }, data: { state: "FAILED", lastError: "test", context: toJson({ dataset: pinned }) } });
    for (let tick = 0; tick < 2; tick += 1) {
      const again = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} } }, now);
      expect(again.created).toEqual([]);
      expect(again.intake?.skipped).toEqual(expect.arrayContaining([{ hypothesisId, reason: "NO_NEW_EVIDENCE" }]));
    }

    // Even if it were queued, a new model-written source for the same hypothesis and dataset version is refused.
    await setAutonomy(3);
    await control();
    const measured = await atTest({ hypothesisId });
    await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: holdExecutor });
    expect((await state(measured.id)).state).toBe("CHALLENGE");
    await prisma.researchExperiment.update({ where: { id: measured.id }, data: { state: "ABANDONED", lastError: "test" } });
    const variant = await atTest({ hypothesisId, strategyId: "strat_variant", source: `export function onBar(input) {\n  return { intent: "HOLD", reasonCodes: ["VARIANT"] };\n}\n` });
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {} }, execute: holdExecutor });
    expect(tick.advanced).toEqual([expect.objectContaining({ id: variant.id, to: "REJECTED", reason: expect.stringMatching(/^REDUNDANT_HOLDOUT_REUSED: Hypothesis/) })]);
  });

  it("review M2/L1: a failed model attempt keeps its reservation counted (fail closed) and reports it", async () => {
    await control();
    const failing: ModelProvider = {
      id: "fixture",
      completeJson: async () => ({ ok: false, code: "UPSTREAM", error: "injected upstream failure", provider: "fixture" }),
    };
    const id = await experiment("HYPOTHESISE");
    const tick = await runResearchLoopTick(prisma, { owner: "t1", router: { env: {}, providers: new Map([["openai-primary", failing]]) } });
    expect(tick.attemptsFailed).toEqual([expect.objectContaining({ id })]);
    expect(tick.reservationsRetained).toEqual([expect.objectContaining({ experimentId: id, reason: expect.stringMatching(/^FAILED_ATTEMPT/) })]);
    const kept = await prisma.modelUsageLog.findMany({ where: { costKind: "RESERVED" } });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.error).toMatch(/^RETAINED for research experiment/);
  });

  const researchSpend = async (now: Date) => {
    const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const sum = await prisma.modelUsageLog.aggregate({ _sum: { costUsdEst: true }, where: { createdAt: { gte: windowStart } } });
    return sum._sum.costUsdEst?.toFixed(8) ?? "0";
  };
});
