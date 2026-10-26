import { planCycle, type DecisionDraft } from "@odin/agent-core";
import { valuePortfolio, type Mark } from "@odin/analytics";
import { fetchSolanaUniverse, type ProviderResult } from "@odin/market-data";
import type { NormalizedPair } from "@odin/shared";
import {
  AGENT_BUS_CHANNEL,
  TERMINAL_CHANNEL,
  classifyFreshness,
  d,
  newId,
  operatorOrderSchema,
  parseStrategyConfig,
  type CyclePair,
  type DataMode,
  type DataState,
  type OperatorOrder,
  type StrategyConfig,
} from "@odin/shared";
import { Prisma, PrismaClient, toJson } from "@odin/shared/db";
import { commitProposedOrder, lockAccount } from "@odin/trading-engine";

export type MarketFeed = {
  fetchUniverse(limit: number): Promise<ProviderResult<NormalizedPair[]>>;
};

export type AgentBus = {
  publish(channel: string, payload: unknown): Promise<void>;
};

export const silentBus: AgentBus = { async publish() {} };

export class StageRunner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly feed: MarketFeed,
    private readonly bus: AgentBus,
    private readonly dataMode: DataMode,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(input: { cycleId?: string; trigger: string }): Promise<{ cycleId: string; skipped: boolean }> {
    const now = this.now();
    await this.prisma.cycleRun.updateMany({
      where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - 120_000) } },
      data: { status: "FAILED", error: "STALE_CYCLE", finishedAt: now },
    });
    if (!input.cycleId) {
      const active = await this.prisma.cycleRun.findFirst({ where: { status: "RUNNING" } });
      if (active) return { cycleId: active.id, skipped: true };
      const cycleId = newId("cyc");
      await this.prisma.cycleRun.create({
        data: {
          id: cycleId,
          trigger: input.trigger,
          status: "RUNNING",
          stage: "created",
          dataState: "PENDING",
          startedAt: now,
        },
      });
      await this.observe(cycleId, now);
      await this.emit(cycleId, "ingest");
      return { cycleId, skipped: false };
    }
    const cycle = await this.prisma.cycleRun.findUnique({ where: { id: input.cycleId } });
    if (!cycle) throw new Error("CYCLE_MISSING");
    if (cycle.stage === "created") await this.observe(cycle.id, now);
    await this.emit(cycle.id, "ingest");
    return { cycleId: cycle.id, skipped: false };
  }

  async sentinel(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "created"))) return;
    await this.persistAgent(cycleId, "SENTINEL");
    await this.advance(cycleId, "sentinel");
  }

  async pulse(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "sentinel"))) return;
    await this.persistAgent(cycleId, "PULSE");
    await this.advance(cycleId, "pulse");
  }

  async aegis(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "pulse"))) return;
    await this.persistAgent(cycleId, "AEGIS");
    await this.advance(cycleId, "aegis");
  }

  async atlas(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "aegis"))) return;
    await this.persistAgent(cycleId, "ATLAS");
    await this.advance(cycleId, "atlas");
  }

  async executor(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "atlas"))) return;
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      const loaded = await this.loadPlan(cycleId, now, tx);
      if (!loaded) return;
      for (const decision of loaded.plan.decisions.filter((item) => item.agent === "AEGIS" || item.agent === "ATLAS" || item.agent === "EXECUTOR")) {
        await upsertDecision(tx, cycleId, decision);
      }
      let filled = 0;
      for (const order of loaded.plan.orders) {
        const result = await commitProposedOrder(tx, {
          accountId: "primary",
          cycleId,
          order,
          config: loaded.config,
          mode: this.dataMode,
          now,
        });
        if (result.status === "FILLED") filled += 1;
      }
      if (loaded.flattenRequested) {
        await tx.engineControl.update({ where: { id: "primary" }, data: { flattenRequested: false } });
      }
      await tx.cycleRun.update({ where: { id: cycleId }, data: { orderCount: filled } });
    });
    await this.advance(cycleId, "executor");
  }

  async archivist(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "executor"))) return;
    const count = await this.prisma.agentDecision.count({ where: { cycleId } });
    const orders = await this.prisma.order.count({ where: { cycleId, status: "FILLED" } });
    await upsertDecision(this.prisma, cycleId, {
      agent: "ARCHIVIST",
      modelVersion: "archivist-1.0.0",
      pairAddress: "",
      decision: "PASS",
      confidence: "1.000000",
      reasonCodes: ["AUDIT_RECORDED"],
      input: {},
      output: { decisions: count + 1, orders },
    });
    await this.prisma.cycleRun.update({
      where: { id: cycleId },
      data: { stage: "complete", status: "COMPLETE", finishedAt: this.now(), orderCount: orders },
    });
    await this.emit(cycleId, "complete");
  }

  async fail(cycleId: string, error: string): Promise<void> {
    await this.prisma.cycleRun.updateMany({
      where: { id: cycleId, status: "RUNNING" },
      data: { status: "FAILED", error: error.slice(0, 500), finishedAt: this.now() },
    });
    await this.emit(cycleId, "failed");
  }

  private async observe(cycleId: string, now: Date): Promise<void> {
    const config = await this.config();
    if (this.dataMode === "demo") {
      await this.prisma.cycleRun.update({
        where: { id: cycleId },
        data: { dataState: "DEMO", observationCount: 0, error: "Demo mode does not synthesize prices" },
      });
      await upsertDecision(this.prisma, cycleId, emptyDecision("DATA_DEMO", "Demo mode does not synthesize prices"));
      return;
    }
    if (this.dataMode === "replay") {
      const copied = await this.copyReplay(cycleId, config, now);
      await this.prisma.cycleRun.update({
        where: { id: cycleId },
        data: { dataState: copied > 0 ? "REPLAY" : "STALE", observationCount: copied, error: copied > 0 ? null : "No stored observations to replay" },
      });
      return;
    }
    const result = await this.feed.fetchUniverse(config.universeLimit);
    if (!result.ok) {
      await this.prisma.cycleRun.update({
        where: { id: cycleId },
        data: { dataState: "STALE", observationCount: 0, error: result.error },
      });
      await upsertDecision(this.prisma, cycleId, emptyDecision("UPSTREAM_UNAVAILABLE", result.error));
      return;
    }
    for (const pair of result.data) {
      const freshness = classifyFreshness({
        mode: "live",
        receivedAt: now,
        now,
        liveMaxAgeMs: config.liveMaxAgeMs,
        delayedMaxAgeMs: config.delayedMaxAgeMs,
      });
      await this.prisma.marketObservation.upsert({
        where: { ingestJobId_pairAddress: { ingestJobId: cycleId, pairAddress: pair.pairAddress } },
        create: observationData(cycleId, pair, freshness, now),
        update: {},
      });
    }
    const state: DataState = result.data.length === 0 ? "STALE" : "LIVE";
    await this.prisma.cycleRun.update({
      where: { id: cycleId },
      data: {
        dataState: state,
        observationCount: result.data.length,
        error: result.data.length === 0 ? "DexScreener returned no Solana pairs" : null,
      },
    });
    if (result.data.length === 0) {
      await upsertDecision(this.prisma, cycleId, emptyDecision("EMPTY_UNIVERSE", "DexScreener returned no Solana pairs"));
    }
  }

  private async persistAgent(cycleId: string, agent: DecisionDraft["agent"]): Promise<void> {
    const loaded = await this.loadPlan(cycleId, this.now(), this.prisma);
    if (!loaded) return;
    for (const decision of loaded.plan.decisions.filter((item) => item.agent === agent)) {
      await upsertDecision(this.prisma, cycleId, decision);
    }
  }

  private async loadPlan(cycleId: string, now: Date, db: PrismaClient | Prisma.TransactionClient) {
    const cycle = await db.cycleRun.findUnique({ where: { id: cycleId } });
    const engine = await db.engineControl.findUnique({ where: { id: "primary" } });
    const account = await db.paperAccount.findUnique({ where: { id: "primary" } });
    if (!cycle || !engine || !account) return null;
    let config: StrategyConfig;
    try {
      config = parseStrategyConfig(engine.config);
    } catch {
      await upsertDecision(db, cycleId, emptyDecision("CONFIG_INVALID", "Strategy configuration failed validation"));
      return null;
    }
    const rows = await db.marketObservation.findMany({ where: { ingestJobId: cycleId } });
    const pairs = rows.map((row) => toCyclePair(row, now, config, this.dataMode));
    const positions = await db.position.findMany({ where: { accountId: "primary" } });
    const marks: Record<string, Mark | undefined> = {};
    for (const pair of pairs) {
      if (pair.priceUsd) marks[pair.pairAddress] = { priceUsd: pair.priceUsd, freshness: pair.freshness };
    }
    for (const position of positions) {
      if (marks[position.pairAddress] || !d(position.baseQty.toString()).gt(0)) continue;
      const latest = await db.marketObservation.findFirst({
        where: { pairAddress: position.pairAddress },
        orderBy: { receivedAt: "desc" },
      });
      if (!latest) continue;
      const freshness = classifyFreshness({
        mode: this.dataMode,
        receivedAt: latest.receivedAt,
        now,
        liveMaxAgeMs: config.liveMaxAgeMs,
        delayedMaxAgeMs: config.delayedMaxAgeMs,
      });
      marks[position.pairAddress] = {
        priceUsd: latest.priceUsd ? latest.priceUsd.toString() : null,
        freshness,
      };
    }
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const realized = await db.ledgerEntry.aggregate({
      where: { accountId: "primary", type: "REALIZED_PNL", createdAt: { gte: dayStart } },
      _sum: { amountUsd: true },
    });
    const dayRealized = realized._sum.amountUsd?.toString() ?? "0";
    const positionViews = positions.map((position) => ({
      pairAddress: position.pairAddress,
      baseSymbol: position.baseSymbol,
      baseQty: position.baseQty.toString(),
      avgCostUsd: position.avgCostUsd.toString(),
      realizedPnlUsd: position.realizedPnlUsd.toString(),
    }));
    const valuation = valuePortfolio({ cashUsd: account.cashUsd.toString(), positions: positionViews, marks });
    const dailyPnlUsd =
      valuation.valuation !== "CASH_ONLY" && valuation.valuation !== "LIVE"
        ? null
        : valuation.unrealizedPnlUsd === null
          ? null
          : d(dayRealized).plus(d(valuation.unrealizedPnlUsd)).toFixed(8);
    const operator = parseOperator(cycle.operator);
    return {
      config,
      flattenRequested: engine.flattenRequested,
      plan: planCycle({
        cycleId,
        engineStatus: engine.status as PlanStatus,
        config,
        cashUsd: account.cashUsd.toString(),
        startingBalanceUsd: account.startingBalanceUsd.toString(),
        positions: positionViews,
        pairs,
        marks,
        dailyPnlUsd,
        flatten: engine.flattenRequested,
        operator,
      }),
    };
  }

  private async copyReplay(cycleId: string, config: StrategyConfig, now: Date): Promise<number> {
    const latest = await this.prisma.marketObservation.findMany({
      orderBy: { receivedAt: "desc" },
      take: 200,
    });
    const seen = new Set<string>();
    let count = 0;
    for (const row of latest) {
      if (seen.has(row.pairAddress) || seen.size >= config.universeLimit) continue;
      seen.add(row.pairAddress);
      await this.prisma.marketObservation.upsert({
        where: { ingestJobId_pairAddress: { ingestJobId: cycleId, pairAddress: row.pairAddress } },
        create: {
          ingestJobId: cycleId,
          source: row.source,
          chainId: row.chainId,
          pairAddress: row.pairAddress,
          dexId: row.dexId,
          url: row.url,
          baseAddress: row.baseAddress,
          baseSymbol: row.baseSymbol,
          baseName: row.baseName,
          quoteAddress: row.quoteAddress,
          quoteSymbol: row.quoteSymbol,
          priceUsd: row.priceUsd,
          liquidityUsd: row.liquidityUsd,
          volume24hUsd: row.volume24hUsd,
          volume5mUsd: row.volume5mUsd,
          priceChangeM5: row.priceChangeM5,
          priceChangeH1: row.priceChangeH1,
          priceChangeH24: row.priceChangeH24,
          txnsM5Buys: row.txnsM5Buys,
          txnsM5Sells: row.txnsM5Sells,
          freshness: "REPLAY",
          receivedAt: row.receivedAt,
          raw: row.raw as Prisma.InputJsonValue,
        },
        update: {},
      });
      count += 1;
    }
    void now;
    return count;
  }

  private async ready(cycleId: string, expected: string): Promise<boolean> {
    const cycle = await this.prisma.cycleRun.findUnique({ where: { id: cycleId } });
    if (!cycle || cycle.status !== "RUNNING") return false;
    return cycle.stage === expected;
  }

  private async advance(cycleId: string, stage: string): Promise<void> {
    await this.prisma.cycleRun.update({ where: { id: cycleId }, data: { stage } });
    await this.emit(cycleId, stage);
  }

  private async emit(cycleId: string, stage: string): Promise<void> {
    const payload = { type: "stage", cycleId, stage, at: this.now().toISOString() };
    await this.bus.publish(TERMINAL_CHANNEL, payload);
    await this.bus.publish(AGENT_BUS_CHANNEL, payload);
  }

  private async config(): Promise<StrategyConfig> {
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) throw new Error("ENGINE_MISSING");
    return parseStrategyConfig(engine.config);
  }
}

type PlanStatus = "STOPPED" | "RUNNING" | "PAUSED" | "EMERGENCY_STOP";

function parseOperator(value: unknown): OperatorOrder | null {
  if (value === null || value === undefined) return null;
  const parsed = operatorOrderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function emptyDecision(reason: DecisionDraft["reasonCodes"][number], error: string): DecisionDraft {
  return {
    agent: "SENTINEL",
    modelVersion: "sentinel-rules-1.0.0",
    pairAddress: "",
    decision: "REJECT",
    confidence: "0.000000",
    reasonCodes: [reason],
    input: {},
    output: { error },
  };
}

function observationData(cycleId: string, pair: NormalizedPair, freshness: DataState, receivedAt: Date) {
  return {
    ingestJobId: cycleId,
    source: pair.source,
    chainId: pair.chainId,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    url: pair.url,
    baseAddress: pair.baseAddress,
    baseSymbol: pair.baseSymbol,
    baseName: pair.baseName,
    quoteAddress: pair.quoteAddress,
    quoteSymbol: pair.quoteSymbol,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidityUsd,
    volume24hUsd: pair.volume24hUsd,
    volume5mUsd: pair.volume5mUsd,
    priceChangeM5: pair.priceChangeM5Pct,
    priceChangeH1: pair.priceChangeH1Pct,
    priceChangeH24: pair.priceChangeH24Pct,
    txnsM5Buys: pair.txnsM5Buys,
    txnsM5Sells: pair.txnsM5Sells,
    freshness,
    receivedAt,
    raw: toJson(pair.raw ?? {}),
  };
}

function toCyclePair(
  row: {
    id: string;
    source: string;
    pairAddress: string;
    dexId: string;
    url: string | null;
    baseAddress: string;
    baseSymbol: string;
    baseName: string;
    quoteAddress: string;
    quoteSymbol: string;
    priceUsd: { toString(): string } | null;
    liquidityUsd: { toString(): string } | null;
    volume24hUsd: { toString(): string } | null;
    volume5mUsd: { toString(): string } | null;
    priceChangeM5: { toString(): string } | null;
    priceChangeH1: { toString(): string } | null;
    priceChangeH24: { toString(): string } | null;
    txnsM5Buys: number | null;
    txnsM5Sells: number | null;
    receivedAt: Date;
  },
  now: Date,
  config: StrategyConfig,
  mode: DataMode,
): CyclePair {
  const source = row.source === "birdeye" || row.source === "replay" ? row.source : "dexscreener";
  return {
    source,
    chainId: "solana",
    pairAddress: row.pairAddress,
    dexId: row.dexId,
    url: row.url,
    baseAddress: row.baseAddress,
    baseSymbol: row.baseSymbol,
    baseName: row.baseName,
    quoteAddress: row.quoteAddress,
    quoteSymbol: row.quoteSymbol,
    priceUsd: row.priceUsd?.toString() ?? null,
    liquidityUsd: row.liquidityUsd?.toString() ?? null,
    volume24hUsd: row.volume24hUsd?.toString() ?? null,
    volume5mUsd: row.volume5mUsd?.toString() ?? null,
    priceChangeM5Pct: row.priceChangeM5?.toString() ?? null,
    priceChangeH1Pct: row.priceChangeH1?.toString() ?? null,
    priceChangeH24Pct: row.priceChangeH24?.toString() ?? null,
    txnsM5Buys: row.txnsM5Buys,
    txnsM5Sells: row.txnsM5Sells,
    observationId: row.id,
    freshness: classifyFreshness({
      mode,
      receivedAt: row.receivedAt,
      now,
      liveMaxAgeMs: config.liveMaxAgeMs,
      delayedMaxAgeMs: config.delayedMaxAgeMs,
    }),
    receivedAt: row.receivedAt.toISOString(),
  };
}

async function upsertDecision(
  db: PrismaClient | Prisma.TransactionClient,
  cycleId: string,
  decision: DecisionDraft,
): Promise<void> {
  await db.agentDecision.upsert({
    where: {
      cycleId_agent_pairAddress: { cycleId, agent: decision.agent, pairAddress: decision.pairAddress },
    },
    create: {
      cycleId,
      agent: decision.agent,
      modelVersion: decision.modelVersion,
      pairAddress: decision.pairAddress,
      decision: decision.decision,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      input: toJson(decision.input),
      output: toJson(decision.output),
    },
    update: {
      modelVersion: decision.modelVersion,
      decision: decision.decision,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      input: toJson(decision.input),
      output: toJson(decision.output),
    },
  });
}

export const liveFeed: MarketFeed = {
  fetchUniverse(limit) {
    return fetchSolanaUniverse({ limit });
  },
};
