import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DEFAULT_ASSIGNMENTS,
  ModelRouter,
  assertKnownTier,
  capturePhaseContext,
  compareStrategies,
  createOracleSupervisor,
  dailyBriefing,
  detectDeterioration,
  DEFAULT_ORACLE_LIMITS,
  ORACLE_CAPABILITIES,
  admitOracleItem,
  enqueueResearch,
  proposeOracleCycle,
  forgeStrategyModule,
  parseAutonomyPolicy,
  runChallengeReview,
  runResearchPipeline,
  searchTradeMemory,
  transitionLifecycle,
  verifyExperimentReport,
  type ExperimentReport,
} from "@odin/evolution";
import {
  IndexMarketProvider,
  createInstrumentRegistry,
  validateStrategyUniverse,
} from "@odin/market-data";
import {
  DEFAULT_AUTONOMY,
  SEED_INSTRUMENTS,
  d,
  hypothesisSchema,
  newId,
} from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { z } from "zod";

@Injectable()
export class EvolutionService {
  private readonly indexProvider = new IndexMarketProvider({ useDelayedApi: false });

  constructor(private readonly prisma: PrismaClient) {}

  async ensureSeeds() {
    for (const instrument of SEED_INSTRUMENTS) {
      await this.prisma.instrument.upsert({
        where: { id: instrument.id },
        create: {
          id: instrument.id,
          symbol: instrument.symbol,
          displayName: instrument.displayName,
          venue: instrument.venue,
          assetClass: instrument.assetClass,
          base: instrument.base,
          quote: instrument.quote,
          tickSize: instrument.tickSize,
          lotSize: instrument.lotSize,
          session: instrument.session,
          providerId: instrument.providerId,
          providerSymbol: instrument.providerSymbol,
          executionCapabilities: [...instrument.executionCapabilities],
          enabledByDefault: instrument.enabledByDefault,
          notes: instrument.notes ?? null,
        },
        update: {
          displayName: instrument.displayName,
          notes: instrument.notes ?? null,
        },
      });
      await this.prisma.marketSelection.upsert({
        where: { instrumentId: instrument.id },
        create: {
          id: newId("msel"),
          instrumentId: instrument.id,
          enabled: instrument.enabledByDefault,
        },
        update: {},
      });
    }
    await this.prisma.autonomyControl.upsert({
      where: { id: "primary" },
      create: {
        id: "primary",
        level: DEFAULT_AUTONOMY.level,
        realMoneyExecutionEnabled: false,
        allowUnreviewedCodeDeploy: false,
        allowRiskLimitMutation: false,
        maxResearchIterations: DEFAULT_AUTONOMY.maxResearchIterations,
        maxResearchBudgetUsd: DEFAULT_AUTONOMY.maxResearchBudgetUsd,
        timeoutMs: DEFAULT_AUTONOMY.timeoutMs,
      },
      update: {
        realMoneyExecutionEnabled: false,
        allowUnreviewedCodeDeploy: false,
      },
    });
  }

  async listMarkets() {
    await this.ensureSeeds();
    const instruments = await this.prisma.instrument.findMany({ orderBy: { id: "asc" } });
    const selections = await this.prisma.marketSelection.findMany();
    const enabled = new Map(selections.map((row) => [row.instrumentId, row.enabled]));
    const indexIds = instruments.filter((row) => row.assetClass === "EQUITY_INDEX").map((row) => row.id);
    const quotes = await this.indexProvider.getQuotes(indexIds);
    const quoteMap = new Map(
      quotes.ok ? quotes.data.map((quote) => [quote.instrumentId, quote]) : [],
    );
    return {
      instruments: instruments.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        displayName: row.displayName,
        venue: row.venue,
        assetClass: row.assetClass,
        base: row.base,
        quoteCurrency: row.quote,
        session: row.session,
        providerId: row.providerId,
        executionCapabilities: row.executionCapabilities,
        enabled: enabled.get(row.id) ?? row.enabledByDefault,
        notes: row.notes,
        quote: quoteMap.get(row.id) ?? null,
      })),
    };
  }

  async setMarket(body: unknown, updatedBy: string) {
    const parsed = z
      .object({ instrumentId: z.string().min(1), enabled: z.boolean() })
      .strict()
      .parse(body);
    await this.ensureSeeds();
    const instrument = await this.prisma.instrument.findUnique({ where: { id: parsed.instrumentId } });
    if (!instrument) throw new NotFoundException("Unknown instrument");
    const row = await this.prisma.marketSelection.upsert({
      where: { instrumentId: parsed.instrumentId },
      create: {
        id: newId("msel"),
        instrumentId: parsed.instrumentId,
        enabled: parsed.enabled,
        updatedBy,
      },
      update: { enabled: parsed.enabled, updatedBy },
    });
    return { instrumentId: row.instrumentId, enabled: row.enabled };
  }

  async validateUniverse(body: unknown) {
    const parsed = z.object({ instrumentIds: z.array(z.string()).min(1) }).strict().parse(body);
    await this.ensureSeeds();
    const selections = await this.prisma.marketSelection.findMany();
    const registry = createInstrumentRegistry(
      SEED_INSTRUMENTS,
      selections.map((row) => ({ instrumentId: row.instrumentId, enabled: row.enabled })),
    );
    return validateStrategyUniverse(parsed.instrumentIds, registry);
  }

  async modelOps() {
    const router = new ModelRouter({ env: process.env, mode: "live" });
    const usage = await this.prisma.modelUsageLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      tiers: [...assertKnownTier()],
      endpoints: router.health(),
      assignments: DEFAULT_ASSIGNMENTS,
      separatedReviewer: router.assertSeparatedReviewer(),
      budget: router.budget(),
      liveCallsEnabled: router.health().some((row) => row.availability === "CONFIGURED"),
      usage: usage.map((row) => ({
        id: row.id,
        agentOrTask: row.agentOrTask,
        endpointId: row.endpointId,
        provider: row.provider,
        model: row.model,
        tier: row.tier,
        ok: row.ok,
        latencyMs: row.latencyMs,
        costUsdEst: row.costUsdEst.toString(),
        costKind: row.costKind,
        provenance: row.provenance,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async createHypothesis(body: unknown, createdBy: string) {
    const parsed = hypothesisSchema.parse(body);
    const compatibility = validateStrategyUniverse(
      parsed.instrumentIds,
      createInstrumentRegistry(SEED_INSTRUMENTS),
    );
    if (!compatibility.ok) throw new BadRequestException(compatibility.reason);
    const row = await this.prisma.hypothesis.create({
      data: {
        id: newId("hyp"),
        title: parsed.title,
        market: parsed.market,
        instrumentIds: parsed.instrumentIds,
        conditions: parsed.conditions,
        claimedAdvantage: parsed.claimedAdvantage,
        entryRules: parsed.entryRules,
        exitRules: parsed.exitRules,
        riskRules: parsed.riskRules,
        rationale: parsed.rationale,
        successCriteria: parsed.successCriteria,
        failureModes: parsed.failureModes,
        status: parsed.status,
        createdBy,
      },
    });
    return this.mapHypothesis(row);
  }

  async listHypotheses() {
    const rows = await this.prisma.hypothesis.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((row) => this.mapHypothesis(row));
  }

  async runPipeline(body: unknown, actor: string) {
    const parsed = z
      .object({
        hypothesisId: z.string().min(1),
        useLiveObservationCount: z.boolean().optional(),
      })
      .strict()
      .parse(body);
    const hypothesis = await this.prisma.hypothesis.findUnique({ where: { id: parsed.hypothesisId } });
    if (!hypothesis) throw new NotFoundException("Hypothesis not found");
    const autonomyRow = await this.prisma.autonomyControl.findUnique({ where: { id: "primary" } });
    const autonomy = parseAutonomyPolicy(
      autonomyRow
        ? {
            level: autonomyRow.level,
            realMoneyExecutionEnabled: false,
            allowUnreviewedCodeDeploy: false,
            allowRiskLimitMutation: autonomyRow.allowRiskLimitMutation,
            maxResearchIterations: autonomyRow.maxResearchIterations,
            maxResearchBudgetUsd: autonomyRow.maxResearchBudgetUsd.toString(),
            timeoutMs: autonomyRow.timeoutMs,
          }
        : DEFAULT_AUTONOMY,
    );

    const observationRows =
      parsed.useLiveObservationCount === false
        ? []
        : await this.prisma.marketObservation.findMany({ orderBy: { receivedAt: "asc" }, take: 400 });

    const router = new ModelRouter({ budgetCapUsd: Number(autonomy.maxResearchBudgetUsd) });
    const result = await runResearchPipeline({
      hypothesis: {
        id: hypothesis.id,
        title: hypothesis.title,
        market: hypothesis.market as "SPOT_CRYPTO_PAIR",
        instrumentIds: hypothesis.instrumentIds,
        conditions: hypothesis.conditions,
        claimedAdvantage: hypothesis.claimedAdvantage,
        entryRules: hypothesis.entryRules,
        exitRules: hypothesis.exitRules,
        riskRules: hypothesis.riskRules,
        rationale: hypothesis.rationale,
        successCriteria: hypothesis.successCriteria,
        failureModes: hypothesis.failureModes,
        status: hypothesis.status as "OPEN",
      },
      autonomy,
      router,
      observations: observationRows.map((row) => ({
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
        freshness: (["LIVE", "DELAYED", "STALE", "REPLAY", "DEMO"].includes(row.freshness)
          ? row.freshness
          : "STALE") as "LIVE" | "DELAYED" | "STALE" | "REPLAY" | "DEMO",
        provenance: `MarketObservation:${row.id}`,
      })),
    });

    for (const usage of router.usage) {
      await this.prisma.modelUsageLog.create({
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

    for (const transition of result.transitions) {
      await this.prisma.lifecycleAudit.create({
        data: {
          id: transition.id,
          strategyId: transition.strategyId,
          fromState: transition.from,
          toState: transition.to,
          actor: transition.actor === "PIPELINE" ? actor : transition.actor,
          evidence: toJson(transition.evidence),
          evidenceHash: transition.evidenceHash,
        },
      });
    }

    if (result.report) {
      await this.persistReport(result.report);
    }

    for (const record of result.memory.records) {
      await this.prisma.tradeMemory.create({
        data: {
          id: newId("tmem"),
          tradeId: record.tradeId,
          pairAddress: record.pairAddress,
          phase: record.phase,
          postExit: record.postExit,
          context: toJson(record.context),
          capturedAt: new Date(record.capturedAt),
        },
      });
    }

    for (const item of result.oracle.queue) {
      await this.prisma.researchQueueItem.upsert({
        where: { id: item.id },
        create: {
          id: item.id,
          kind: item.kind,
          priority: item.priority,
          hypothesisId: item.hypothesisId,
          strategyId: item.strategyId,
          status: item.status,
          reason: item.reason,
          budgetUsd: item.budgetUsd,
        },
        update: { status: item.status, priority: item.priority },
      });
    }

    await this.prisma.hypothesis.update({
      where: { id: hypothesis.id },
      data: { status: result.lifecycle === "REJECTED" ? "CLOSED" : "TESTING" },
    });

    return {
      lifecycle: result.lifecycle,
      stages: result.stages,
      forge: result.forge,
      challenge: result.challenge,
      reportId: result.report?.reportId ?? null,
      contentHash: result.report?.contentHash ?? null,
      paper: result.paper,
      acceptance: result.acceptance,
      nextExperimentProposed: result.nextExperimentProposed,
    };
  }

  async listLifecycle(strategyId?: string) {
    const rows = await this.prisma.lifecycleAudit.findMany({
      where: strategyId ? { strategyId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      strategyId: row.strategyId,
      from: row.fromState,
      to: row.toState,
      actor: row.actor,
      evidenceHash: row.evidenceHash,
      evidence: row.evidence,
      at: row.createdAt.toISOString(),
    }));
  }

  async genome() {
    const versions = await this.prisma.strategyVersion.findMany({
      orderBy: [{ name: "asc" }, { version: "desc" }],
      take: 100,
    });
    const audits = await this.prisma.lifecycleAudit.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      strategies: versions.map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        status: row.status,
        parentId: row.parentId,
        createdAt: row.createdAt.toISOString(),
      })),
      transitions: audits.map((row) => ({
        strategyId: row.strategyId,
        from: row.fromState,
        to: row.toState,
        actor: row.actor,
        evidenceHash: row.evidenceHash,
        at: row.createdAt.toISOString(),
      })),
    };
  }

  async searchMemory(query: Record<string, string | undefined>) {
    const rows = await this.prisma.tradeMemory.findMany({
      orderBy: { capturedAt: "desc" },
      take: 500,
    });
    const store = {
      records: rows.map((row) => ({
        tradeId: row.tradeId,
        pairAddress: row.pairAddress,
        phase: row.phase as "BEFORE" | "DURING" | "AFTER",
        capturedAt: row.capturedAt.toISOString(),
        context: row.context as Record<string, unknown>,
        postExit: row.postExit,
      })),
    };
    return searchTradeMemory(store, {
      q: query.q,
      pairAddress: query.pairAddress,
      tradeId: query.tradeId,
      phase: query.phase as "BEFORE" | "DURING" | "AFTER" | undefined,
      includePostExit: query.includePostExit !== "false",
      limit: query.limit ? Number(query.limit) : 50,
    });
  }

  async recordMemory(body: unknown) {
    const parsed = z
      .object({
        tradeId: z.string().min(1),
        pairAddress: z.string().min(1),
        phase: z.enum(["BEFORE", "DURING", "AFTER"]),
        context: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(body);
    const record = capturePhaseContext(parsed);
    await this.prisma.tradeMemory.create({
      data: {
        id: newId("tmem"),
        tradeId: record.tradeId,
        pairAddress: record.pairAddress,
        phase: record.phase,
        postExit: record.postExit,
        context: toJson(record.context),
        capturedAt: new Date(record.capturedAt),
      },
    });
    return record;
  }

  async getAutonomy() {
    await this.ensureSeeds();
    const row = await this.prisma.autonomyControl.findUniqueOrThrow({ where: { id: "primary" } });
    return {
      level: row.level,
      realMoneyExecutionEnabled: false,
      allowUnreviewedCodeDeploy: false,
      allowRiskLimitMutation: row.allowRiskLimitMutation,
      maxResearchIterations: row.maxResearchIterations,
      maxResearchBudgetUsd: row.maxResearchBudgetUsd.toString(),
      timeoutMs: row.timeoutMs,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
      notes: "Level 4 real-money adapter is disabled. Research autonomy ≠ deploy unreviewed code.",
    };
  }

  async setAutonomy(body: unknown, updatedBy: string) {
    const parsed = z
      .object({
        level: z.number().int().min(0).max(3),
        allowRiskLimitMutation: z.boolean().optional(),
        maxResearchIterations: z.number().int().min(1).max(100).optional(),
        maxResearchBudgetUsd: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
      })
      .strict()
      .parse(body);
    const row = await this.prisma.autonomyControl.update({
      where: { id: "primary" },
      data: {
        level: parsed.level,
        realMoneyExecutionEnabled: false,
        allowUnreviewedCodeDeploy: false,
        allowRiskLimitMutation: parsed.allowRiskLimitMutation ?? false,
        maxResearchIterations: parsed.maxResearchIterations,
        maxResearchBudgetUsd: parsed.maxResearchBudgetUsd,
        timeoutMs: parsed.timeoutMs,
        updatedBy,
      },
    });
    return this.getAutonomy().then(() => ({
      level: row.level,
      realMoneyExecutionEnabled: false,
      allowUnreviewedCodeDeploy: false,
    }));
  }

  async researchCentre() {
    const [hypotheses, queue, reports, briefingFacts] = await Promise.all([
      this.listHypotheses(),
      this.prisma.researchQueueItem.findMany({ orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 50 }),
      this.prisma.experimentReport.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      this.prisma.backtestRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    ]);
    const oracle = createOracleSupervisor();
    const briefing = dailyBriefing(oracle, {
      hypotheses: hypotheses.length,
      queue: queue.length,
      reports: reports.length,
    });
    const comparison = compareStrategies(
      briefingFacts.map((run) => {
        const metrics = run.metrics as { sampleSize?: number; totalReturnPct?: string } | null;
        return {
          id: run.id,
          returnPct: metrics?.totalReturnPct ?? null,
          sampleSize: metrics?.sampleSize ?? 0,
        };
      }),
    );
    return {
      hypotheses,
      queue: queue.map((item) => ({
        id: item.id,
        kind: item.kind,
        priority: item.priority,
        status: item.status,
        reason: item.reason,
        hypothesisId: item.hypothesisId,
        strategyId: item.strategyId,
        budgetUsd: item.budgetUsd.toString(),
        capability: item.capability,
        provenance: item.provenance,
        aiDiscovery: item.aiDiscovery,
        retries: item.retries,
        failureStreak: item.failureStreak,
        createdAt: item.createdAt.toISOString(),
      })),
      oracle: {
        capabilities: [...ORACLE_CAPABILITIES],
        limits: DEFAULT_ORACLE_LIMITS,
        proposals: proposeOracleCycle({
          performance: {
            returnPct: null,
            sampleSize: 0,
            maxDrawdownPct: null,
          },
          memory: [],
          challengePassed: null,
          challengeFindings: [],
          baselines: comparison.ranking.map((row) => ({
            id: row.id,
            returnPct: null,
            sampleSize: 0,
          })),
          hypothesisId: hypotheses[0]?.id ?? null,
          openConditions: hypotheses.slice(0, 3).map((row) => row.title),
        }),
      },
      reports: reports.map((row) => ({
        id: row.id,
        hypothesisId: row.hypothesisId,
        strategyModuleId: row.strategyModuleId,
        approvalStatus: row.approvalStatus,
        contentHash: row.contentHash,
        createdAt: row.createdAt.toISOString(),
      })),
      briefing,
      comparison,
      deterioration: detectDeterioration({
        recentReturnPct: null,
        maxDrawdownPct: null,
        sampleSize: 0,
      }),
    };
  }

  async enqueue(body: unknown) {
    const parsed = z
      .object({
        kind: z.enum(["EXPERIMENT", "CHALLENGE", "PAPER_REVIEW", "RETIREMENT", "BRIEFING"]),
        capability: z.enum(ORACLE_CAPABILITIES).optional(),
        priority: z.number().int().min(0).max(100),
        hypothesisId: z.string().nullable().optional(),
        strategyId: z.string().nullable().optional(),
        reason: z.string().min(1).max(1000),
        budgetUsd: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.10"),
        retries: z.number().int().min(0).max(10).optional(),
      })
      .strict()
      .parse(body);
    const autonomy = parseAutonomyPolicy(await this.getAutonomy());
    const rows = await this.prisma.researchQueueItem.findMany();
    const state = createOracleSupervisor();
    state.iterations = rows.filter((row) => row.status !== "CANCELLED").length;
    state.spentBudgetUsd = rows.reduce((sum, row) => sum + Number(row.budgetUsd.toString()), 0);
    const gate = enqueueResearch(
      state,
      {
        id: newId("rq"),
        kind: parsed.kind,
        priority: parsed.priority,
        hypothesisId: parsed.hypothesisId ?? null,
        strategyId: parsed.strategyId ?? null,
        reason: parsed.reason,
        createdAt: new Date().toISOString(),
        budgetUsd: parsed.budgetUsd,
      },
      autonomy,
    );
    if (!gate.accepted) throw new BadRequestException(gate.reason);
    const spent = rows.reduce((sum, row) => sum.plus(d(row.budgetUsd.toString())), d("0"));
    const admitted = admitOracleItem(
      {
        items: rows.map((row) => ({
          id: row.id,
          capability: (ORACLE_CAPABILITIES as readonly string[]).includes(row.capability)
            ? (row.capability as (typeof ORACLE_CAPABILITIES)[number])
            : "RECOMMEND_EXPERIMENT",
          priority: row.priority,
          hypothesisId: row.hypothesisId,
          strategyId: row.strategyId,
          status: row.status as "QUEUED" | "RUNNING" | "DONE" | "CANCELLED" | "BLOCKED",
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
          budgetUsd: row.budgetUsd.toString(),
          fingerprint: row.fingerprint,
          retries: row.retries,
          failureStreak: row.failureStreak,
          provenance: row.provenance === "MODEL" ? "MODEL" : "DETERMINISTIC_SUPERVISOR",
          aiDiscovery: row.aiDiscovery,
          modelIdentifier: null,
        })),
        spentUsd: spent.toFixed(4),
        failureStreak: rows.reduce((max, row) => Math.max(max, row.failureStreak), 0),
        terminated: false,
        terminationReason: null,
      },
      {
        id: gate.state.queue[0]?.id ?? newId("rq"),
        capability: parsed.capability ?? "RECOMMEND_EXPERIMENT",
        priority: parsed.priority,
        hypothesisId: parsed.hypothesisId ?? null,
        strategyId: parsed.strategyId ?? null,
        reason: parsed.reason,
        createdAt: new Date().toISOString(),
        budgetUsd: parsed.budgetUsd,
        retries: parsed.retries ?? 0,
        provenance: "DETERMINISTIC_SUPERVISOR",
        modelIdentifier: null,
        aiDiscovery: false,
      },
      {
        ...DEFAULT_ORACLE_LIMITS,
        maxExperimentsPerCycle: autonomy.maxResearchIterations,
        maxSpendUsdPerDay: autonomy.maxResearchBudgetUsd,
      },
    );
    if (!admitted.accepted || !admitted.record) throw new BadRequestException(admitted.reason);
    const record = admitted.record;
    await this.prisma.researchQueueItem.create({
      data: {
        id: record.id,
        kind: parsed.kind,
        priority: record.priority,
        hypothesisId: record.hypothesisId,
        strategyId: record.strategyId,
        status: record.status,
        reason: record.reason,
        budgetUsd: record.budgetUsd,
        fingerprint: record.fingerprint,
        retries: record.retries,
        capability: record.capability,
        provenance: record.provenance,
        aiDiscovery: false,
        failureStreak: record.failureStreak,
      },
    });
    return { ...record, kind: parsed.kind, aiDiscovery: false };
  }

  async forgeOnly(body: unknown) {
    const parsed = z
      .object({
        hypothesisId: z.string().min(1),
        source: z.string().max(200_000).optional(),
      })
      .strict()
      .parse(body);
    const hypothesis = await this.prisma.hypothesis.findUnique({ where: { id: parsed.hypothesisId } });
    if (!hypothesis) throw new NotFoundException("Hypothesis not found");
    const forged = await forgeStrategyModule({
      hypothesis: {
        id: hypothesis.id,
        title: hypothesis.title,
        market: hypothesis.market as "SPOT_CRYPTO_PAIR",
        instrumentIds: hypothesis.instrumentIds,
        conditions: hypothesis.conditions,
        claimedAdvantage: hypothesis.claimedAdvantage,
        entryRules: hypothesis.entryRules,
        exitRules: hypothesis.exitRules,
        riskRules: hypothesis.riskRules,
        rationale: hypothesis.rationale,
        successCriteria: hypothesis.successCriteria,
        failureModes: hypothesis.failureModes,
        status: "FORGING",
      },
      source: parsed.source,
    });
    if (!forged.ok) return forged;
    const transition = transitionLifecycle({
      strategyId: forged.manifest.id,
      from: "DRAFT",
      to: "CODE_GENERATED",
      actor: "FORGE",
      evidence: { sourceHash: forged.sourceHash },
    });
    if (transition.ok) {
      await this.prisma.lifecycleAudit.create({
        data: {
          id: transition.transition.id,
          strategyId: transition.transition.strategyId,
          fromState: transition.transition.from,
          toState: transition.transition.to,
          actor: transition.transition.actor,
          evidence: toJson(transition.transition.evidence),
          evidenceHash: transition.transition.evidenceHash,
        },
      });
    }
    return {
      ok: true,
      manifest: forged.manifest,
      sourceHash: forged.sourceHash,
      workspacePath: forged.workspacePath,
    };
  }

  async challengePreview(body: unknown) {
    const parsed = z
      .object({
        sampleSize: z.number().int(),
        oosSampleSize: z.number().int().nullable(),
        inSampleReturnPct: z.string().nullable(),
        oosReturnPct: z.string().nullable(),
        maxDrawdownPct: z.string().nullable(),
        inactivePairCount: z.number().int().default(0),
        disappearedPairCount: z.number().int().default(0),
        parameterTrials: z.number().int().default(1),
        usedFutureBars: z.boolean().default(false),
        usedPostExitMemoryInEntry: z.boolean().default(false),
        costModelPresent: z.boolean().default(true),
        monteCarloRan: z.boolean().default(false),
        correlatedSiblingStrategies: z.number().int().default(0),
      })
      .strict()
      .parse(body);
    return runChallengeReview(parsed);
  }

  async getReport(id: string) {
    const row = await this.prisma.experimentReport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Report not found");
    const payload = row.payload as ExperimentReport;
    return {
      ...payload,
      persistedId: row.id,
      signatureValid: verifyExperimentReport(payload),
    };
  }

  private async persistReport(report: ExperimentReport) {
    await this.prisma.experimentReport.create({
      data: {
        id: report.reportId,
        hypothesisId: report.hypothesisId,
        strategyModuleId: report.strategyModuleId,
        strategyVersion: report.strategyVersion,
        payload: toJson(report),
        contentHash: report.contentHash,
        signature: report.signature,
        approvalStatus: report.approval.status,
      },
    });
  }

  private mapHypothesis(row: {
    id: string;
    title: string;
    market: string;
    instrumentIds: string[];
    conditions: string;
    claimedAdvantage: string;
    entryRules: string;
    exitRules: string;
    riskRules: string;
    rationale: string;
    successCriteria: string;
    failureModes: string;
    status: string;
    createdBy: string | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      title: row.title,
      market: row.market,
      instrumentIds: row.instrumentIds,
      conditions: row.conditions,
      claimedAdvantage: row.claimedAdvantage,
      entryRules: row.entryRules,
      exitRules: row.exitRules,
      riskRules: row.riskRules,
      rationale: row.rationale,
      successCriteria: row.successCriteria,
      failureModes: row.failureModes,
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
