import { createHash } from "node:crypto";
import type { LlmRequest, LlmResult, ModelProvider } from "@odin/agent-core";
import type { BacktestObservation } from "@odin/backtest";
import { DEFAULT_STRATEGY, newId } from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { compileStrategySource } from "./compile-strategy.js";
import { FixtureModelProvider } from "./fixture-provider.js";
import type { forgeStrategyModule } from "./forge.js";
import {
  claimResearchExperiments,
  enqueueResearchExperiment,
  recordResearchApproval,
  runResearchLoopTick,
  setResearchLoopControl,
  type ResearchLoopDeps,
} from "./research-loop.js";
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

  const reset = async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "ResearchApproval", "ResearchExperimentEvent", "ResearchExperiment", "ResearchLoopControl", "ModelUsageLog" RESTART IDENTITY CASCADE`,
    );
    await prisma.hypothesis.deleteMany({ where: { createdBy: "ascend08-test" } });
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

  const experiment = async (state: string, extra: { context?: Record<string, unknown>; attempts?: number; hypothesisId?: string } = {}) => {
    const id = newId("rexp");
    await prisma.researchExperiment.create({
      data: {
        id,
        hypothesisId: extra.hypothesisId ?? (await hypothesis("TESTING")),
        state,
        attempts: extra.attempts ?? 0,
        context: toJson(extra.context ?? {}),
        createdBy: "ascend08-test",
      },
    });
    return id;
  };

  const control = (overrides: Record<string, unknown> = {}) =>
    setResearchLoopControl(
      prisma,
      { enabled: true, maxExperimentsPerDay: 10, maxConcurrentExperiments: 10, maxAttemptsPerExperiment: 3, tickRuntimeMs: 60_000, leaseMs: 120_000, ...overrides },
      "ascend08-test",
    );

  const state = async (id: string) => prisma.researchExperiment.findUniqueOrThrow({ where: { id } });
  const transitions = (id: string) => prisma.researchExperimentEvent.findMany({ where: { experimentId: id, kind: "TRANSITION" }, orderBy: { createdAt: "asc" } });

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
    const fx = fixtureProviders();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers } };

    expect((await runResearchLoopTick(prisma, deps)).status).toBe("DISABLED"); // no control row
    await control({ enabled: false });
    const off = await runResearchLoopTick(prisma, deps);
    expect(off.status).toBe("DISABLED");
    expect(off.reason).toBe("Kill switch is off");

    await control({ enabled: true });
    await setAutonomy(1);
    expect((await runResearchLoopTick(prisma, deps)).status).toBe("AUTONOMY_INSUFFICIENT");
    await setAutonomy(4);
    expect((await runResearchLoopTick(prisma, deps)).status).toBe("AUTONOMY_INSUFFICIENT");

    expect(await prisma.researchExperiment.count()).toBe(0);
    expect(await prisma.modelUsageLog.count()).toBe(0);
    expect(fx.total()).toBe(0);
  });

  it("blocks forging without approval, refuses an expired or wrong-action approval, and proceeds with a valid one", async () => {
    await control();
    const hypothesisId = await hypothesis();
    const fx = fixtureProviders();
    const forge = countingForge();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers }, forge: forge.fn };

    const first = await runResearchLoopTick(prisma, deps);
    expect(first.created).toHaveLength(1);
    const id = first.created[0]!;
    expect(first.advanced).toEqual([expect.objectContaining({ id, from: "OBSERVE", to: "HYPOTHESISE" })]);

    const second = await runResearchLoopTick(prisma, deps);
    expect(second.advanced).toEqual([expect.objectContaining({ id, from: "HYPOTHESISE", to: "FORGE" })]);
    expect(fx.oracle.calls).toBe(1);
    expect(await prisma.modelUsageLog.count()).toBe(1); // onUsage persisted the call

    // Level 2: forge_code requires approval. None exists, so the forge is not executed.
    const third = await runResearchLoopTick(prisma, deps);
    expect(third.advanced).toEqual([expect.objectContaining({ id, from: "FORGE", to: "BLOCKED_APPROVAL" })]);
    expect((await state(id)).blockedState).toBe("FORGE");
    expect(fx.forge.calls).toBe(0);
    expect(forge.calls).toHaveLength(0);

    // Expired approval and an approval for a different action are both refused.
    const now = new Date();
    await prisma.researchApproval.create({
      data: { id: newId("rapr"), experimentId: id, action: "forge_code", approvedBy: "op", approvedAt: new Date(now.getTime() - 7_200_000), expiresAt: new Date(now.getTime() - 3_600_000) },
    });
    await recordResearchApproval(prisma, id, { action: "promote_paper" }, "op@odin.local");
    const stillBlocked = await runResearchLoopTick(prisma, deps);
    expect(stillBlocked.advanced).toEqual([]);
    expect(stillBlocked.held).toEqual([expect.objectContaining({ id, reason: "AWAITING_APPROVAL: forge_code" })]);
    expect((await state(id)).state).toBe("BLOCKED_APPROVAL");
    expect(forge.calls).toHaveLength(0);

    // A future-dated approval is not yet valid either.
    await prisma.researchApproval.create({
      data: { id: newId("rapr"), experimentId: id, action: "forge_code", approvedBy: "op", approvedAt: new Date(now.getTime() + 3_600_000), expiresAt: new Date(now.getTime() + 7_200_000) },
    });
    expect((await runResearchLoopTick(prisma, deps)).advanced).toEqual([]);

    const approval = await recordResearchApproval(prisma, id, { action: "forge_code", ttlMinutes: 60 }, "op@odin.local");
    expect(approval.ok).toBe(true);
    const unblocked = await runResearchLoopTick(prisma, deps);
    expect(unblocked.advanced).toEqual([expect.objectContaining({ id, from: "BLOCKED_APPROVAL", to: "FORGE" })]);
    expect(forge.calls).toHaveLength(0); // one state per tick: unblocking does not also forge

    const forged = await runResearchLoopTick(prisma, deps);
    expect(forged.advanced).toEqual([expect.objectContaining({ id, from: "FORGE", to: "TEST" })]);
    expect(forge.calls).toEqual([hypothesisId]);
    expect(fx.forge.calls).toBe(1);
    const forgeEvent = (await transitions(id)).find((row) => row.fromState === "FORGE" && row.toState === "TEST");
    expect((forgeEvent?.evidence as Record<string, unknown>).approvalId).toBe(approval.ok ? approval.approval.id : null);

    // run_backtest also needs its own approval at level 2.
    const testTick = await runResearchLoopTick(prisma, deps);
    expect(testTick.advanced).toEqual([expect.objectContaining({ id, from: "TEST", to: "BLOCKED_APPROVAL" })]);
    expect((await state(id)).blockedState).toBe("TEST");
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
    const id = await experiment("FORGE", { context: { hypothesis: { title: "t", falsifier: "falsifier text", conditions: "conditions text" } } });
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
    await control({ maxExperimentsPerDay: 2, maxConcurrentExperiments: 10 });
    for (let index = 0; index < 4; index += 1) await hypothesis();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {} } };
    expect((await runResearchLoopTick(prisma, deps)).created).toHaveLength(2);
    expect((await runResearchLoopTick(prisma, deps)).created).toHaveLength(0);
    const extra = await enqueueResearchExperiment(prisma, { hypothesisId: await hypothesis() }, "op@odin.local");
    expect(extra.created).toEqual([]);
    expect(extra.refused).toMatch(/^DAILY_CAP/);
    expect(await prisma.researchExperiment.count()).toBe(2);

    await reset();
    await control({ maxExperimentsPerDay: 10, maxConcurrentExperiments: 1 });
    for (let index = 0; index < 3; index += 1) await hypothesis();
    expect((await runResearchLoopTick(prisma, deps)).created).toHaveLength(1);
    const refused = await enqueueResearchExperiment(prisma, { hypothesisId: await hypothesis() }, "op@odin.local");
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
      for (const id of [...a.claimed, ...b.claimed]) {
        expect(await transitions(id)).toHaveLength(1);
        expect((await state(id)).state).toBe("HYPOTHESISE");
      }
      for (const id of ids.filter((id) => !a.claimed.includes(id) && !b.claimed.includes(id))) {
        expect((await state(id)).state).toBe("OBSERVE");
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
        // While tick A holds its lease, tick B runs to completion.
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
    await control({ leaseMs: 120_000 });
    const id = await experiment("OBSERVE");
    const t0 = new Date();
    let reclaimer: Awaited<ReturnType<typeof runResearchLoopTick>> | null = null;
    const slow = await runResearchLoopTick(
      prisma,
      {
        owner: "slow-tick",
        router: { env: {} },
        afterClaim: async () => {
          reclaimer = await runResearchLoopTick(prisma, { owner: "reclaimer", router: { env: {} } }, new Date(t0.getTime() + 121_000));
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
    const dead = await claimResearchExperiments(prisma, { owner: "crashed-worker", now: t0, leaseMs: 60_000, limit: 5 });
    expect(dead.claimed.map((row) => row.id)).toEqual([id]);

    const early = await runResearchLoopTick(prisma, { owner: "survivor", router: { env: {} } }, new Date(t0.getTime() + 30_000));
    expect(early.claimed).toEqual([]);

    const later = await runResearchLoopTick(prisma, { owner: "survivor", router: { env: {} } }, new Date(t0.getTime() + 61_000));
    expect(later.reclaimed).toEqual([id]);
    expect(later.advanced).toEqual([expect.objectContaining({ id, from: "OBSERVE", to: "HYPOTHESISE" })]);
    const reclaimedEvent = await prisma.researchExperimentEvent.findFirst({ where: { experimentId: id, kind: "LEASE_RECLAIMED" } });
    expect((reclaimedEvent?.evidence as Record<string, unknown>).previousOwner).toBe("crashed-worker");
    expect(await transitions(id)).toHaveLength(1);
    const row = await state(id);
    expect(row.leaseOwner).toBeNull();
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
    await control();
    const fx = fixtureProviders();
    const deps: ResearchLoopDeps = { owner: "t1", router: { env: {}, providers: fx.providers }, forge: countingForge().fn };
    await hypothesis();
    const paper = await experiment("PAPER", { context: { forge: { strategyId: "strat_loop_test" }, validate: { reportId: "rpt_loop_test" } } });
    for (let index = 0; index < 4; index += 1) await runResearchLoopTick(prisma, deps);
    expect((await state(paper)).state).toBe("BLOCKED_APPROVAL");
    await recordResearchApproval(prisma, paper, { action: "promote_paper" }, "op@odin.local");
    await runResearchLoopTick(prisma, deps);
    await runResearchLoopTick(prisma, deps);
    expect((await state(paper)).state).toBe("REVIEW");
    const label = await prisma.lifecycleAudit.findFirst({ where: { strategyId: "strat_loop_test", toState: "PAPER_CANDIDATE" }, orderBy: { createdAt: "desc" } });
    expect((label?.evidence as Record<string, unknown>).experimentId).toBe(paper);
    // REVIEW is never claimed again; only an operator acts on it.
    const after = await runResearchLoopTick(prisma, deps);
    expect(after.claimed).not.toContain(paper);
    expect(await snapshot()).toEqual(before);
  });

  it("append-only triggers reject UPDATE and DELETE; terminal experiments are frozen", async () => {
    const id = await experiment("OBSERVE");
    await prisma.researchExperimentEvent.create({
      data: { id: "rxev_fixed", experimentId: id, kind: "CREATED", toState: "OBSERVE", actor: "t", evidence: {}, evidenceHash: "x" },
    });
    await recordResearchApproval(prisma, id, { action: "forge_code" }, "op@odin.local");
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchExperimentEvent" SET "reason" = 'x'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchExperimentEvent"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ResearchApproval" SET "expiresAt" = "expiresAt" + interval '1 day'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchApproval"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ResearchExperiment"`)).rejects.toThrow(/never deleted/);
    await prisma.researchExperiment.update({ where: { id }, data: { state: "FAILED" } });
    await expect(prisma.researchExperiment.update({ where: { id }, data: { state: "OBSERVE" } })).rejects.toThrow(/terminal/);
    await expect(
      prisma.researchApproval.create({ data: { id: newId("rapr"), experimentId: id, action: "mutate_risk_limits", approvedBy: "op", expiresAt: new Date(Date.now() + 60_000) } }),
    ).rejects.toThrow();
    await expect(prisma.researchLoopControl.create({ data: { id: "primary", maxConcurrentExperiments: 50 } })).rejects.toThrow();
  });
});
