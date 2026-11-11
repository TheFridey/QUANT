import { Injectable } from "@nestjs/common";
import {
  attributePnlByMarket,
  describePipeline,
  estimateRoundTripCost,
  evaluateReadiness,
  matchInstrumentKey,
  rankOpportunities,
  realisedVolatility,
  splitReadiness,
  summariseShadowEvidence,
  type InstrumentEvidence,
  type MarketPnl,
  type ScannerObservation,
  type ReadinessResult,
  type ReadinessSplit,
  type ShadowEvidenceRow,
  type StrategyAssignment,
  type VolatilityView,
  UNATTRIBUTED_MARKET,
} from "@odin/analytics";
import { instrumentResearch, type InstrumentResearch } from "@odin/evolution/campaign";
import { modelStates, parseShadowSpec, verifyStoredPrediction } from "@odin/evolution/genesis";
import { MarketDataGateway } from "@odin/market-data";
import {
  DEFAULT_STRATEGY,
  SEED_INSTRUMENTS,
  parseStrategyConfig,
  resolveExecutionContext,
  type Instrument,
  type StrategyConfig,
} from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";

/** Query bounds: every read below is capped; nothing here writes. */
export const OPPORTUNITY_BOUNDS = {
  volatilityPoints: 200,
  strategyInstances: 200,
  shadowRows: 5_000,
  realisedEntries: 5_000,
  positions: 500,
} as const;

export type MarketView = {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: Instrument["assetClass"];
  venue: Instrument["venue"];
  quoteCurrency: string;
  session: Instrument["session"];
  registryProviderId: Instrument["providerId"];
  executionCapabilities: Instrument["executionCapabilities"];
  enabled: boolean;
  notes: string | null;
  provider: { id: string | null; readiness: string; ingestActive: boolean; ingestReason: string | null };
  readiness: ReadinessResult;
  /** The same checks as `readiness`, split into "is there usable live data" and "is there an execution path". */
  readinessSplit: ReadinessSplit;
  /** Research warehouse history and campaign outcomes for this instrument. Empty results mean unknown, not zero. */
  research: InstrumentResearch;
  observedAt: string | null;
  volatility: VolatilityView;
  cost: ReturnType<typeof estimateRoundTripCost>;
  strategies: StrategyAssignment[];
  evidence: InstrumentEvidence | null;
  pnl: MarketPnl | null;
  correlationWithHoldings: number | null;
  correlationBasis: "SAME_MARKET_HELD" | "NOT_HELD_UNKNOWN";
};

/**
 * OPERATION HORIZON opportunity scanner (read only). Gathers bounded facts from the database and the
 * gateway's credential inventory (no network), then hands them to the pure scanner in @odin/analytics.
 */
@Injectable()
export class OpportunitiesService {
  constructor(private readonly prisma: PrismaClient) {}

  async opportunities(now = new Date()) {
    const { markets, unattributedPnl } = await this.markets(SEED_INSTRUMENTS, now);
    const leaderboard = rankOpportunities(
      markets.map((m) => ({
        instrumentId: m.id,
        symbol: m.symbol,
        assetClass: m.assetClass,
        readiness: m.readiness,
        evidence: m.evidence,
        cost: m.cost,
        correlationWithHoldings: m.correlationWithHoldings,
      })),
    );
    return { generatedAt: now.toISOString(), bounds: OPPORTUNITY_BOUNDS, markets, unattributedPnl, leaderboard };
  }

  async market(id: string, now = new Date()) {
    const instrument = SEED_INSTRUMENTS.find((i) => i.id === id);
    if (!instrument) return null;
    const { markets } = await this.markets([instrument], now);
    return { generatedAt: now.toISOString(), market: markets[0]! };
  }

  private async config(): Promise<StrategyConfig> {
    const row = await this.prisma.engineControl.findUnique({ where: { id: "primary" }, select: { config: true } });
    try {
      return parseStrategyConfig(row?.config);
    } catch {
      return DEFAULT_STRATEGY;
    }
  }

  private async markets(instruments: Instrument[], now: Date): Promise<{ markets: MarketView[]; unattributedPnl: MarketPnl | null }> {
    const config = await this.config();
    const env = config.tradingEnvironment;
    const gatewayReadiness = MarketDataGateway.fromEnv(process.env, () => now).readiness();
    const ctx = resolveExecutionContext({ config: { tradingEnvironment: env }, dataMode: dataMode() });
    const ids = instruments.map((i) => i.id);

    const [selections, instances, evidence, pnl, research] = await Promise.all([
      this.prisma.marketSelection.findMany({ where: { instrumentId: { in: ids } }, select: { instrumentId: true, enabled: true } }),
      this.prisma.strategyInstance.findMany({
        where: { instrumentIds: { hasSome: ids } },
        select: { id: true, name: true, status: true, moduleRef: true, instrumentIds: true },
        orderBy: { id: "asc" },
        take: OPPORTUNITY_BOUNDS.strategyInstances,
      }),
      this.evidence(),
      this.pnl(ctx.accountId),
      instrumentResearch(this.prisma, instruments.map((i) => ({ id: i.id, aliases: [i.id, i.symbol, i.providerSymbol] })), now),
    ]);
    const enabled = new Map(selections.map((s) => [s.instrumentId, s.enabled]));
    const fee = Number(config.feeBps);
    const spreadEstimate = Number(config.spreadBpsEstimate);

    const out: MarketView[] = [];
    for (const instrument of instruments) {
      const pipeline = describePipeline(instrument, {
        gatewayReadiness,
        config: { tradingEnvironment: env, marketDataPaperFxIngest: config.marketDataPaperFxIngest },
      });
      const { observation, observedAt, volatility } = await this.observation(instrument, env);
      const strategies = instances
        .filter((s) => s.instrumentIds.includes(instrument.id))
        .map((s) => ({ id: s.id, name: s.name, status: s.status, moduleRef: s.moduleRef }));
      const readiness = evaluateReadiness({
        instrument,
        enabled: enabled.get(instrument.id) ?? instrument.enabledByDefault,
        pipeline,
        observation,
        strategies,
        now,
        liveMaxAgeMs: config.liveMaxAgeMs,
      });
      const marketPnl = pnl.get(instrument.id) ?? null;
      const held = (marketPnl?.openPositions ?? 0) > 0;
      out.push({
        id: instrument.id,
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        assetClass: instrument.assetClass,
        venue: instrument.venue,
        quoteCurrency: instrument.quote,
        session: instrument.session,
        registryProviderId: instrument.providerId,
        executionCapabilities: instrument.executionCapabilities,
        enabled: enabled.get(instrument.id) ?? instrument.enabledByDefault,
        notes: instrument.notes ?? null,
        provider: { id: pipeline.providerId, readiness: pipeline.providerReadiness, ingestActive: pipeline.ingest.active, ingestReason: pipeline.ingest.reason },
        readiness,
        readinessSplit: splitReadiness(readiness),
        research: research.get(instrument.id)!,
        observedAt,
        volatility,
        cost: estimateRoundTripCost({ feeBps: fee, observedSpreadBps: readiness.quote.spreadBps, spreadBpsEstimate: spreadEstimate, slippageBps: spreadEstimate }),
        strategies,
        evidence: evidence.get(instrument.id) ?? null,
        pnl: marketPnl,
        // Only the certain case is used: a market already held is perfectly correlated with that holding.
        correlationWithHoldings: held ? 1 : null,
        correlationBasis: held ? "SAME_MARKET_HELD" : "NOT_HELD_UNKNOWN",
      });
    }
    return { markets: out, unattributedPnl: pnl.get(UNATTRIBUTED_MARKET) ?? null };
  }

  private async observation(instrument: Instrument, env: string): Promise<{ observation: ScannerObservation | null; observedAt: string | null; volatility: VolatilityView }> {
    const solana = instrument.venue === "SOLANA_DEX";
    const where = solana ? { chainId: "solana", tradingEnvironment: env } : { pairAddress: instrument.id, tradingEnvironment: env };
    const latest = await this.prisma.marketObservation.findFirst({
      where,
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true, eventTime: true, priceUsd: true, liquidityUsd: true, volume24hUsd: true, freshness: true, dataOrigin: true, raw: true },
    });
    // The Solana universe mixes pools, so a single price series would be meaningless.
    const series = solana || !latest
      ? []
      : await this.prisma.marketObservation.findMany({
          where,
          orderBy: { receivedAt: "desc" },
          select: { receivedAt: true, priceUsd: true },
          take: OPPORTUNITY_BOUNDS.volatilityPoints,
        });
    const volatility = realisedVolatility(
      series.filter((p) => p.priceUsd !== null).map((p) => ({ t: p.receivedAt.getTime(), price: Number(p.priceUsd) })),
    );
    if (!latest) return { observation: null, observedAt: null, volatility };
    const raw = (latest.raw ?? {}) as Record<string, unknown>;
    const num = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);
    const dataState = typeof raw.dataState === "string" ? raw.dataState : latest.freshness;
    return {
      observation: {
        receivedAt: latest.receivedAt,
        eventTime: latest.eventTime,
        price: num(latest.priceUsd?.toString()),
        bid: num(raw.bid),
        ask: num(raw.ask),
        dataState,
        dataOrigin: latest.dataOrigin,
        liquidityUsd: num(latest.liquidityUsd?.toString()),
        volume24hUsd: num(latest.volume24hUsd?.toString()),
      },
      observedAt: latest.receivedAt.toISOString(),
      volatility,
    };
  }

  /** Resolved hypothetical shadow outcomes mapped to registry instruments (newest first, bounded). */
  private async evidence(): Promise<Map<string, InstrumentEvidence>> {
    const rows = await this.prisma.shadowPrediction.findMany({
      where: { status: "PREDICTED", outcome: { is: { hypotheticalFillAvailable: true } } },
      include: { outcome: true },
      orderBy: { decisionTime: "desc" },
      take: OPPORTUNITY_BOUNDS.shadowRows,
    });
    if (!rows.length) return new Map();
    const modelIds = [...new Set(rows.map((r) => r.modelVersionId))];
    const [models, states] = await Promise.all([
      this.prisma.modelVersion.findMany({ where: { id: { in: modelIds } }, select: { id: true, family: true, version: true, trainingProtocol: true } }),
      modelStates(this.prisma, modelIds),
    ]);
    const modelById = new Map(models.map((m) => [m.id, m]));
    const evidenceRows: ShadowEvidenceRow[] = [];
    for (const row of rows) {
      const instrumentId = matchInstrumentKey(row.instrumentKey, SEED_INSTRUMENTS);
      const model = modelById.get(row.modelVersionId);
      const net = row.outcome?.realisedNetReturn;
      if (!instrumentId || !model || net === null || net === undefined) continue;
      const verified = verifyStoredPrediction(row);
      if (!verified || verified.probability === null) continue; // hash mismatch or no probability: not evidence
      let entryThreshold: number;
      try {
        entryThreshold = parseShadowSpec(model).entryThreshold;
      } catch {
        continue;
      }
      evidenceRows.push({
        instrumentId,
        modelVersionId: model.id,
        family: model.family,
        version: model.version,
        state: states.get(model.id)?.state ?? "UNKNOWN",
        probability: verified.probability,
        entryThreshold,
        realisedNet: net,
        costBpsApplied: row.outcome!.costBpsApplied,
        horizonBars: row.horizonBars,
      });
    }
    return summariseShadowEvidence(evidenceRows);
  }

  /** Realised P&L by market from the ledger (latest N entries) and open positions at cost. */
  private async pnl(accountId: string): Promise<Map<string, MarketPnl>> {
    const [entries, positions] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { accountId, type: "REALIZED_PNL" },
        orderBy: { createdAt: "desc" },
        select: { amountUsd: true, orderId: true },
        take: OPPORTUNITY_BOUNDS.realisedEntries,
      }),
      this.prisma.position.findMany({
        where: { accountId },
        select: { pairAddress: true, baseQty: true, avgCostUsd: true },
        orderBy: { pairAddress: "asc" },
        take: OPPORTUNITY_BOUNDS.positions,
      }),
    ]);
    const orderIds = [...new Set(entries.map((e) => e.orderId).filter((id): id is string => id !== null))];
    const orders = orderIds.length
      ? await this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, instrumentId: true, pairAddress: true } })
      : [];
    const byOrder = new Map(orders.map((o) => [o.id, o]));
    return attributePnlByMarket({
      instruments: SEED_INSTRUMENTS,
      realised: entries.map((e) => {
        const order = e.orderId ? byOrder.get(e.orderId) : undefined;
        return { amountUsd: e.amountUsd.toString(), instrumentId: order?.instrumentId ?? null, pairAddress: order?.pairAddress ?? null };
      }),
      positions: positions.map((p) => ({ pairAddress: p.pairAddress, baseQty: p.baseQty.toString(), avgCostUsd: p.avgCostUsd.toString() })),
    });
  }
}

function dataMode(): "live" | "replay" | "demo" {
  return process.env.DATA_MODE === "replay" || process.env.DATA_MODE === "demo" ? process.env.DATA_MODE : "live";
}
