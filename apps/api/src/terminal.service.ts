import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { performanceReport, valuePortfolio, type Mark } from "@odin/analytics";
import { BirdeyeClient } from "@odin/market-data";
import {
  QUEUES,
  REASON_TEXT,
  classifyFreshness,
  d,
  emergencyStopSchema,
  isReasonCode,
  mergeStrategy,
  newId,
  operatorOrderSchema,
  stageJobId,
  parseStrategyConfig,
  strategyPatchSchema,
  usd,
  type DataState,
  type EngineAction,
  type StrategyConfig,
} from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { allowedActions, transition } from "@odin/trading-engine";
import { Queue } from "bullmq";

@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaClient,
    @InjectQueue(QUEUES.ingest) private readonly ingest: Queue,
  ) {}

  async health(redisPing: () => Promise<boolean>) {
    const postgres = await this.pingPostgres();
    const redis = await redisPing();
    const latest = await this.prisma.marketObservation.findFirst({ orderBy: { receivedAt: "desc" } });
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const cycle = await this.prisma.cycleRun.findFirst({ orderBy: { startedAt: "desc" } });
    const config = this.readConfig(engine?.config);
    const dataState = latest && config
      ? classifyFreshness({
          mode: this.mode(),
          receivedAt: latest.receivedAt,
          now: new Date(),
          liveMaxAgeMs: config.liveMaxAgeMs,
          delayedMaxAgeMs: config.delayedMaxAgeMs,
        })
      : null;
    return {
      status: postgres && redis ? "ok" : "degraded",
      postgres: postgres ? "up" : "down",
      redis: redis ? "up" : "down",
      engine: engine?.status ?? null,
      dataState,
      lastObservationAt: latest?.receivedAt.toISOString() ?? null,
      lastCycleAt: cycle?.startedAt.toISOString() ?? null,
      lastCycleStatus: cycle?.status ?? null,
      venue: "PAPER",
    };
  }

  async snapshot() {
    const now = new Date();
    const engineRow = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const account = await this.prisma.paperAccount.findUnique({ where: { id: "primary" } });
    if (!engineRow || !account) throw new NotFoundException("Paper account is not initialised");
    const config = this.readConfig(engineRow.config);
    const latestBatch = await this.prisma.cycleRun.findFirst({
      where: { observationCount: { gt: 0 } },
      orderBy: { startedAt: "desc" },
    });
    const observations = latestBatch
      ? await this.prisma.marketObservation.findMany({
          where: { ingestJobId: latestBatch.id },
          orderBy: { liquidityUsd: "desc" },
        })
      : [];
    const latest = new Map(observations.map((row) => [row.pairAddress, row]));
    const pairs = [...latest.values()]
      .map((row) => this.presentPair(row, now, config))
      .sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0))
      .slice(0, config?.universeLimit ?? 12);
    const positions = await this.prisma.position.findMany({ where: { accountId: "primary" } });
    const marks: Record<string, Mark | undefined> = {};
    for (const position of positions) {
      const row = latest.get(position.pairAddress) ?? (await this.prisma.marketObservation.findFirst({
        where: { pairAddress: position.pairAddress },
        orderBy: { receivedAt: "desc" },
      }));
      if (!row || !config) continue;
      marks[position.pairAddress] = {
        priceUsd: row.priceUsd?.toString() ?? null,
        freshness: classifyFreshness({
          mode: this.mode(),
          receivedAt: row.receivedAt,
          now,
          liveMaxAgeMs: config.liveMaxAgeMs,
          delayedMaxAgeMs: config.delayedMaxAgeMs,
        }),
      };
    }
    const positionViews = positions.map((position) => ({
      pairAddress: position.pairAddress,
      baseSymbol: position.baseSymbol,
      baseQty: position.baseQty.toString(),
      avgCostUsd: position.avgCostUsd.toString(),
      realizedPnlUsd: position.realizedPnlUsd.toString(),
    }));
    const valuation = valuePortfolio({ cashUsd: account.cashUsd.toString(), positions: positionViews, marks });
    const fees = await this.prisma.ledgerEntry.aggregate({
      where: { accountId: "primary", type: "FEE" },
      _sum: { amountUsd: true },
    });
    const closed = await this.prisma.ledgerEntry.findMany({
      where: { accountId: "primary", type: "REALIZED_PNL" },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const equitySeriesRows = await this.prisma.equitySnapshot.findMany({
      where: { equityUsd: { not: null } },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: { equityUsd: true },
    });
    const report = performanceReport({
      valuation,
      startingBalanceUsd: account.startingBalanceUsd.toString(),
      feesUsd: usd(d(fees._sum.amountUsd?.toString() ?? "0").abs()),
      closedTradePnlUsd: closed.map((entry) => entry.amountUsd.toString()),
      equitySeries: equitySeriesRows.map((row) => row.equityUsd!.toString()),
    });
    const cycle = await this.prisma.cycleRun.findFirst({ orderBy: { startedAt: "desc" } });
    const decisions = cycle
      ? await this.prisma.agentDecision.findMany({ where: { cycleId: cycle.id }, orderBy: { createdAt: "asc" }, take: 120 })
      : [];
    const recentAgentDecisions = await this.prisma.agentDecision.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    const orders = await this.prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { fills: true },
    });
    const fillStats = await this.fillsStats();
    const closedPnls = closed.map((entry) => entry.amountUsd.toString());
    const largestGainUsd = closedPnls.length === 0 ? null : usd(closedPnls.reduce((best, value) => (d(value).gt(best) ? d(value) : best), d(closedPnls[0]!)));
    const largestLossUsd = closedPnls.length === 0 ? null : usd(closedPnls.reduce((worst, value) => (d(value).lt(worst) ? d(value) : worst), d(closedPnls[0]!)));
    const tradeDistribution = {
      wins: report.wins,
      losses: report.losses,
      breakeven: report.breakeven,
    };
    const openedAtByPair = await this.positionOpenedAt(positions.map((position) => position.pairAddress));
    const stopLossPct = config?.stopLossPct ?? null;
    const takeProfitPct = config?.takeProfitPct ?? null;
    const exposureUsd =
      report.valuation.equityUsd === null
        ? null
        : usd(d(report.valuation.equityUsd).minus(d(account.cashUsd.toString())));
    const drawdownPct =
      report.valuation.equityUsd === null || !account.highWaterMarkUsd || d(account.highWaterMarkUsd.toString()).lte(0)
        ? null
        : d(account.highWaterMarkUsd.toString())
            .minus(d(report.valuation.equityUsd))
            .div(d(account.highWaterMarkUsd.toString()))
            .mul(100)
            .toFixed(4);
    const states = pairs.map((pair) => pair.freshness);
    return {
      serverTime: now.toISOString(),
      venue: "PAPER",
      engine: {
        status: engineRow.status,
        flattenRequested: engineRow.flattenRequested,
        config,
        configValid: config !== null,
        allowedActions: allowedActions(engineRow.status as "STOPPED"),
        updatedAt: engineRow.updatedAt.toISOString(),
      },
      market: {
        dataState: worst(states),
        mode: this.mode(),
        pairs,
      },
      portfolio: {
        cashUsd: account.cashUsd.toString(),
        startingBalanceUsd: account.startingBalanceUsd.toString(),
        equityUsd: report.valuation.equityUsd,
        unrealizedPnlUsd: report.valuation.unrealizedPnlUsd,
        realizedPnlUsd: report.valuation.realizedPnlUsd,
        valuation: report.valuation.valuation,
        marksComplete: report.valuation.marksComplete,
        feesUsd: report.feesUsd,
        winRate: report.winRate,
        wins: report.wins,
        losses: report.losses,
        closedTrades: report.closedTrades,
        returnPct: report.returnPct,
        avgWinUsd: report.avgWinUsd,
        avgLossUsd: report.avgLossUsd,
        profitFactor: report.profitFactor,
        expectancyUsd: report.expectancyUsd,
        maxDrawdownPct: report.maxDrawdownPct,
        sampleSize: report.sampleSize,
        observed: report.observed,
        highWaterMarkUsd: account.highWaterMarkUsd?.toString() ?? null,
        availableFundsUsd: account.cashUsd.toString(),
        exposureUsd,
        currentDrawdownPct: drawdownPct,
        largestGainUsd,
        largestLossUsd,
        tradeDistribution,
        avgSlippageBps: fillStats.avgSlippageBps,
        totalSlippageUsd: fillStats.totalSlippageUsd,
        fillCount: fillStats.fillCount,
        positions: report.valuation.positions.map((position) => {
          const openedAt = openedAtByPair.get(position.pairAddress) ?? null;
          const stopUsd =
            stopLossPct == null
              ? null
              : usd(d(position.avgCostUsd).mul(d("1").minus(d(stopLossPct).div(100))));
          const targetUsd =
            takeProfitPct == null
              ? null
              : usd(d(position.avgCostUsd).mul(d("1").plus(d(takeProfitPct).div(100))));
          const exposurePct =
            report.valuation.equityUsd === null || position.marketValueUsd === null
              ? null
              : d(position.marketValueUsd).div(d(report.valuation.equityUsd)).mul(100).toFixed(4);
          return {
            ...position,
            openedAt,
            stopUsd,
            targetUsd,
            stopLossPct,
            takeProfitPct,
            exposurePct,
          };
        }),
      },
      agents: this.agentStatus(recentAgentDecisions.length > 0 ? recentAgentDecisions : decisions),
      watchlist: await this.watchlist(pairs, decisions),
      health: {
        postgres: "up",
        redis: "unknown",
        engine: engineRow.status,
        dataState: worst(states),
        venue: "PAPER" as const,
      },
      cycle: cycle
        ? {
            id: cycle.id,
            trigger: cycle.trigger,
            status: cycle.status,
            stage: cycle.stage,
            dataState: cycle.dataState,
            error: cycle.error,
            observationCount: cycle.observationCount,
            orderCount: cycle.orderCount,
            startedAt: cycle.startedAt.toISOString(),
            finishedAt: cycle.finishedAt?.toISOString() ?? null,
          }
        : null,
      decisions: decisions.map((decision) => this.presentDecision(decision)),
      orders: orders.map((order) => ({
        id: order.id,
        clientOrderId: order.clientOrderId,
        pairAddress: order.pairAddress,
        baseSymbol: order.baseSymbol,
        side: order.side,
        intent: order.intent,
        status: order.status,
        qty: order.qty.toString(),
        rejectReason: order.rejectReason,
        createdAt: order.createdAt.toISOString(),
        fills: order.fills.map((fill) => ({
          id: fill.id,
          qty: fill.qty.toString(),
          priceUsd: fill.priceUsd.toString(),
          notionalUsd: fill.notionalUsd.toString(),
          feeUsd: fill.feeUsd.toString(),
          slippageBps: fill.slippageBps.toString(),
          observationId: fill.observationId,
        })),
      })),
    };
  }

  async equityHistory(rangeRaw: string) {
    const range = ["1H", "24H", "7D", "30D", "ALL"].includes(rangeRaw.toUpperCase())
      ? rangeRaw.toUpperCase()
      : "24H";
    const since = equityRangeStart(range);
    const rows = await this.prisma.equitySnapshot.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      orderBy: { createdAt: "asc" },
      take: 2_000,
    });
    const account = await this.prisma.paperAccount.findUnique({ where: { id: "primary" } });
    const points = rows.map((row) => {
      const equity = row.equityUsd?.toString() ?? null;
      const hwm = row.highWaterMarkUsd?.toString() ?? null;
      const drawdownPct =
        equity === null || hwm === null || d(hwm).lte(0)
          ? null
          : d(hwm).minus(d(equity)).div(d(hwm)).mul(100).toFixed(4);
      return {
        time: Math.floor(row.createdAt.getTime() / 1000),
        createdAt: row.createdAt.toISOString(),
        cycleId: row.cycleId,
        cashUsd: row.cashUsd.toString(),
        equityUsd: equity,
        unrealizedPnlUsd: row.unrealizedPnlUsd?.toString() ?? null,
        realizedPnlUsd: row.realizedPnlUsd.toString(),
        highWaterMarkUsd: hwm,
        exposureUsd: row.exposureUsd?.toString() ?? null,
        valuation: row.valuation,
        feesUsd: row.feesUsd.toString(),
        drawdownPct,
        gap: equity === null || row.valuation === "INCOMPLETE",
      };
    });
    const fills = await this.prisma.fill.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      orderBy: { createdAt: "asc" },
      take: 200,
      include: { order: { select: { side: true, baseSymbol: true, intent: true } } },
    });
    const markers = fills.map((fill) => ({
      time: Math.floor(fill.createdAt.getTime() / 1000),
      createdAt: fill.createdAt.toISOString(),
      side: fill.order.side,
      baseSymbol: fill.order.baseSymbol,
      intent: fill.order.intent,
      priceUsd: fill.priceUsd.toString(),
      qty: fill.qty.toString(),
      notionalUsd: fill.notionalUsd.toString(),
    }));
    const warningWhere = {
      OR: [{ status: "FAILED" }, { error: { not: null } }],
      ...(since ? { startedAt: { gte: since } } : {}),
    };
    const warnings = await this.prisma.cycleRun.findMany({
      where: warningWhere,
      orderBy: { startedAt: "asc" },
      take: 100,
    });
    return {
      range,
      startingBalanceUsd: account?.startingBalanceUsd.toString() ?? null,
      pointCount: points.length,
      pricedPointCount: points.filter((point) => point.equityUsd !== null).length,
      points,
      markers,
      annotations: warnings.map((cycle) => ({
        time: Math.floor(cycle.startedAt.getTime() / 1000),
        createdAt: cycle.startedAt.toISOString(),
        kind: "SYSTEM_WARNING" as const,
        label: cycle.error ?? cycle.status,
        cycleId: cycle.id,
      })),
      insufficientHistory: points.filter((point) => point.equityUsd !== null).length < 2,
    };
  }

  async activityFeed(limit: number) {
    const take = Math.min(Math.max(limit, 1), 200);
    const [decisions, orders, cycles] = await Promise.all([
      this.prisma.agentDecision.findMany({ orderBy: { createdAt: "desc" }, take }),
      this.prisma.order.findMany({ orderBy: { createdAt: "desc" }, take, include: { fills: true } }),
      this.prisma.cycleRun.findMany({
        where: { OR: [{ status: "FAILED" }, { error: { not: null } }] },
        orderBy: { startedAt: "desc" },
        take: Math.min(take, 40),
      }),
    ]);
    const events: Array<{
      id: string;
      kind: string;
      source: string;
      timestamp: string;
      summary: string;
      pairAddress: string | null;
      details: Record<string, unknown>;
    }> = [];

    for (const decision of decisions) {
      const kind = classifyDecisionEvent(decision.agent, decision.decision, decision.reasonCodes);
      events.push({
        id: `decision:${decision.id}`,
        kind,
        source: decision.agent,
        timestamp: decision.createdAt.toISOString(),
        summary: decision.reasonCodes.map((code) => (isReasonCode(code) ? REASON_TEXT[code] : code)).join(" · ") || decision.decision,
        pairAddress: decision.pairAddress || null,
        details: {
          decisionId: decision.id,
          decision: decision.decision,
          confidence: decision.confidence.toString(),
          reasonCodes: decision.reasonCodes,
          inputSource: decision.inputSource,
          durationMs: decision.durationMs,
          modelVersion: decision.modelVersion,
        },
      });
    }

    for (const order of orders) {
      events.push({
        id: `order:${order.id}`,
        kind: order.status === "FILLED" || order.fills.length > 0 ? "ORDER_SUBMITTED" : order.status === "REJECTED" ? "RISK_REJECT" : "ORDER_SUBMITTED",
        source: "EXECUTOR",
        timestamp: order.createdAt.toISOString(),
        summary: `${order.side} ${order.baseSymbol} · ${order.status}${order.rejectReason ? ` · ${order.rejectReason}` : ""}`,
        pairAddress: order.pairAddress,
        details: {
          orderId: order.id,
          side: order.side,
          intent: order.intent,
          status: order.status,
          qty: order.qty.toString(),
          rejectReason: order.rejectReason,
        },
      });
      for (const fill of order.fills) {
        events.push({
          id: `fill:${fill.id}`,
          kind: order.side === "SELL" ? "EXIT" : "FILL",
          source: "LEDGER",
          timestamp: fill.createdAt.toISOString(),
          summary: `${order.side} fill ${order.baseSymbol} @ ${fill.priceUsd.toString()}`,
          pairAddress: order.pairAddress,
          details: {
            fillId: fill.id,
            orderId: order.id,
            priceUsd: fill.priceUsd.toString(),
            qty: fill.qty.toString(),
            feeUsd: fill.feeUsd.toString(),
            slippageBps: fill.slippageBps.toString(),
            notionalUsd: fill.notionalUsd.toString(),
          },
        });
      }
    }

    for (const cycle of cycles) {
      events.push({
        id: `cycle:${cycle.id}`,
        kind: "SYSTEM_WARNING",
        source: "ENGINE",
        timestamp: cycle.startedAt.toISOString(),
        summary: cycle.error ?? `Cycle ${cycle.status}`,
        pairAddress: null,
        details: {
          cycleId: cycle.id,
          status: cycle.status,
          stage: cycle.stage,
          error: cycle.error,
        },
      });
    }

    return {
      events: events
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, take),
    };
  }

  async decisionDetail(id: string) {
    const decision = await this.prisma.agentDecision.findUnique({ where: { id } });
    if (!decision) throw new NotFoundException("Decision not found");
    return {
      ...this.presentDecision(decision),
      input: decision.input,
      output: decision.output,
    };
  }

  async agentDetail(agentRaw: string) {
    const agent = agentRaw.toUpperCase();
    const decisions = await this.prisma.agentDecision.findMany({
      where: { agent },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const latest = decisions[0] ?? null;
    return {
      agent,
      latest: latest ? { ...this.presentDecision(latest), input: latest.input, output: latest.output } : null,
      recent: decisions.map((decision) => this.presentDecision(decision)),
    };
  }

  async systemLogs(limit: number) {
    const take = Math.min(Math.max(limit, 1), 200);
    const cycles = await this.prisma.cycleRun.findMany({ orderBy: { startedAt: "desc" }, take });
    return {
      entries: cycles.map((cycle) => ({
        id: cycle.id,
        level: cycle.error || cycle.status === "FAILED" ? "error" : cycle.status === "COMPLETE" ? "info" : "warn",
        timestamp: cycle.startedAt.toISOString(),
        stage: cycle.stage,
        status: cycle.status,
        trigger: cycle.trigger,
        dataState: cycle.dataState,
        message: cycle.error ?? `${cycle.trigger} · ${cycle.stage} · ${cycle.status}`,
        observationCount: cycle.observationCount,
        orderCount: cycle.orderCount,
        finishedAt: cycle.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  async observations(pairAddress: string) {
    const rows = await this.prisma.marketObservation.findMany({
      where: { pairAddress },
      orderBy: { receivedAt: "asc" },
      take: 300,
    });
    const points: Array<{ time: number; priceUsd: string }> = [];
    for (const row of rows) {
      if (!row.priceUsd) continue;
      const time = Math.floor(row.receivedAt.getTime() / 1000);
      const priceUsd = row.priceUsd.toString();
      const previous = points.at(-1);
      if (previous && previous.time === time) previous.priceUsd = priceUsd;
      else points.push({ time, priceUsd });
    }
    return { pairAddress, points };
  }

  async act(action: EngineAction, actor: string, body?: unknown) {
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) throw new NotFoundException("Engine is not initialised");
    const next = transition(engine.status as "STOPPED", action);
    if (!next) throw new ConflictException(`Cannot ${action} from ${engine.status}`);
    let flattenRequested = engine.flattenRequested;
    if (action === "emergency_stop") {
      const input = parseBodySafe(emergencyStopSchema, body ?? {});
      flattenRequested = Boolean(input.flatten);
    }
    if (action === "resume" || action === "start") flattenRequested = false;
    const updated = await this.prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: next, flattenRequested, updatedBy: actor },
    });
    return { status: updated.status, flattenRequested: updated.flattenRequested, allowedActions: allowedActions(next) };
  }

  async updateConfig(patch: unknown, actor: string) {
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      const identityKey = ["sourceHash", "artifactHash", "strategyId", "strategyVersion", "activeStrategy"].find(
        (key) => key in patch,
      );
      if (identityKey) {
        throw new ConflictException("Promoted paper strategy identity changes only through operator promotion");
      }
    }
    const parsedPatch = strategyPatchSchema.parse(patch);
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) throw new NotFoundException("Engine is not initialised");
    if (engine.status === "RUNNING") throw new ConflictException("Pause the engine before changing risk limits");
    const current = parseStrategyConfig(engine.config);
    if (promotedPaperStrategy(engine.activeStrategy)) {
      const changed = Object.entries(parsedPatch).some(([key, value]) => {
        if (value === undefined) return false;
        const currentValue = (current as Record<string, unknown>)[key];
        return String(currentValue) !== String(value);
      });
      if (changed) {
        throw new ConflictException("The promoted paper strategy stays unchanged until a new operator promotion");
      }
    }
    const next = mergeStrategy(current, parsedPatch);
    if (!d(next.startingBalanceUsd).eq(d(current.startingBalanceUsd))) {
      await this.resetBalance(next);
    }
    const updated = await this.prisma.engineControl.update({
      where: { id: "primary" },
      data: { config: toJson(next), updatedBy: actor },
    });
    return { config: parseStrategyConfig(updated.config), status: updated.status };
  }

  async submitOrder(body: unknown) {
    const order = operatorOrderSchema.parse(body);
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine || engine.status !== "RUNNING") throw new ConflictException("Paper orders are accepted only while the engine is running");
    const cycleId = newId("cyc");
    await this.prisma.cycleRun.create({
      data: {
        id: cycleId,
        trigger: "operator",
        status: "RUNNING",
        stage: "created",
        dataState: "PENDING",
        operator: toJson(order),
        startedAt: new Date(),
      },
    });
    await this.ingest.add(
      "ingest",
      { cycleId, trigger: "operator" },
      { jobId: stageJobId("ingest", cycleId), attempts: 3, removeOnComplete: 100, removeOnFail: 50 },
    );
    const deadline = Date.now() + 12_000;
    let cycle = await this.prisma.cycleRun.findUnique({ where: { id: cycleId } });
    while (cycle && cycle.status === "RUNNING" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      cycle = await this.prisma.cycleRun.findUnique({ where: { id: cycleId } });
    }
    const orders = await this.prisma.order.findMany({ where: { cycleId }, include: { fills: true } });
    return {
      cycleId,
      status: cycle?.status ?? "RUNNING",
      error: cycle?.error ?? null,
      orders: orders.map((item) => ({
        status: item.status,
        side: item.side,
        qty: item.qty.toString(),
        rejectReason: item.rejectReason,
        fills: item.fills.map((fill) => ({ priceUsd: fill.priceUsd.toString(), qty: fill.qty.toString(), feeUsd: fill.feeUsd.toString() })),
      })),
    };
  }

  async birdeyeSecurity(tokenAddress: string) {
    return new BirdeyeClient(process.env.BIRDEYE_API_KEY || undefined).getTokenSecurity(tokenAddress);
  }

  async birdeyeHolders(tokenAddress: string) {
    return new BirdeyeClient(process.env.BIRDEYE_API_KEY || undefined).getHolders(tokenAddress);
  }

  async birdeyeOhlcv(tokenAddress: string) {
    const now = Math.floor(Date.now() / 1000);
    return new BirdeyeClient(process.env.BIRDEYE_API_KEY || undefined).getOhlcv(tokenAddress, "15m", now - 60 * 60 * 24, now);
  }

  private async resetBalance(config: StrategyConfig) {
    const orders = await this.prisma.order.count();
    if (orders > 0) throw new ConflictException("Starting balance can change only before any paper order exists");
    const amount = usd(d(config.startingBalanceUsd));
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(641001)`;
      await tx.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: amount, startingBalanceUsd: amount } });
      await tx.ledgerEntry.deleteMany({ where: { accountId: "primary", type: "OPENING_BALANCE" } });
      await tx.ledgerEntry.create({
        data: {
          accountId: "primary",
          type: "OPENING_BALANCE",
          amountUsd: amount,
          affectsCash: true,
          note: "Reset paper starting balance",
        },
      });
    });
  }

  private presentPair(
    row: {
      id: string;
      pairAddress: string;
      baseSymbol: string;
      quoteSymbol: string;
      dexId: string;
      url: string | null;
      baseAddress: string;
      priceUsd: { toString(): string } | null;
      liquidityUsd: { toString(): string } | null;
      volume24hUsd: { toString(): string } | null;
      priceChangeM5: { toString(): string } | null;
      priceChangeH1: { toString(): string } | null;
      priceChangeH24: { toString(): string } | null;
      pairCreatedAt?: Date | null;
      receivedAt: Date;
      source: string;
    },
    now: Date,
    config: StrategyConfig | null,
  ) {
    const freshness = classifyFreshness({
      mode: this.mode(),
      receivedAt: row.receivedAt,
      now,
      liveMaxAgeMs: config?.liveMaxAgeMs ?? 45_000,
      delayedMaxAgeMs: config?.delayedMaxAgeMs ?? 180_000,
    });
    return {
      observationId: row.id,
      pairAddress: row.pairAddress,
      baseSymbol: row.baseSymbol,
      quoteSymbol: row.quoteSymbol,
      baseAddress: row.baseAddress,
      dexId: row.dexId,
      url: row.url,
      source: row.source,
      priceUsd: row.priceUsd?.toString() ?? null,
      liquidityUsd: row.liquidityUsd?.toString() ?? null,
      volume24hUsd: row.volume24hUsd?.toString() ?? null,
      priceChangeM5Pct: row.priceChangeM5?.toString() ?? null,
      priceChangeH1Pct: row.priceChangeH1?.toString() ?? null,
      priceChangeH24Pct: row.priceChangeH24?.toString() ?? null,
      pairCreatedAt: row.pairCreatedAt?.toISOString() ?? null,
      freshness,
      receivedAt: row.receivedAt.toISOString(),
    };
  }

  private readConfig(value: unknown): StrategyConfig | null {
    try {
      return parseStrategyConfig(value);
    } catch {
      return null;
    }
  }

  private mode() {
    return process.env.DATA_MODE === "replay" || process.env.DATA_MODE === "demo" ? process.env.DATA_MODE : "live";
  }

  private async pingPostgres(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private agentStatus(
    decisions: Array<{
      id: string;
      agent: string;
      modelVersion: string;
      pairAddress: string;
      decision: string;
      confidence: { toString(): string };
      reasonCodes: string[];
      inputSource: string | null;
      durationMs: number | null;
      createdAt: Date;
      output: unknown;
    }>,
  ) {
    const agents = ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR", "ARCHIVIST"] as const;
    return agents.map((agent) => {
      const latest = [...decisions]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .find((decision) => decision.agent === agent);
      const outcome =
        latest == null
          ? "—"
          : latest.reasonCodes[0]
            ? isReasonCode(latest.reasonCodes[0])
              ? REASON_TEXT[latest.reasonCodes[0]]
              : latest.reasonCodes[0]
            : latest.decision;
      return {
        agent,
        decision: latest?.decision ?? null,
        confidence: latest?.confidence.toString() ?? null,
        reasonCodes: latest?.reasonCodes ?? [],
        inputSource: latest?.inputSource ?? null,
        durationMs: latest?.durationMs ?? null,
        outcome,
        pairAddress: latest?.pairAddress || null,
        modelVersion: latest?.modelVersion ?? null,
        createdAt: latest?.createdAt.toISOString() ?? null,
      };
    });
  }

  private async watchlist(
    marketPairs: Array<{
      pairAddress: string;
      priceUsd: string | null;
      liquidityUsd: string | null;
      volume24hUsd: string | null;
      priceChangeM5Pct: string | null;
      receivedAt: string;
      freshness: DataState;
      baseAddress: string;
      pairCreatedAt?: string | null;
    }>,
    cycleDecisions: Array<{
      pairAddress: string;
      agent: string;
      decision: string;
      reasonCodes: string[];
    }>,
  ) {
    const rows = await this.prisma.watchlistEntry.findMany({
      orderBy: [{ rank: "asc" }, { score: "desc" }],
      take: 40,
    });
    const pairByAddress = new Map(marketPairs.map((pair) => [pair.pairAddress, pair]));
    const tokens = [...new Set(rows.map((row) => row.baseAddress))];
    const assessments =
      tokens.length === 0
        ? []
        : await this.prisma.securityAssessment.findMany({ where: { tokenAddress: { in: tokens } } });
    const assessmentByToken = new Map(assessments.map((row) => [row.tokenAddress, row]));
    const observationFallback = new Map<
      string,
      {
        priceUsd: string | null;
        liquidityUsd: string | null;
        volume24hUsd: string | null;
        priceChangeM5Pct: string | null;
        receivedAt: string;
        freshness: DataState;
        pairCreatedAt: string | null;
        baseAddress: string;
      }
    >();

    for (const row of rows) {
      if (pairByAddress.has(row.pairAddress)) continue;
      const observation = await this.prisma.marketObservation.findFirst({
        where: { pairAddress: row.pairAddress },
        orderBy: { receivedAt: "desc" },
      });
      if (!observation) continue;
      const config = null;
      observationFallback.set(row.pairAddress, {
        priceUsd: observation.priceUsd?.toString() ?? null,
        liquidityUsd: observation.liquidityUsd?.toString() ?? null,
        volume24hUsd: observation.volume24hUsd?.toString() ?? null,
        priceChangeM5Pct: observation.priceChangeM5?.toString() ?? null,
        receivedAt: observation.receivedAt.toISOString(),
        freshness: classifyFreshness({
          mode: this.mode(),
          receivedAt: observation.receivedAt,
          now: new Date(),
          liveMaxAgeMs: 45_000,
          delayedMaxAgeMs: 180_000,
        }),
        pairCreatedAt: observation.pairCreatedAt?.toISOString() ?? null,
        baseAddress: observation.baseAddress,
      });
      void config;
    }

    return rows.map((row) => {
      const market = pairByAddress.get(row.pairAddress);
      const fallback = observationFallback.get(row.pairAddress);
      const security = assessmentByToken.get(row.baseAddress);
      const agentRec =
        [...cycleDecisions]
          .reverse()
          .find((decision) => decision.pairAddress === row.pairAddress && ["PULSE", "AEGIS", "ATLAS", "EXECUTOR"].includes(decision.agent)) ??
        null;
      const ageMs = (() => {
        const createdAt = market?.pairCreatedAt ?? fallback?.pairCreatedAt ?? null;
        const created = createdAt ? Date.parse(createdAt) : NaN;
        if (Number.isFinite(created)) return Date.now() - created;
        return null;
      })();
      return {
        pairAddress: row.pairAddress,
        baseAddress: row.baseAddress,
        baseSymbol: row.baseSymbol,
        quoteSymbol: row.quoteSymbol,
        dexId: row.dexId,
        score: row.score.toString(),
        rank: row.rank,
        source: row.source,
        reasonCodes: row.reasonCodes,
        observedAt: row.observedAt.toISOString(),
        priceUsd: market?.priceUsd ?? fallback?.priceUsd ?? null,
        liquidityUsd: market?.liquidityUsd ?? fallback?.liquidityUsd ?? null,
        volume24hUsd: market?.volume24hUsd ?? fallback?.volume24hUsd ?? null,
        momentumPct: market?.priceChangeM5Pct ?? fallback?.priceChangeM5Pct ?? null,
        freshness: market?.freshness ?? fallback?.freshness ?? null,
        ageMs,
        security: security
          ? {
              category: security.category,
              confidence: security.confidence.toString(),
              reasonCodes: security.reasonCodes,
              stale: security.stale,
              mintAuthority: security.mintAuthority,
              freezeAuthority: security.freezeAuthority,
            }
          : null,
        recommendation: agentRec
          ? {
              agent: agentRec.agent,
              decision: agentRec.decision,
              reasonCodes: agentRec.reasonCodes,
            }
          : null,
        lastUpdated: market?.receivedAt ?? fallback?.receivedAt ?? row.observedAt.toISOString(),
      };
    });
  }

  private presentDecision(decision: {
    id: string;
    agent: string;
    modelVersion: string;
    pairAddress: string;
    decision: string;
    confidence: { toString(): string };
    reasonCodes: string[];
    inputSource: string | null;
    durationMs: number | null;
    createdAt: Date;
  }) {
    return {
      id: decision.id,
      agent: decision.agent,
      modelVersion: decision.modelVersion,
      pairAddress: decision.pairAddress || null,
      decision: decision.decision,
      confidence: decision.confidence.toString(),
      reasonCodes: decision.reasonCodes,
      reasonText: decision.reasonCodes.map((code) => (isReasonCode(code) ? REASON_TEXT[code] : code)),
      inputSource: decision.inputSource,
      durationMs: decision.durationMs,
      createdAt: decision.createdAt.toISOString(),
    };
  }

  private async fillsStats() {
    const fills = await this.prisma.fill.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { slippageBps: true, notionalUsd: true, feeUsd: true },
    });
    if (fills.length === 0) {
      return { avgSlippageBps: null as string | null, totalSlippageUsd: null as string | null, fillCount: 0 };
    }
    const avgSlippageBps = fills
      .reduce((total, fill) => total.plus(d(fill.slippageBps.toString())), d("0"))
      .div(fills.length)
      .toFixed(4);
    const totalSlippageUsd = usd(
      fills.reduce(
        (total, fill) => total.plus(d(fill.notionalUsd.toString()).mul(d(fill.slippageBps.toString())).div(10_000)),
        d("0"),
      ),
    );
    return { avgSlippageBps, totalSlippageUsd, fillCount: fills.length };
  }

  private async positionOpenedAt(pairAddresses: string[]) {
    const result = new Map<string, string>();
    for (const pairAddress of pairAddresses) {
      const fill = await this.prisma.fill.findFirst({
        where: { pairAddress, order: { side: "BUY" } },
        orderBy: { createdAt: "asc" },
      });
      if (fill) result.set(pairAddress, fill.createdAt.toISOString());
    }
    return result;
  }
}

function promotedPaperStrategy(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "strategyId" in value &&
      "sourceHash" in value &&
      "artifactHash" in value,
  );
}

function parseBodySafe<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  return schema.parse(body);
}

function worst(states: DataState[]): DataState | null {
  const rank: Record<DataState, number> = { LIVE: 0, DELAYED: 1, STALE: 2, REPLAY: 3, DEMO: 4 };
  if (states.length === 0) return null;
  return states.reduce((worstState, state) => (rank[state] > rank[worstState] ? state : worstState));
}

function equityRangeStart(range: string): Date | null {
  const now = Date.now();
  switch (range) {
    case "1H":
      return new Date(now - 60 * 60 * 1000);
    case "24H":
      return new Date(now - 24 * 60 * 60 * 1000);
    case "7D":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "30D":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

function classifyDecisionEvent(agent: string, decision: string, reasonCodes: string[]): string {
  if (agent === "SENTINEL") return "SCAN";
  if (agent === "PULSE") return "SIGNAL";
  if (agent === "AEGIS") {
    if (decision === "BLOCK" || reasonCodes.some((code) => code.includes("BLOCK"))) return "SECURITY_BLOCK";
    return "SECURITY_PASS";
  }
  if (agent === "ATLAS" && (decision === "REJECT" || reasonCodes.some((code) => code.includes("REJECT") || code.includes("RISK")))) {
    return "RISK_REJECT";
  }
  if (agent === "EXECUTOR") return decision === "SUBMIT" || decision === "BUY" || decision === "SELL" ? "ORDER_SUBMITTED" : "SIGNAL";
  return "SIGNAL";
}
