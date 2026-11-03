import { createHash } from "node:crypto";
import type { LlmRequest, LlmResult, ModelProvider } from "@odin/agent-core";
import type { BacktestObservation } from "@odin/backtest";
import { chronologicalSplits } from "@odin/backtest";
import { DEFAULT_STRATEGY, newId } from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { compileStrategySource } from "./compile-strategy.js";
import { FixtureModelProvider } from "./fixture-provider.js";
import type { forgeStrategyModule } from "./forge.js";
import {
  approvalSubject,
  claimResearchExperiments,
  enqueueResearchExperiment,
  listResearchExperiments,
  recordResearchApproval,
  runResearchLoopTick,
  setResearchLoopControl,
  type ResearchLoopDeps,
} from "./research-loop.js";
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

function observations(now: Date, count: number): BacktestObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `obs_loop_${index}`,
    pairAddress: "pairLoopTest0001",
    baseSymbol: "TST",
    quoteAddress: "So11111111111111111111111111111111111111112",
    quoteSymbol: "SOL",
    priceUsd: (1 + index / 100).toFixed(4),
    liquidityUsd: "250000",
    volume24hUsd: "900000",
    volume5mUsd: "10000",
    priceChangeM5Pct: "0.5",
    priceChangeH1Pct: "1.0",
    txnsM5Buys: 10,
    txnsM5Sells: 8,
    receivedAt: new Date(now.getTime() - (count - index) * 60_000).toISOString(),
    freshness: "REPLAY" as const,
    provenance: "test",
  }));
}

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

  const hypothesis = async (status = "OPEN") => {
    const id = newId("hyp");
    await prisma.hypothesis.create({
      data: {
        id,
        title: `Loop test ${id.slice(-6)}`,
        market: "SPOT_CRYPTO_PAIR",
        instrumentIds: ["solana:spot:universe"],
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
      loadObservations: async () => observations(now, 40),
    };
    const id = await experiment("FORGE", { context: { hypothesis: restated } });
    expect((await runResearchLoopTick(prisma, deps, now)).advanced).toEqual([expect.objectContaining({ id, from: "FORGE", to: "TEST" })]);
    expect((await runResearchLoopTick(prisma, deps, now)).advanced).toEqual([expect.objectContaining({ id, from: "TEST", to: "CHALLENGE" })]);
    const measured = (await state(id)).context as Record<string, Record<string, unknown>>;
    expect(measured.test!.observationCount).toBe(40);
    expect(measured.test!.measuredReturnPct).toBeNull(); // HOLD-only: no closed trades, nothing invented
    expect(measured.test!.measuredSampleSize).toBe(0);
    const challenged = await runResearchLoopTick(prisma, deps, now);
    expect(challenged.advanced).toEqual([expect.objectContaining({ id, from: "CHALLENGE", to: "REJECTED" })]);
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
});
