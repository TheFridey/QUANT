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
    const report = performanceReport({
      valuation,
      startingBalanceUsd: account.startingBalanceUsd.toString(),
      feesUsd: usd(d(fees._sum.amountUsd?.toString() ?? "0").abs()),
      closedTradePnlUsd: closed.map((entry) => entry.amountUsd.toString()),
    });
    const cycle = await this.prisma.cycleRun.findFirst({ orderBy: { startedAt: "desc" } });
    const decisions = cycle
      ? await this.prisma.agentDecision.findMany({ where: { cycleId: cycle.id }, orderBy: { createdAt: "asc" }, take: 80 })
      : [];
    const orders = await this.prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { fills: true },
    });
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
        positions: report.valuation.positions,
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
      decisions: decisions.map((decision) => ({
        id: decision.id,
        agent: decision.agent,
        modelVersion: decision.modelVersion,
        pairAddress: decision.pairAddress || null,
        decision: decision.decision,
        confidence: decision.confidence.toString(),
        reasonCodes: decision.reasonCodes,
        reasonText: decision.reasonCodes.map((code) => (isReasonCode(code) ? REASON_TEXT[code] : code)),
        createdAt: decision.createdAt.toISOString(),
      })),
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
    const parsedPatch = strategyPatchSchema.parse(patch);
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) throw new NotFoundException("Engine is not initialised");
    if (engine.status === "RUNNING") throw new ConflictException("Pause the engine before changing risk limits");
    const current = parseStrategyConfig(engine.config);
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
}

function parseBodySafe<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  return schema.parse(body);
}

function worst(states: DataState[]): DataState | null {
  const rank: Record<DataState, number> = { LIVE: 0, DELAYED: 1, STALE: 2, REPLAY: 3, DEMO: 4 };
  if (states.length === 0) return null;
  return states.reduce((worstState, state) => (rank[state] > rank[worstState] ? state : worstState));
}
