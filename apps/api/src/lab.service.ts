import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  approveOracleSuggestions,
  createModelProvider,
  runOracleReview,
} from "@odin/agent-core";
import { globalObservability } from "@odin/analytics";
import {
  computeBaselines,
  chronologicalSplits,
  evaluateReleaseGates,
  evaluateSampleGates,
  monteCarloResample,
  renderResearchReportHtml,
  runBacktest,
  scoreBacktestResult,
  type BacktestObservation,
} from "@odin/backtest";
import { newId, parseStrategyConfig, type StrategyConfig } from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { z } from "zod";

const createVersionSchema = z
  .object({
    name: z.string().min(1).max(80),
    notes: z.string().max(2000).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    parentId: z.string().optional(),
  })
  .strict();

const runBacktestSchema = z
  .object({
    strategyVersionId: z.string().optional(),
    label: z.string().max(120).optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    initialBalanceUsd: z.string().optional(),
    latencyMs: z.number().int().min(0).max(60_000).optional(),
    forceLiquidateAtEnd: z.boolean().optional(),
    monteCarloIterations: z.number().int().min(10).max(5000).optional(),
    monteCarloSeed: z.number().int().optional(),
    /** When set, limit observations to these pair addresses (still reports others in quality if loaded). */
    pairAddresses: z.array(z.string()).max(50).optional(),
  })
  .strict();

@Injectable()
export class LabService {
  constructor(private readonly prisma: PrismaClient) {}

  async listStrategyVersions() {
    const rows = await this.prisma.strategyVersion.findMany({
      orderBy: [{ name: "asc" }, { version: "desc" }],
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      parentId: row.parentId,
      status: row.status,
      notes: row.notes,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      config: row.config,
    }));
  }

  async createStrategyVersion(body: unknown, createdBy: string) {
    const parsed = createVersionSchema.parse(body);
    const latest = await this.prisma.strategyVersion.findFirst({
      where: { name: parsed.name },
      orderBy: { version: "desc" },
    });
    const parent = parsed.parentId
      ? await this.prisma.strategyVersion.findUnique({ where: { id: parsed.parentId } })
      : latest;
    const baseConfig = parent
      ? parseStrategyConfig(parent.config)
      : parseStrategyConfig((await this.prisma.engineControl.findUnique({ where: { id: "primary" } }))?.config);
    const config = parsed.config ? parseStrategyConfig({ ...baseConfig, ...parsed.config }) : baseConfig;
    const version = (latest?.version ?? 0) + 1;
    const row = await this.prisma.strategyVersion.create({
      data: {
        id: newId("strat"),
        name: parsed.name,
        version,
        parentId: parent?.id ?? null,
        config: toJson(config),
        notes: parsed.notes ?? null,
        status: "DRAFT",
        createdBy,
      },
    });
    globalObservability.record({
      category: "simulation_uptime",
      name: "strategy_version_created",
      value: 1,
      unit: "count",
      meta: { id: row.id, name: row.name, version: row.version },
    });
    await this.persistObservability();
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listBacktests() {
    const rows = await this.prisma.backtestRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { strategyVersion: true },
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      label: row.label,
      strategyVersionId: row.strategyVersionId,
      strategyName: row.strategyVersion?.name ?? null,
      strategyVersion: row.strategyVersion?.version ?? null,
      metrics: row.metrics,
      releaseGate: row.releaseGate,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      error: row.error,
    }));
  }

  async getBacktest(id: string) {
    const row = await this.prisma.backtestRun.findUnique({
      where: { id },
      include: {
        strategyVersion: true,
        trades: { orderBy: { eventAt: "asc" }, take: 500 },
        oracleReviews: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });
    if (!row) throw new NotFoundException("Backtest run not found");
    return {
      id: row.id,
      status: row.status,
      label: row.label,
      params: row.params,
      assumptions: row.assumptions,
      dataQuality: row.dataQuality,
      metrics: row.metrics,
      baselines: row.baselines,
      validation: row.validation,
      releaseGate: row.releaseGate,
      equityCurve: row.equityCurve,
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      strategyVersion: row.strategyVersion
        ? {
            id: row.strategyVersion.id,
            name: row.strategyVersion.name,
            version: row.strategyVersion.version,
          }
        : null,
      trades: row.trades.map((trade) => ({
        id: trade.id,
        pairAddress: trade.pairAddress,
        baseSymbol: trade.baseSymbol,
        side: trade.side,
        intent: trade.intent,
        qty: trade.qty.toString(),
        priceUsd: trade.priceUsd.toString(),
        feeUsd: trade.feeUsd.toString(),
        slippageBps: trade.slippageBps.toString(),
        notionalUsd: trade.notionalUsd.toString(),
        pnlUsd: trade.pnlUsd?.toString() ?? null,
        eventAt: trade.eventAt.toISOString(),
        reasonCodes: trade.reasonCodes,
      })),
      oracleReviews: row.oracleReviews.map((review) => ({
        id: review.id,
        status: review.status,
        summary: review.summary,
        weaknesses: review.weaknesses,
        suggestions: review.suggestions,
        readiness: review.readiness,
        provider: review.provider,
        approvedAt: review.approvedAt?.toISOString() ?? null,
        createdAt: review.createdAt.toISOString(),
      })),
      venue: "PAPER",
      realMoneyGraduation: false,
    };
  }

  async compareBacktests(ids: string[]) {
    if (ids.length < 2 || ids.length > 5) {
      throw new BadRequestException("Provide 2–5 backtest run ids to compare");
    }
    const rows = await this.prisma.backtestRun.findMany({
      where: { id: { in: ids } },
      include: { strategyVersion: true },
    });
    return {
      venue: "PAPER",
      runs: rows.map((row) => ({
        id: row.id,
        label: row.label,
        strategyName: row.strategyVersion?.name ?? null,
        strategyVersion: row.strategyVersion?.version ?? null,
        metrics: row.metrics,
        releaseGate: row.releaseGate,
        baselines: row.baselines,
        status: row.status,
      })),
    };
  }

  async runBacktest(body: unknown, actor: string) {
    const parsed = runBacktestSchema.parse(body);
    const strategyRow = parsed.strategyVersionId
      ? await this.prisma.strategyVersion.findUnique({ where: { id: parsed.strategyVersionId } })
      : await this.ensureDefaultStrategyVersion(actor);
    if (!strategyRow) throw new NotFoundException("Strategy version not found");
    const config = parseStrategyConfig(strategyRow.config);

    const observations = await this.loadObservations({
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      pairAddresses: parsed.pairAddresses,
    });
    if (observations.length === 0) {
      throw new BadRequestException(
        "No MarketObservation rows in range. Ingest live data or import a fixture series with provenance before replaying.",
      );
    }

    const startAt = parsed.startAt ?? observations[0]!.receivedAt;
    const endAt = parsed.endAt ?? observations[observations.length - 1]!.receivedAt;
    const runId = newId("btrun");
    const startedAt = new Date();

    await this.prisma.backtestRun.create({
      data: {
        id: runId,
        strategyVersionId: strategyRow.id,
        status: "RUNNING",
        label: parsed.label ?? `${strategyRow.name}@${strategyRow.version}`,
        params: toJson({
          ...parsed,
          startAt,
          endAt,
          strategyVersionId: strategyRow.id,
          actor,
        }),
        assumptions: toJson([]),
        startedAt,
      },
    });

    try {
      const latencyMs = parsed.latencyMs ?? config.paperLatencyMs;
      const result = runBacktest(observations, {
        startAt,
        endAt,
        initialBalanceUsd: parsed.initialBalanceUsd ?? config.startingBalanceUsd,
        latencyMs,
        forceLiquidateAtEnd: parsed.forceLiquidateAtEnd ?? true,
        config,
        label: parsed.label,
      });

      const splits = chronologicalSplits(startAt, endAt);
      const trainResult = runBacktest(observations, {
        startAt: splits.trainStart,
        endAt: splits.trainEnd,
        initialBalanceUsd: parsed.initialBalanceUsd ?? config.startingBalanceUsd,
        latencyMs,
        forceLiquidateAtEnd: true,
        config,
      });
      const testResult = runBacktest(observations, {
        startAt: splits.testStart,
        endAt: splits.testEnd,
        initialBalanceUsd: parsed.initialBalanceUsd ?? config.startingBalanceUsd,
        latencyMs,
        forceLiquidateAtEnd: true,
        config,
      });

      const metrics = scoreBacktestResult(result);
      const trainMetrics = scoreBacktestResult(trainResult);
      const testMetrics = scoreBacktestResult(testResult);
      const sampleGate = evaluateSampleGates(result, config);
      const releaseGate = evaluateReleaseGates({
        config,
        sampleGate,
        oosSampleSize: testMetrics.sampleSize,
        oosMaxDrawdownPct: testMetrics.maxDrawdownPct,
        oosReturnPct: testMetrics.returnPct,
      });
      const baselines = computeBaselines({
        observations,
        initialBalanceUsd: parsed.initialBalanceUsd ?? config.startingBalanceUsd,
        strategy: result,
        startAt,
        endAt,
      });
      const monteCarlo = monteCarloResample({
        closedTradePnls: result.closedTradePnls,
        startingBalanceUsd: parsed.initialBalanceUsd ?? config.startingBalanceUsd,
        iterations: parsed.monteCarloIterations ?? 500,
        seed: parsed.monteCarloSeed ?? 42,
        minSample: Math.min(config.minSampleTrades, 10),
      });

      const validation = {
        splits,
        train: trainMetrics,
        test: testMetrics,
        sampleGate,
        monteCarlo: {
          seed: monteCarlo.seed,
          iterations: monteCarlo.iterations,
          sampleSize: monteCarlo.sampleSize,
          observed: monteCarlo.observed,
          meanFinalEquity: monteCarlo.meanFinalEquity,
          p05: monteCarlo.p05,
          p50: monteCarlo.p50,
          p95: monteCarlo.p95,
          label: monteCarlo.label,
        },
      };

      const reportHtml = renderResearchReportHtml({
        runId,
        generatedAt: new Date().toISOString(),
        strategyName: strategyRow.name,
        strategyVersion: strategyRow.version,
        result,
        metrics,
        baselines,
        sampleGate,
        releaseGate,
        monteCarlo,
      });

      await this.prisma.backtestTrade.createMany({
        data: result.trades.map((trade) => ({
          id: trade.id,
          runId,
          pairAddress: trade.pairAddress,
          baseSymbol: trade.baseSymbol,
          side: trade.side,
          intent: trade.intent,
          qty: trade.qty,
          priceUsd: trade.priceUsd,
          feeUsd: trade.feeUsd,
          slippageBps: trade.slippageBps,
          notionalUsd: trade.notionalUsd,
          pnlUsd: trade.pnlUsd,
          eventAt: new Date(trade.eventAt),
          observationId: trade.observationId,
          reasonCodes: trade.reasonCodes,
        })),
      });

      await this.prisma.experimentMetrics.create({
        data: {
          id: newId("exp"),
          runId,
          kind: "backtest_full",
          sampleSize: metrics.sampleSize,
          observed: Boolean(metrics.observed),
          payload: toJson({ metrics, validation, baselines, releaseGate }),
        },
      });

      const finishedAt = new Date();
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: {
          status: "COMPLETED",
          assumptions: toJson(result.assumptions),
          dataQuality: toJson(result.dataQuality),
          metrics: toJson(metrics),
          baselines: toJson(baselines),
          validation: toJson(validation),
          releaseGate: toJson(releaseGate),
          equityCurve: toJson(result.equityCurve.slice(-500)),
          reportHtml,
          finishedAt,
        },
      });

      globalObservability.record({
        category: "simulation_uptime",
        name: "backtest_completed",
        value: 1,
        unit: "count",
        meta: { runId, sampleSize: metrics.sampleSize },
      });
      await this.persistObservability();

      return this.getBacktest(runId);
    } catch (error) {
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Backtest failed",
          finishedAt: new Date(),
        },
      });
      globalObservability.record({
        category: "failed_jobs",
        name: "backtest_failed",
        value: 1,
        unit: "count",
        meta: { runId },
      });
      await this.persistObservability();
      throw error;
    }
  }

  async exportReport(id: string): Promise<{ html: string; filename: string }> {
    const row = await this.prisma.backtestRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Backtest run not found");
    if (!row.reportHtml) throw new NotFoundException("Report not generated for this run");
    return { html: row.reportHtml, filename: `odin-research-${id}.html` };
  }

  async requestOracleReview(runId: string) {
    const detail = await this.getBacktest(runId);
    const metrics = (detail.metrics ?? {}) as Record<string, unknown>;
    const validation = (detail.validation ?? {}) as {
      test?: { sampleSize?: number; returnPct?: string | null };
      sampleGate?: { passed?: boolean };
    };
    const releaseGate = (detail.releaseGate ?? {}) as { label?: string };
    const dataQuality = (detail.dataQuality ?? {}) as {
      inactivePairs?: unknown[];
      disappearedPairs?: unknown[];
    };
    const baselines = Array.isArray(detail.baselines)
      ? (detail.baselines as Array<{ name: string; returnPct: string | null }>)
      : [];

    const provider = createModelProvider({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      HERMES_BASE_URL: process.env.HERMES_BASE_URL,
      HERMES_API_KEY: process.env.HERMES_API_KEY,
    });
    const review = await runOracleReview(
      {
        runId,
        strategyName: detail.strategyVersion?.name ?? "unknown",
        sampleSize: Number(metrics.sampleSize ?? 0),
        oosSampleSize: validation.test?.sampleSize ?? null,
        returnPct: (metrics.returnPct as string | null) ?? null,
        oosReturnPct: validation.test?.returnPct ?? null,
        maxDrawdownPct: (metrics.maxDrawdownPct as string | null) ?? null,
        profitFactor: (metrics.profitFactor as string | null) ?? null,
        sampleGatePassed: Boolean(validation.sampleGate?.passed),
        releaseGateLabel: releaseGate.label ?? "NOT_RELEASE_READY",
        baselines: baselines.map((b) => ({ name: b.name, returnPct: b.returnPct })),
        assumptions: Array.isArray(detail.assumptions) ? (detail.assumptions as string[]) : [],
        inactivePairCount: dataQuality.inactivePairs?.length ?? 0,
        disappearedPairCount: dataQuality.disappearedPairs?.length ?? 0,
      },
      provider,
    );

    const row = await this.prisma.oracleReview.create({
      data: {
        id: newId("oracle"),
        runId,
        status: "PENDING_APPROVAL",
        summary: review.payload.summary,
        weaknesses: toJson(review.payload.weaknesses),
        suggestions: toJson(review.payload.suggestions),
        readiness: review.payload.readiness,
        provider: review.llm.ok ? review.llm.provider : "deterministic",
        modelVersion: review.modelVersion,
      },
    });

    globalObservability.record({
      category: "ai_tokens",
      name: "oracle_review",
      value: 1,
      unit: "calls",
      meta: { runId, provider: row.provider },
    });
    await this.persistObservability();

    return {
      id: row.id,
      status: row.status,
      summary: row.summary,
      weaknesses: review.payload.weaknesses,
      suggestions: review.payload.suggestions,
      readiness: row.readiness,
      approvalRequired: true,
      executesTrades: false,
      realMoneyGraduation: false,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async approveOracle(reviewId: string, approvedBy: string) {
    const row = await this.prisma.oracleReview.findUnique({ where: { id: reviewId } });
    if (!row) throw new NotFoundException("ORACLE review not found");
    const approval = approveOracleSuggestions({
      reviewId,
      approvedBy,
      approvedAt: new Date().toISOString(),
    });
    const updated = await this.prisma.oracleReview.update({
      where: { id: reviewId },
      data: {
        status: approval.status,
        approvedAt: new Date(),
        approvedBy,
      },
    });
    return {
      id: updated.id,
      status: updated.status,
      approvedAt: updated.approvedAt?.toISOString() ?? null,
      approvedBy: updated.approvedBy,
      promoted: false,
      realMoneyGraduation: false,
      note: "Approval records consent for further paper experiments only. RUNNING engine config is unchanged.",
    };
  }

  async observabilitySummary() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.observabilityEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const byCategory: Record<string, number> = {};
    for (const row of rows) {
      byCategory[row.category] = (byCategory[row.category] ?? 0) + Number(row.value ?? 0);
    }
    return {
      window: "24h",
      byCategory,
      recent: rows.slice(0, 50).map((row) => ({
        id: row.id,
        category: row.category,
        name: row.name,
        value: row.value?.toString() ?? null,
        unit: row.unit,
        createdAt: row.createdAt.toISOString(),
      })),
      inMemory: globalObservability.totalsByCategory(),
    };
  }

  private async ensureDefaultStrategyVersion(createdBy: string) {
    const existing = await this.prisma.strategyVersion.findFirst({
      where: { name: "default" },
      orderBy: { version: "desc" },
    });
    if (existing) return existing;
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const config = parseStrategyConfig(engine?.config);
    return this.prisma.strategyVersion.create({
      data: {
        id: newId("strat"),
        name: "default",
        version: 1,
        config: toJson(config),
        notes: "Seeded from engine config for Strategy Laboratory",
        status: "ACTIVE",
        createdBy,
      },
    });
  }

  private async loadObservations(input: {
    startAt?: string;
    endAt?: string;
    pairAddresses?: string[];
  }): Promise<BacktestObservation[]> {
    const where: {
      receivedAt?: { gte?: Date; lte?: Date };
      pairAddress?: { in: string[] };
    } = {};
    if (input.startAt || input.endAt) {
      where.receivedAt = {};
      if (input.startAt) where.receivedAt.gte = new Date(input.startAt);
      if (input.endAt) where.receivedAt.lte = new Date(input.endAt);
    }
    if (input.pairAddresses?.length) where.pairAddress = { in: input.pairAddresses };

    const rows = await this.prisma.marketObservation.findMany({
      where,
      orderBy: { receivedAt: "asc" },
      take: 20_000,
    });

    return rows.map((row) => ({
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
      freshness: "REPLAY",
      provenance: `MarketObservation:${row.id}`,
    }));
  }

  private async persistObservability() {
    const batch = globalObservability.snapshot();
    globalObservability.clear();
    if (batch.length === 0) return;
    await this.prisma.observabilityEvent.createMany({
      data: batch.map((event) => ({
        id: newId("obs"),
        category: event.category,
        name: event.name,
        value: event.value,
        unit: event.unit,
        meta: event.meta ? toJson(event.meta) : undefined,
        createdAt: new Date(event.at),
      })),
    });
  }
}

export type { StrategyConfig };
