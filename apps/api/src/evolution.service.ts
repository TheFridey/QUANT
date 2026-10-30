import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DEFAULT_ASSIGNMENTS,
  ModelRouter,
  assertKnownTier,
  RESEARCH_OUTCOMES,
  assessObservationIntegrity,
  capturePhaseContext,
  featuresForEntry,
  queryWinnersAndLosers,
  reconstructTrade,
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
  probeIsolation,
  runChallengeReview,
  runResearchPipeline,
  searchTradeMemory,
  transitionLifecycle,
  verifyExperimentReport,
  applyUnvalidatedPaperExperiment,
  engineControlDataFromSlot,
  promoteToPaperEngine,
  promotionBodySchema,
  slotFromEngineControl,
  unvalidatedExperimentBodySchema,
  validatePromotion,
  validateUnvalidatedExperiment,
  type ExperimentReport,
  type PersistedApproval,
  type PersistedArtifact,
  type PersistedReportRow,
} from "@odin/evolution";
import {
  IndexMarketProvider,
  createInstrumentRegistry,
  validateStrategyUniverse,
} from "@odin/market-data";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_STRATEGY,
  SEED_INSTRUMENTS,
  d,
  hypothesisSchema,
  newId,
} from "@odin/shared";
import { Prisma, PrismaClient, toJson } from "@odin/shared/db";
import { resetPaperBalance } from "./paper-balance.js";
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

  async reconstructMemory(tradeId?: string) {
    const rows = await this.prisma.tradeMemory.findMany({
      where: tradeId ? { tradeId } : undefined,
      orderBy: { capturedAt: "asc" },
      take: 500,
    });
    const records = rows.map((row) => ({
      tradeId: row.tradeId,
      pairAddress: row.pairAddress,
      phase: row.phase as "BEFORE" | "DURING" | "AFTER",
      capturedAt: row.capturedAt.toISOString(),
      context: row.context as Record<string, unknown>,
      postExit: row.postExit,
    }));
    const ids = [...new Set(records.map((row) => row.tradeId))];
    return ids.map((id) => {
      const scoped = records.filter((row) => row.tradeId === id);
      return {
        reconstruction: reconstructTrade(scoped),
        entry: featuresForEntry({ records: scoped }, id),
      };
    });
  }

  async forgeMonitor() {
    const reports = await this.prisma.experimentReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const runner = probeIsolation();
    return {
      runner: {
        runtime: runner.runtime,
        available: runner.available,
        reason: runner.reason,
        seccomp: runner.seccomp,
        seccompDetail: runner.seccompDetail,
        memoryEnforcement: runner.memoryEnforcement,
        memoryMb: runner.memoryMb,
        timeoutMs: runner.timeoutMs,
        perBarTimeoutMs: runner.perBarTimeoutMs,
        protocol: runner.protocol,
      },
      runs: reports.map((row) => {
        const payload = row.payload as {
          reproducibility?: { codeHash?: string };
          results?: { returnPct?: string | null; sampleSize?: number };
          outcomes?: Record<string, { met?: boolean; detail?: string }>;
        };
        return {
          id: row.id,
          hypothesisId: row.hypothesisId,
          strategyModuleId: row.strategyModuleId,
          strategyVersion: row.strategyVersion,
          approvalStatus: row.approvalStatus,
          contentHash: row.contentHash,
          codeHash: payload.reproducibility?.codeHash ?? null,
          returnPct: payload.results?.returnPct ?? null,
          sampleSize: payload.results?.sampleSize ?? null,
          pipelineCompleted: payload.outcomes?.PIPELINE_COMPLETED?.met === true,
          resultsMeasurable: payload.outcomes?.RESULTS_MEASURABLE?.met === true,
          deploymentEligible: payload.outcomes?.DEPLOYMENT_ELIGIBLE?.met === true,
          sandboxEra: row.sandboxEra,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  async dataIntegrityPanel() {
    const rows = await this.prisma.marketObservation.findMany({
      orderBy: { receivedAt: "asc" },
      take: 400,
    });
    const observations = rows.map((row) => ({
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
    }));
    const assessed = assessObservationIntegrity(observations);
    return {
      observationCount: observations.length,
      usableCount: assessed.usable.length,
      blocking: assessed.blocking,
      issues: assessed.issues.slice(0, 40),
    };
  }

  async researchConfidence() {
    const latest = await this.prisma.experimentReport.findFirst({ orderBy: { createdAt: "desc" } });
    const payload = (latest?.payload ?? {}) as {
      outcomes?: Record<string, { met?: boolean; detail?: string }>;
      results?: { returnPct?: string | null };
    };
    return {
      reportId: latest?.id ?? null,
      returnPct: payload.results?.returnPct ?? null,
      note: "Pipeline completion is a recorded stage. It is not a validated strategy and it is not a profit result.",
      outcomes: RESEARCH_OUTCOMES.map((name) => {
        const row = payload.outcomes?.[name];
        const met = row?.met === true;
        const tone = !met ? "open" : name === "PIPELINE_COMPLETED" ? "recorded" : "measured";
        return { name, met, detail: row?.detail ?? "No persisted assessment", tone };
      }),
    };
  }

  async memoryFactors() {
    const rows = await this.prisma.tradeMemory.findMany({ orderBy: { capturedAt: "asc" }, take: 500 });
    return queryWinnersAndLosers(
      rows.map((row) => ({
        tradeId: row.tradeId,
        pairAddress: row.pairAddress,
        phase: row.phase as "BEFORE" | "DURING" | "AFTER",
        capturedAt: row.capturedAt.toISOString(),
        context: row.context as Record<string, unknown>,
        postExit: row.postExit,
      })),
    );
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

  async promotePaperStrategy(body: unknown, operatorId: string) {
    const operator = operatorId.trim();
    if (!operator) throw new BadRequestException("Promotion requires an explicit operator identity");
    const parsed = promotionBodySchema.parse(body);
    // Audit C4: read → validate → write promotion → write engine config under one lock on the engine row.
    return this.prisma.$transaction(async (tx) => {
      const engine = await lockEngineForPromotion(tx);

      const reportRow = await tx.experimentReport.findUnique({ where: { id: parsed.reportId } });
      const artifactRow = await tx.strategyArtifact.findUnique({ where: { id: parsed.artifactId } });
      refusePreSandboxFixEvidence({ report: reportRow, artifact: artifactRow });
      const approvalRows = await tx.promotionApproval.findMany({
        where: { reportId: parsed.reportId },
        orderBy: { createdAt: "desc" },
      });

      const persistedReport: PersistedReportRow | null = reportRow
        ? {
            id: reportRow.id,
            contentHash: reportRow.contentHash,
            signature: reportRow.signature,
            createdAt: reportRow.createdAt.toISOString(),
            payload: reportRow.payload,
          }
        : null;
      const persistedArtifact: PersistedArtifact | null = artifactRow
        ? {
            id: artifactRow.id,
            kind: artifactRow.kind,
            moduleRef: artifactRow.moduleRef,
            moduleVersion: artifactRow.moduleVersion,
            sourceHash: artifactRow.sourceHash,
            artifactHash: artifactRow.artifactHash,
            runtimeLoadable: artifactRow.runtimeLoadable,
          }
        : null;
      const approvalsForReport: PersistedApproval[] = approvalRows.map((row) => ({
        id: row.id,
        reportId: row.reportId,
        reportContentHash: row.reportContentHash,
        artifactId: row.artifactId,
        artifactHash: row.artifactHash,
        sourceHash: row.sourceHash,
        configHash: row.configHash,
        decision: row.decision,
        reviewer: row.reviewer,
        at: row.createdAt.toISOString(),
      }));
      const approval =
        (parsed.approvalId
          ? approvalsForReport.find((row) => row.id === parsed.approvalId)
          : approvalsForReport.find(
              (row) => row.decision === "APPROVED" && row.artifactId === parsed.artifactId,
            )) ?? null;

      const payload = persistedReport?.payload as ExperimentReport | undefined;
      const hypothesisId = payload?.hypothesisId;
      const hypothesisRow = hypothesisId
        ? await tx.researchProposal.findUnique({ where: { id: hypothesisId } })
        : null;
      const hypothesis = hypothesisRow
        ? { id: hypothesisRow.id, persisted: true, at: hypothesisRow.createdAt.toISOString() }
        : hypothesisId
          ? { id: hypothesisId, persisted: false, at: null }
          : null;

      const gated = validatePromotion({
        report: persistedReport,
        artifact: persistedArtifact,
        approval,
        approvalsForReport,
        hypothesis,
        requestedConfig: parsed.config ?? null,
      });
      if (gated.validation.status !== "VALIDATED" || !gated.evidence || !gated.config || !gated.configHash) {
        const failed = gated.validation.checks.filter((check) => !check.passed);
        throw new BadRequestException({
          message: `Promotion validation rejected: ${failed.map((check) => check.name).join(", ") || "REJECTED"}`,
          checks: gated.validation.checks,
        });
      }
      await assertPromotionConfigAllowed(tx, engine, gated.config);

      const previousPromotion = await tx.strategyPromotion.findFirst({
        orderBy: { createdAt: "desc" },
      });
      const promotionId = newId("promo");
      const slot = slotFromEngineControl({ config: engine.config, activeStrategy: engine.activeStrategy });
      const result = promoteToPaperEngine(slot, {
        operatorId: operator,
        authorised: true,
        caller: "OPERATOR",
        evidence: gated.evidence,
        config: gated.config,
        binding: {
          mode: "VALIDATED",
          validationStatus: "VALIDATED",
          provenance: gated.provenance,
          moduleRef: persistedArtifact!.moduleRef,
          moduleVersion: persistedArtifact!.moduleVersion,
          promotionId,
          reportId: parsed.reportId,
          approvalId: approval?.id ?? null,
          artifactId: persistedArtifact!.id,
        },
      });
      if (!result.appliedToPaperEngine) {
        throw new BadRequestException(result.reason);
      }

      const write = engineControlDataFromSlot(slot);
      await tx.strategyPromotion.create({
        data: {
          id: promotionId,
          mode: "VALIDATED",
          validationStatus: "VALIDATED",
          checks: toJson(gated.validation.checks),
          provenance: gated.provenance,
          reportId: parsed.reportId,
          approvalId: approval?.id ?? null,
          artifactId: persistedArtifact!.id,
          strategyId: gated.evidence.strategyId,
          strategyVersion: gated.evidence.strategyVersion,
          moduleRef: persistedArtifact!.moduleRef,
          moduleVersion: persistedArtifact!.moduleVersion,
          sourceHash: gated.evidence.sourceHash,
          artifactHash: gated.evidence.artifactHash,
          configHash: gated.configHash,
          config: toJson(gated.config),
          activeStrategy: toJson(write.activeStrategy),
          previousPromotionId: previousPromotion?.id ?? null,
          previousActiveStrategy: engine.activeStrategy ? toJson(engine.activeStrategy) : undefined,
          previousConfig: toJson(engine.config),
          deploymentEligible: true,
          liveEligible: false,
          operator,
        },
      });
      const priorRuntime = (engine.runtimeState as Record<string, unknown> | null) ?? {};
      await tx.engineControl.update({
        where: { id: "primary" },
        data: {
          config: toJson(write.config),
          activeStrategy: toJson(write.activeStrategy),
          updatedBy: operator,
          runtimeState: {
            ...priorRuntime,
            lastPromotion: {
              at: new Date().toISOString(),
              operator,
              promotionId,
              reportId: parsed.reportId,
              approvalId: approval?.id ?? null,
              artifactId: persistedArtifact!.id,
              sourceHash: gated.evidence.sourceHash,
              artifactHash: gated.evidence.artifactHash,
              mode: "VALIDATED",
            },
          },
        },
      });
      return {
        ...result,
        promotionId,
        reportId: parsed.reportId,
        approvalId: approval?.id ?? null,
        artifactId: persistedArtifact!.id,
        validation: gated.validation,
        validatedPromotion: true,
      };
    }, PROMOTION_TRANSACTION_LIMITS);
  }

  /** Labelled paper-only experiment. Never deployment- or live-eligible. */
  async applyUnvalidatedPaperExperiment(body: unknown, operatorId: string) {
    const operator = operatorId.trim();
    if (!operator) throw new BadRequestException("Unvalidated experiment requires an explicit operator identity");
    const parsed = unvalidatedExperimentBodySchema.parse(body);
    // Audit C4: same lock and RUNNING refusal as validated promotion.
    return this.prisma.$transaction(async (tx) => {
      const engine = await lockEngineForPromotion(tx);

      const artifactRow = await tx.strategyArtifact.findUnique({ where: { id: parsed.artifactId } });
      refusePreSandboxFixEvidence({ report: null, artifact: artifactRow });
      const artifact: PersistedArtifact | null = artifactRow
        ? {
            id: artifactRow.id,
            kind: artifactRow.kind,
            moduleRef: artifactRow.moduleRef,
            moduleVersion: artifactRow.moduleVersion,
            sourceHash: artifactRow.sourceHash,
            artifactHash: artifactRow.artifactHash,
            runtimeLoadable: artifactRow.runtimeLoadable,
          }
        : null;
      const gated = validateUnvalidatedExperiment({ artifact, config: parsed.config });
      if (gated.validation.status === "REJECTED" || !artifact) {
        throw new BadRequestException({
          message: "Unvalidated experiment rejected",
          checks: gated.validation.checks,
        });
      }
      await assertPromotionConfigAllowed(tx, engine, gated.config);

      const previousPromotion = await tx.strategyPromotion.findFirst({
        orderBy: { createdAt: "desc" },
      });
      const promotionId = newId("promo");
      const slot = slotFromEngineControl({ config: engine.config, activeStrategy: engine.activeStrategy });
      const result = applyUnvalidatedPaperExperiment(slot, {
        operatorId: operator,
        authorised: true,
        caller: "OPERATOR",
        identity: {
          strategyId: artifact.moduleRef ?? artifact.id,
          strategyVersion: artifact.moduleVersion,
          sourceHash: artifact.sourceHash,
          artifactHash: artifact.artifactHash,
        },
        config: gated.config,
        binding: {
          moduleRef: artifact.moduleRef,
          moduleVersion: artifact.moduleVersion,
          promotionId,
          artifactId: artifact.id,
        },
      });
      if (!result.appliedToPaperEngine) {
        throw new BadRequestException(result.reason);
      }

      const write = engineControlDataFromSlot(slot);
      await tx.strategyPromotion.create({
        data: {
          id: promotionId,
          mode: "UNVALIDATED_PAPER_EXPERIMENT",
          validationStatus: "UNVALIDATED_EXPERIMENT",
          checks: toJson(gated.validation.checks),
          provenance: "INCOMPLETE",
          reportId: null,
          approvalId: null,
          artifactId: artifact.id,
          strategyId: artifact.moduleRef ?? artifact.id,
          strategyVersion: artifact.moduleVersion,
          moduleRef: artifact.moduleRef,
          moduleVersion: artifact.moduleVersion,
          sourceHash: artifact.sourceHash,
          artifactHash: artifact.artifactHash,
          configHash: gated.configHash,
          config: toJson(gated.config),
          activeStrategy: toJson(write.activeStrategy),
          previousPromotionId: previousPromotion?.id ?? null,
          previousActiveStrategy: engine.activeStrategy ? toJson(engine.activeStrategy) : undefined,
          previousConfig: toJson(engine.config),
          deploymentEligible: false,
          liveEligible: false,
          operator,
          label: parsed.label,
          rationale: parsed.rationale,
        },
      });
      await tx.engineControl.update({
        where: { id: "primary" },
        data: {
          config: toJson(write.config),
          activeStrategy: toJson(write.activeStrategy),
          updatedBy: operator,
        },
      });
      return {
        ...result,
        promotionId,
        artifactId: artifact.id,
        validation: gated.validation,
        validatedPromotion: false,
      };
    }, PROMOTION_TRANSACTION_LIMITS);
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

const PROMOTION_TRANSACTION_LIMITS = { timeout: 15_000, maxWait: 10_000 };

/** Engine statuses in which the paper strategy slot may be rewritten (audit C4, D16). */
const PROMOTABLE_ENGINE_STATUSES = new Set(["PAUSED", "STOPPED"]);

type LockedEngine = Prisma.EngineControlGetPayload<object>;

/** Lock the engine row for the rest of the transaction so concurrent promotions serialise. */
async function lockEngineForPromotion(tx: Prisma.TransactionClient): Promise<LockedEngine> {
  await tx.$queryRaw`SELECT id FROM "EngineControl" WHERE id = ${"primary"} FOR UPDATE`;
  const engine = await tx.engineControl.findUnique({ where: { id: "primary" } });
  if (!engine) throw new NotFoundException("Engine is not initialised");
  if (!PROMOTABLE_ENGINE_STATUSES.has(engine.status)) {
    throw new ConflictException(
      `Promotion is refused while the engine is ${engine.status}. Pause or stop the engine first; risk settings never change under a running engine.`,
    );
  }
  return engine;
}

/** Only evidence produced by the fixed sandbox counts (audit C1/C2). Allowlist, so unknown eras fail closed. */
const ACCEPTED_SANDBOX_ERAS = new Set(["STREAMING_FD3"]);

function refusePreSandboxFixEvidence(input: {
  report: { sandboxEra: string } | null;
  artifact: { sandboxEra: string } | null;
}): void {
  const rejected = [input.report, input.artifact].some((row) => row !== null && !ACCEPTED_SANDBOX_ERAS.has(row.sandboxEra));
  if (rejected) {
    throw new ConflictException(
      "Promotion is refused: the report or artifact was produced before the sandbox integrity fix (PRE_SANDBOX_FIX). Re-run it.",
    );
  }
}

/**
 * Promotion may change startingBalanceUsd only while STOPPED with no paper orders (stricter than
 * the strategy PATCH, which also allows PAUSED). The reset shares resetPaperBalance and its lock.
 */
async function assertPromotionConfigAllowed(
  tx: Prisma.TransactionClient,
  engine: LockedEngine,
  next: { startingBalanceUsd: string },
): Promise<void> {
  const stored =
    engine.config && typeof engine.config === "object" && !Array.isArray(engine.config)
      ? (engine.config as Record<string, unknown>)
      : {};
  const current = String(stored.startingBalanceUsd ?? DEFAULT_STRATEGY.startingBalanceUsd);
  if (d(next.startingBalanceUsd).eq(d(current))) return;
  if (engine.status !== "STOPPED") {
    throw new ConflictException("Starting balance can change only while the engine is STOPPED");
  }
  await resetPaperBalance(tx, next.startingBalanceUsd, "Reset paper starting balance on promotion");
}
