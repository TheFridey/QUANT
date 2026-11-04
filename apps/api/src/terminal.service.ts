import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import {
  alertAckDoesNotClearSafety,
  parseActiveStrategyIdentity,
  sortAlertsForOps,
  summarizeFunnel,
  type FunnelStage,
} from "@odin/agent-core";
import {
  attributeNetPerformance,
  autopsyRoundTrip,
  closedRoundTrips,
  drawdownBelowHwmPct,
  performanceReport,
  SNAPSHOT_BOUNDS,
  summariseAutopsies,
  summarizeSnapshotCost,
  valuePortfolio,
  type AutopsyFill,
  type Mark,
  type SnapshotQueryPhase,
} from "@odin/analytics";
import { costForecastReport, forecastRecordFromAutopsy } from "@odin/backtest";
import { BirdeyeClient } from "@odin/market-data";
import {
  inventoryAlpacaCredentials,
  inventoryOandaCredentials,
  AlpacaPaperProvider,
  OandaPracticeProvider,
} from "@odin/market-data";
import { evaluateCircuitBreaker, evaluateRiskHierarchy } from "@odin/risk-engine";
import {
  QUEUES,
  REASON_TEXT,
  assertPaperOrSandboxOnly,
  buildPositionKey,
  classifyFreshness,
  classifyReasonCodes,
  d,
  derivePositionProtectionCoverage,
  emergencyStopSchema,
  entriesSuspendedFromSafety,
  findInstrument,
  freshnessFromProvenance,
  inferObservationProvenance,
  instrumentIdFromPositionKey,
  isReasonCode,
  DEFAULT_STRATEGY,
  newId,
  operatorOrderSchema,
  productSemanticsFor,
  resolveExecutionContext,
  startOfLondonDay,
  stageJobId,
  parseStrategyConfig,
  isOperationalStrategyKey,
  strategyPatchHasNonOperationalKeys,
  strategyPatchOnlyOperational,
  strategyPatchSchema,
  usd,
  evaluateSession,
  type DataState,
  type EngineAction,
  type StrategyConfig,
} from "@odin/shared";
import { PrismaClient, toJson } from "@odin/shared/db";
import { HistoricalDrawdownCache, queryHistoricalDrawdown } from "./historical-drawdown.js";
import { resetPaperBalance } from "./paper-balance.js";
import {
  allowedActions,
  compareDesiredVsConfirmed,
  loadActiveSafetyStates,
  transition,
} from "@odin/trading-engine";
import { Queue } from "bullmq";

@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaClient,
    @InjectQueue(QUEUES.ingest) private readonly ingest: Queue,
  ) {}

  /** All-history drawdown, cached per account for 30 s so dashboard polling does not rescan. */
  private readonly historicalDrawdownCache = new HistoricalDrawdownCache((accountId) =>
    queryHistoricalDrawdown(this.prisma, accountId),
  );

  /** Ping Redis over the ingest queue's existing client; no new connection per snapshot. */
  private async queueRedisUp(): Promise<boolean> {
    try {
      const client = await Promise.race([
        this.ingest.client,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("REDIS_TIMEOUT")), 1_000)),
      ]);
      const reply = await Promise.race([
        (client as unknown as { ping(): Promise<string> }).ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("REDIS_TIMEOUT")), 1_000)),
      ]);
      return reply === "PONG";
    } catch {
      return false;
    }
  }

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
    const costPhases: SnapshotQueryPhase[] = [];
    const timed = async <T>(name: string, bounded: boolean, run: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      const value = await run();
      const rows = Array.isArray(value) ? value.length : undefined;
      costPhases.push({ name, elapsedMs: Date.now() - started, rows, bounded });
      return value;
    };
    const engineRow = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const configEarly = this.readConfig(engineRow?.config);
    const tradingEnvironment = configEarly?.tradingEnvironment ?? "MARKET_DATA_PAPER";
    const ctx = resolveExecutionContext({
      config: { tradingEnvironment },
      dataMode: this.mode(),
    });
    const metricsAccountId = ctx.metricsAccountId;
    // R03: no cross-environment fallback — missing env account is an error, not silent primary bleed.
    const account = await this.prisma.paperAccount.findUnique({ where: { id: ctx.accountId } });
    if (!engineRow || !account) {
      throw new NotFoundException(
        `Paper account is not initialised for ${tradingEnvironment} (${ctx.accountId})`,
      );
    }
    const config = configEarly;
    // D21: exact tradingEnvironment match only — null env is never compatible.
    const latestBatch = await this.prisma.cycleRun.findFirst({
      where: {
        observationCount: { gt: 0 },
        tradingEnvironment: ctx.tradingEnvironment,
      },
      orderBy: { startedAt: "desc" },
    });
    const observations = latestBatch
      ? await this.prisma.marketObservation.findMany({
          where: {
            ingestJobId: latestBatch.id,
            tradingEnvironment: ctx.tradingEnvironment,
          },
          orderBy: { liquidityUsd: "desc" },
        })
      : [];
    const latest = new Map(observations.map((row) => [row.pairAddress, row]));
    const pairs = [...latest.values()]
      .map((row) => this.presentPair(row, now, config))
      .sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0))
      .slice(0, config?.universeLimit ?? 12);
    const positions = await this.prisma.position.findMany({ where: { accountId: account.id } });
    const marks: Record<string, Mark | undefined> = {};
    for (const position of positions) {
      const row =
        latest.get(position.pairAddress) ??
        (await this.prisma.marketObservation.findFirst({
          where: {
            pairAddress: position.pairAddress,
            tradingEnvironment: ctx.tradingEnvironment,
          },
          orderBy: { receivedAt: "desc" },
        }));
      if (!row || !config) continue;
      marks[position.pairAddress] = {
        priceUsd: row.priceUsd?.toString() ?? null,
        freshness: this.freshnessForObservation(row, now, config),
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
      where: { accountId: account.id, type: "FEE" },
      _sum: { amountUsd: true },
    });
    const closedTradeLimit = SNAPSHOT_BOUNDS.closedTrades;
    const funnelEventLimit = SNAPSHOT_BOUNDS.funnelEvents;
    const closed = await timed("closed_trades", true, () =>
      this.prisma.ledgerEntry.findMany({
        where: { accountId: account.id, type: "REALIZED_PNL" },
        orderBy: { createdAt: "desc" },
        take: closedTradeLimit, // analyticsWindows.closedTrades — latest N, not calendar ALL
      }),
    );
    // Max drawdown is measured over ALL equity snapshots in PostgreSQL (single-pass
    // window-function query, cached per account for 30 s). The former earliest-500
    // sample missed every later drawdown and reported 0.00% on a long-running account.
    const historicalDrawdown = await timed("historical_drawdown", true, () =>
      this.historicalDrawdownCache.get(metricsAccountId),
    );
    const report = performanceReport({
      valuation,
      startingBalanceUsd: account.startingBalanceUsd.toString(),
      feesUsd: usd(d(fees._sum.amountUsd?.toString() ?? "0").abs()),
      closedTradePnlUsd: closed.map((entry) => entry.amountUsd.toString()),
    });
    const asOf = now.toISOString();
    const valuationSource = "live valuation: PaperAccount.cashUsd + open positions at latest marks (null when any mark is missing)";
    const analyticsWindows = {
      closedTrades: {
        label: `latest_${closedTradeLimit}_realized_pnl_ledger`,
        metrics: ["winRate", "wins", "losses", "closedTrades", "sampleSize", "avgWinUsd", "avgLossUsd", "profitFactor", "expectancyUsd", "largestGainUsd", "largestLossUsd", "tradeDistribution"],
        range: "SAMPLE_LATEST" as const,
        limit: closedTradeLimit,
        sampleSize: closed.length,
        from: closed[closed.length - 1]?.createdAt.toISOString() ?? null,
        to: closed[0]?.createdAt.toISOString() ?? null,
        source: `LedgerEntry type=REALIZED_PNL, account ${account.id}`,
        method: `win/loss counts and sums over the latest ${closedTradeLimit} realised P&L entries (not all-time)`,
      },
      fees: {
        label: "all_time_fee_ledger_sum",
        metrics: ["feesUsd"],
        range: "ALL" as const,
        limit: null,
        sampleSize: null,
        source: `LedgerEntry type=FEE, account ${account.id}`,
        method: "abs(sum(amountUsd)) over every fee entry",
      },
      historicalDrawdown: {
        label: "all_equity_snapshots_running_peak",
        metrics: ["historicalMaxDrawdownPct", "maxDrawdownPct"],
        range: historicalDrawdown.range,
        limit: null,
        sampleSize: historicalDrawdown.sampleCount,
        from: historicalDrawdown.firstAt,
        to: historicalDrawdown.lastAt,
        source: `${historicalDrawdown.source}, account ${metricsAccountId}`,
        method: `${historicalDrawdown.method}: max((running_peak - equity) / running_peak * 100), running_peak = max(equity) over (order by createdAt) — computed in PostgreSQL`,
        peakEquityUsd: historicalDrawdown.peakEquityUsd,
        peakAt: historicalDrawdown.peakAt,
        troughEquityUsd: historicalDrawdown.troughEquityUsd,
        troughAt: historicalDrawdown.troughAt,
      },
      currentDrawdown: {
        label: "current_equity_vs_account_hwm",
        metrics: ["currentDrawdownPct"],
        range: "POINT_IN_TIME" as const,
        limit: null,
        sampleSize: 1,
        asOf,
        source: `PaperAccount.highWaterMarkUsd (account ${account.id}) vs ${valuationSource}`,
        method: "(highWaterMarkUsd - equity) / highWaterMarkUsd * 100",
      },
      returnPct: {
        label: "equity_vs_starting_balance",
        metrics: ["returnPct"],
        range: "SINCE_START" as const,
        limit: null,
        sampleSize: 1,
        asOf,
        source: `PaperAccount.startingBalanceUsd (account ${account.id}) vs ${valuationSource}`,
        method: "(equity - startingBalanceUsd) / startingBalanceUsd * 100",
      },
      dayPnl: {
        label: "equity_vs_session_start",
        metrics: ["dayPnlUsd"],
        range: "SESSION" as const,
        limit: null,
        sampleSize: 1,
        from: account.sessionStartedAt?.toISOString() ?? null,
        to: asOf,
        source: `PaperAccount.sessionStartEquityUsd (account ${account.id}) vs ${valuationSource}`,
        method: "equity - sessionStartEquityUsd",
      },
      slippage: {
        label: "latest_500_fills_all_accounts",
        metrics: ["avgSlippageBps", "totalSlippageUsd", "fillCount"],
        range: "SAMPLE_LATEST" as const,
        limit: 500,
        sampleSize: null as number | null,
        source: "Fill (not account-scoped)",
        method: "mean(slippageBps); sum(notionalUsd * slippageBps / 10000)",
      },
      funnel: {
        label: `latest_${funnelEventLimit}_funnel_events`,
        metrics: ["funnel.summary"],
        range: "SAMPLE_LATEST" as const,
        limit: funnelEventLimit,
        sampleSize: null as number | null,
        source: `OpportunityFunnelEvent, account ${metricsAccountId}`,
        method: "stage counts over the latest events",
      },
      note: "Each portfolio metric names its own window above (range, sampleSize, source, method). maxDrawdownPct and historicalMaxDrawdownPct cover ALL equity snapshots; currentDrawdownPct is a point-in-time measure of live equity against the account high-water mark; returnPct compares live equity with the starting balance; closed-trade statistics use only the latest realised P&L sample; slippage uses the latest fills across all accounts. Use equityHistory(range) for explicit 1H/24H/7D/30D/ALL charts.",
    };
    const cycle = await this.prisma.cycleRun.findFirst({ orderBy: { startedAt: "desc" } });
    const decisions = cycle
      ? await timed("cycle_decisions", true, () =>
          this.prisma.agentDecision.findMany({
            where: { cycleId: cycle.id },
            orderBy: { createdAt: "asc" },
            take: SNAPSHOT_BOUNDS.cycleDecisions,
          }),
        )
      : [];
    const recentAgentDecisions = await timed("recent_agent_decisions", true, () =>
      this.prisma.agentDecision.findMany({
        orderBy: { createdAt: "desc" },
        take: SNAPSHOT_BOUNDS.recentAgentDecisions,
      }),
    );
    const orders = await timed("recent_orders", true, () =>
      this.prisma.order.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: "desc" },
        take: SNAPSHOT_BOUNDS.recentOrders,
        include: { fills: true },
      }),
    );
    // D29: scoped counts (account) instead of global table scans.
    const [orderTotal, fillTotal] = await timed("order_fill_counts", true, () =>
      Promise.all([
        this.prisma.order.count({ where: { accountId: account.id } }),
        this.prisma.fill.count({ where: { order: { accountId: account.id } } }),
      ]),
    );
    const fillStats = await this.fillsStats();
    const closedPnls = closed.map((entry) => entry.amountUsd.toString());
    const largestGainUsd = closedPnls.length === 0 ? null : usd(closedPnls.reduce((best, value) => (d(value).gt(best) ? d(value) : best), d(closedPnls[0]!)));
    const largestLossUsd = closedPnls.length === 0 ? null : usd(closedPnls.reduce((worst, value) => (d(value).lt(worst) ? d(value) : worst), d(closedPnls[0]!)));
    const tradeDistribution = {
      wins: report.wins,
      losses: report.losses,
      breakeven: report.breakeven,
    };
    const openedAtByPair = await this.positionOpenedAt(
      account.id,
      positions.map((position) => ({
        pairAddress: position.pairAddress,
        lifecycleId: position.lifecycleId,
      })),
    );
    const stopLossPct = config?.stopLossPct ?? null;
    const takeProfitPct = config?.takeProfitPct ?? null;
    const exposureUsd =
      report.valuation.equityUsd === null
        ? null
        : usd(d(report.valuation.equityUsd).minus(d(account.cashUsd.toString())));
    const drawdownPct = drawdownBelowHwmPct(report.valuation.equityUsd, account.highWaterMarkUsd?.toString() ?? null);
    const states = pairs.map((pair) => pair.freshness);
    const activeStrategy = parseActiveStrategyIdentity(engineRow.activeStrategy);
    const liveGate = assertPaperOrSandboxOnly(process.env);
    const executionMode = !liveGate.ok ? "REFUSED" : liveGate.mode === "SANDBOX" ? "SANDBOX" : "PAPER";
    const funnelRows = await timed("funnel_events", true, () =>
      this.prisma.opportunityFunnelEvent.findMany({
        where: { accountId: metricsAccountId },
        orderBy: { createdAt: "desc" },
        take: funnelEventLimit,
      }),
    );
    analyticsWindows.funnel.sampleSize = funnelRows.length;
    analyticsWindows.slippage.sampleSize = fillStats.fillCount;
    const funnelSummary = summarizeFunnel(
      funnelRows.map((row) => ({
        cycleId: row.cycleId,
        pairAddress: row.pairAddress,
        instrumentId: row.instrumentId,
        stage: row.stage as FunnelStage,
        reasonCodes: row.reasonCodes,
        at: row.createdAt.toISOString(),
      })),
    );
    const alertsRaw = await this.prisma.durableAlert.findMany({
      where: {
        acked: false,
        OR: [{ accountId: account.id }, { accountId: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    const alertsSorted = sortAlertsForOps(
      alertsRaw.map((alert) => ({
        ...alert,
        createdAt: alert.createdAt,
      })),
    );
    // R12: paginate all account protection rows — never truncate active ARMED coverage with take:100.
    const protections: Awaited<ReturnType<typeof this.prisma.protectionOrder.findMany>> = [];
    {
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.prisma.protectionOrder.findMany({
          where: {
            accountId: account.id,
            status: { in: ["ARMED", "TRIGGERED", "SUBMITTED", "CONFIRMED", "FAILED"] },
          },
          orderBy: { id: "asc" },
          take: 200,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        protections.push(...batch);
        if (batch.length < 200) break;
        cursor = batch[batch.length - 1]!.id;
      }
    }
    const unresolvedIntents = await this.prisma.protectionIntent.findMany({
      where: { accountId: account.id, status: "UNRESOLVED" },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    const unresolvedProtection = unresolvedIntents.length;
    // R06: suspension from AccountSafetyState — ACK of DurableAlert never clears this.
    const safetyStates = await loadActiveSafetyStates(this.prisma, account.id);
    const entriesSuspendedFlag = entriesSuspendedFromSafety(safetyStates);
    const alpacaCreds = inventoryAlpacaCredentials();
    const oandaCreds = inventoryOandaCredentials();
    const providerReadiness = {
      alpaca_paper: new AlpacaPaperProvider(alpacaCreds).readiness(),
      oanda_practice: new OandaPracticeProvider(oandaCreds).readiness(),
    };
    const breaker = evaluateCircuitBreaker({
      dailyPnlUsd: account.sessionStartEquityUsd
        ? report.valuation.equityUsd === null
          ? null
          : usd(d(report.valuation.equityUsd).minus(d(account.sessionStartEquityUsd.toString())))
        : report.valuation.realizedPnlUsd,
      startingBalanceUsd: account.startingBalanceUsd.toString(),
      dayStartEquityUsd: account.sessionStartEquityUsd?.toString() ?? null,
      // ASCEND-00 F1: show the same-day latch the worker applies (only while the stored session is today).
      worstDailyPnlUsd:
        account.sessionLowEquityUsd &&
        account.sessionStartEquityUsd &&
        account.sessionStartedAt &&
        startOfLondonDay(account.sessionStartedAt).getTime() === startOfLondonDay(new Date()).getTime()
          ? usd(d(account.sessionLowEquityUsd.toString()).minus(d(account.sessionStartEquityUsd.toString())))
          : null,
      maxDailyLossPct: config?.maxDailyLossPct ?? "3",
      equityUsd: report.valuation.equityUsd,
      highWaterMarkUsd: account.highWaterMarkUsd?.toString() ?? null,
      maxTotalDrawdownPct: config?.maxTotalDrawdownPct ?? "10",
    });
    const riskHierarchy = evaluateRiskHierarchy({
      engineStatus: engineRow.status,
      circuitBreakerOpen: breaker.open,
      circuitBreakerReasons: breaker.reasonCodes,
      entriesSuspended: entriesSuspendedFlag,
      pauseNewEntries: config?.pauseNewEntries === true,
      flattenIncomplete: engineRow.flattenRequested === true && positions.some((p) => d(p.baseQty.toString()).gt(0)),
    });
    const closedOrderIds = closed.map((entry) => entry.orderId).filter((id): id is string => Boolean(id));
    const closedOrders =
      closedOrderIds.length === 0
        ? []
        : await this.prisma.order.findMany({
            where: { id: { in: closedOrderIds } },
            select: { id: true, strategyVersion: true, instrumentId: true, pairAddress: true },
          });
    const orderAttr = new Map(closedOrders.map((order) => [order.id, order]));
    const attributionFills = closed.map((entry) => {
      const order = entry.orderId ? orderAttr.get(entry.orderId) : undefined;
      return {
        strategyInstanceId: order?.strategyVersion ?? null,
        realizedPnlUsd: entry.amountUsd.toString(),
        feeUsd: "0",
        instrumentId: order?.instrumentId ?? order?.pairAddress ?? null,
      };
    });
    const instanceAttribution = attributeNetPerformance(attributionFills);
    const whyBlocked = decisions
      .filter((decision) => decision.decision === "REJECT" || decision.reasonCodes.some((code) => /BLOCK|REJECT|PAUSE|SUSPEND|BREAKER|STALE|DEMO|UNKNOWN/.test(code)))
      .slice(0, 24)
      .map((decision) => {
        const classified = classifyReasonCodes(decision.reasonCodes);
        return {
          agent: decision.agent,
          pairAddress: decision.pairAddress,
          decision: decision.decision,
          reasonCodes: decision.reasonCodes,
          reasonText: decision.reasonCodes.map((code) => (isReasonCode(code) ? REASON_TEXT[code] : code)),
          hardBlocks: classified.hardBlocks,
          advisories: classified.advisories,
          createdAt: decision.createdAt.toISOString(),
        };
      });
    const observabilityRows = await timed("observability", true, () =>
      this.prisma.observabilityEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: SNAPSHOT_BOUNDS.observability,
      }),
    );
    const strategyInstances = await timed("strategy_instances", true, () =>
      this.prisma.strategyInstance.findMany({
        where: { accountId: account.id },
        orderBy: { updatedAt: "desc" },
        take: SNAPSHOT_BOUNDS.strategyInstances,
      }),
    );
    const snapshotCost = summarizeSnapshotCost(costPhases);
    const familyCounts = new Map<string, number>();
    for (const row of whyBlocked) {
      for (const code of row.reasonCodes) {
        const family =
          code === "NO_EDGE"
            ? "NO_EDGE"
            : code === "NO_INTENT" || code === "STRATEGY_INSTANCE_GATING"
              ? "NO_INTENT"
              : code === "BUDGET_EXHAUSTED"
                ? "BUDGET_EXHAUSTED"
                : code === "MARKET_ENTRY_DISABLED"
                  ? "MARKET_ENTRY_DISABLED"
                  : code === "ENTRIES_SUSPENDED" || code === "PAUSE_NEW_ENTRIES"
                    ? "ENTRIES_SUSPENDED"
                    : code === "PROTECTION_UNRESOLVED" || code === "PROTECTION_RECOVERY"
                      ? "PROTECTION_RECOVERY"
                      : code === "MISSING_CREDENTIALS" || code === "BLOCKED_EXTERNAL"
                        ? "BLOCKED_EXTERNAL"
                        : code === "ENGINE_HALTED"
                          ? "ENGINE_NOT_RUNNING"
                          : null;
        if (family) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
      }
    }
    const whyNoTrades = {
      ordered: funnelSummary.ORDERED ?? 0,
      filled: funnelSummary.FILLED ?? 0,
      rejected: funnelSummary.REJECTED ?? 0,
      dropped: funnelSummary.DROPPED ?? 0,
      families: [...familyCounts.entries()].map(([family, count]) => ({ family, count })),
      decisiveBlocks: whyBlocked.slice(0, 8).map((row) => ({
        agent: row.agent,
        pairAddress: row.pairAddress,
        reasonCodes: row.reasonCodes,
      })),
      note:
        (funnelSummary.FILLED ?? 0) === 0
          ? "Zero fills in latest funnel sample — distinguish quiet NO_EDGE from gating/budget/safety; not a trade quota miss."
          : "Fills present in latest funnel sample.",
    };
    return {
      serverTime: now.toISOString(),
      venue: "PAPER",
      snapshotCost,
      whyNoTrades,
      execution: {
        mode: executionMode,
        // UI bug 2: this is "the execution gate passed" (PAPER or SANDBOX), never "live trading allowed".
        executionGateOk: liveGate.ok,
        liveEnabled: false,
        refuseReason: liveGate.ok ? null : liveGate.reason,
        pauseNewEntries: config?.pauseNewEntries === true,
        allowDemoPaperEntries: config?.allowDemoPaperEntries === true,
        multiMarketPaperIngest: config?.multiMarketPaperIngest === true,
        tradingEnvironment: tradingEnvironment,
        fixtureMode: tradingEnvironment === "FIXTURE",
        replayMode: tradingEnvironment === "REPLAY",
        metricsAccountId,
        unresolvedProtection,
        unresolvedActions: unresolvedIntents.map((intent) => ({
          id: intent.id,
          ocoGroupId: intent.ocoGroupId,
          legId: intent.legId,
          reason: intent.reason,
          attempts: intent.attempts,
          retryAfter: intent.retryAfter?.toISOString() ?? null,
        })),
        providerReadiness,
        entriesSuspended: entriesSuspendedFlag,
        circuitBreakerOpen: breaker.open,
        circuitBreakerReasons: breaker.reasonCodes,
        riskDominantHard: riskHierarchy.dominantHard?.kind ?? null,
        riskBlocksNewEntries: riskHierarchy.blocksNewEntries,
      },
      riskDiagnostics: {
        hierarchy: riskHierarchy.controls.map((control) => ({
          kind: control.kind,
          rank: control.rank,
          hard: control.hard,
          reasonCodes: control.reasonCodes,
          detail: control.detail ?? null,
        })),
        dominantHard: riskHierarchy.dominantHard?.kind ?? null,
        blocksNewEntries: riskHierarchy.blocksNewEntries,
        circuitBreakerOpen: breaker.open,
        circuitBreakerReasons: breaker.reasonCodes,
        ackDoesNotClear: riskHierarchy.ackDoesNotClear,
        unresolvedProtection,
        providerReadiness,
      },
      instanceAttribution: {
        portfolioNetPnlUsd: instanceAttribution.portfolioNetPnlUsd,
        portfolioFeesUsd: instanceAttribution.portfolioFeesUsd,
        sampleSize: instanceAttribution.sampleSize,
        instances: instanceAttribution.instances.slice(0, 12),
        unattributedTrades: instanceAttribution.unattributed.trades,
      },
      activeStrategy,
      funnel: {
        summary: funnelSummary,
        recent: funnelRows.slice(0, 40).map((row) => ({
          id: row.id,
          cycleId: row.cycleId,
          pairAddress: row.pairAddress,
          instrumentId: row.instrumentId,
          stage: row.stage,
          reasonCodes: row.reasonCodes,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      alerts: alertsSorted.map((alert) => ({
        id: alert.id,
        severity: alert.severity,
        code: alert.code,
        message: alert.message,
        acked: alert.acked,
        createdAt: alert.createdAt.toISOString(),
        accountId: alert.accountId,
        scope: alertScope(alert.accountId, alert.payload),
        ackClearsSafety: !alertAckDoesNotClearSafety(alert.code),
      })),
      whyBlocked,
      observability: {
        recent: observabilityRows.map((row) => ({
          id: row.id,
          category: row.category,
          name: row.name,
          value: row.value?.toString() ?? null,
          unit: row.unit,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      engine: {
        status: engineRow.status,
        flattenRequested: engineRow.flattenRequested,
        config,
        configValid: config !== null,
        allowedActions: allowedActions(engineRow.status as "STOPPED"),
        updatedAt: engineRow.updatedAt.toISOString(),
      },
      opsControls: {
        engineStatus: engineRow.status,
        allowedActions: allowedActions(engineRow.status as "STOPPED"),
        flattenRequested: engineRow.flattenRequested,
        pauseNewEntries: config?.pauseNewEntries === true,
        allowDemoPaperEntries: config?.allowDemoPaperEntries === true,
        multiMarketPaperIngest: config?.multiMarketPaperIngest === true,
        entriesSuspended: entriesSuspendedFlag,
        unresolvedProtection,
        unresolvedActions: unresolvedIntents.map((intent) => ({
          id: intent.id,
          ocoGroupId: intent.ocoGroupId,
          legId: intent.legId,
          reason: intent.reason,
          attempts: intent.attempts,
          retryAfter: intent.retryAfter?.toISOString() ?? null,
        })),
        circuitBreakerOpen: breaker.open,
        riskDominantHard: riskHierarchy.dominantHard?.kind ?? null,
        providerReadiness,
        note: "Alert ACK does not clear suspension, breaker, or unresolved protection intents",
      },
      strategyInstances: strategyInstances.map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        status: row.status,
        health: row.health,
        instrumentIds: row.instrumentIds,
        budgetUsd: row.budgetUsd.toString(),
        timeframe: row.timeframe,
        artifactHash: row.artifactHash,
        updatedAt: row.updatedAt.toISOString(),
      })),
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
        /** Compatibility alias of historicalMaxDrawdownPct (ALL snapshots; see analyticsWindows.historicalDrawdown). */
        maxDrawdownPct: historicalDrawdown.maxDrawdownPct,
        historicalMaxDrawdownPct: historicalDrawdown.maxDrawdownPct,
        historicalDrawdown,
        sampleSize: report.sampleSize,
        observed: report.observed,
        analyticsWindows,
        highWaterMarkUsd: account.highWaterMarkUsd?.toString() ?? null,
        availableFundsUsd: account.cashUsd.toString(),
        exposureUsd,
        // UI item 5: lead the Overview with day P&L and open risk against its cap.
        dayPnlUsd:
          account.sessionStartEquityUsd && report.valuation.equityUsd !== null
            ? usd(d(report.valuation.equityUsd).minus(d(account.sessionStartEquityUsd.toString())))
            : null,
        openRiskCapUsd:
          config && report.valuation.equityUsd !== null
            ? usd(d(report.valuation.equityUsd).mul(d(config.maxAggregateExposurePct)).div(100))
            : null,
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
          const positionKey = buildPositionKey(account.id, position.pairAddress);
          const posRow = positions.find((p) => p.pairAddress === position.pairAddress);
          const coverage = derivePositionProtectionCoverage({
            positionKey,
            lifecycleId: posRow?.lifecycleId ?? null,
            baseQty: position.baseQty,
            legs: protections.map((row) => ({
              positionKey: row.positionKey,
              lifecycleId: row.lifecycleId,
              kind: row.kind,
              origin: row.origin,
              status: row.status,
              remainingQty: row.remainingQty.toString(),
              protectedQty: row.protectedQty.toString(),
              ackState: row.ackState,
              triggerPriceUsd: row.triggerPriceUsd?.toString() ?? null,
              confirmedTriggerPriceUsd: row.confirmedTriggerPriceUsd?.toString() ?? null,
            })),
          });
          const protectedLegs = protections.filter((row) => {
            // Exact key match only — never first-colon split (primary:fixture:etf:SPY).
            if (row.positionKey !== positionKey) return false;
            const instrumentId = instrumentIdFromPositionKey(row.positionKey, account.id);
            if (instrumentId !== position.pairAddress) return false;
            if (posRow?.lifecycleId && row.lifecycleId && row.lifecycleId !== posRow.lifecycleId) {
              return false;
            }
            return true;
          });
          const stopLeg = protectedLegs.find((row) => row.kind === "STOP" && row.status === "ARMED");
          const tpLeg = protectedLegs.find((row) => row.kind === "TAKE_PROFIT" && row.status === "ARMED");
          const effectiveLegs = protectedLegs.filter((row) =>
            ["ARMED", "TRIGGERED", "SUBMITTED", "CONFIRMED"].includes(row.status),
          );
          const confirmed =
            coverage.protected &&
            effectiveLegs.length > 0 &&
            effectiveLegs.every(
              (row) =>
                row.ackState === "ACKED" ||
                row.origin === "SYNTHETIC_ENGINE" ||
                row.status === "CONFIRMED" ||
                row.status === "ARMED",
            );
          const helperOnly =
            effectiveLegs.length > 0 &&
            effectiveLegs.every((row) => row.origin === "SYNTHETIC_ENGINE");
          const venueNativeLegs = effectiveLegs.filter((row) => row.origin === "VENUE_NATIVE");
          const venueConfirmed =
            venueNativeLegs.length > 0 &&
            venueNativeLegs.every((row) => row.ackState === "ACKED" && row.confirmedTriggerPriceUsd != null);
          const durableConfirmedStop = coverage.stopTriggerUsd;
          const durableConfirmedTarget =
            tpLeg?.confirmedTriggerPriceUsd?.toString() ?? tpLeg?.triggerPriceUsd?.toString() ?? null;
          const instrument = findInstrument(position.pairAddress);
          const semantics = productSemanticsFor(position.pairAddress);
          const session = instrument
            ? evaluateSession({ session: instrument.session, now })
            : null;
          // Desired-vs-confirmed diagnostic for venue-native legs (offline modelling).
          const desireReport =
            stopLeg && stopLeg.origin === "VENUE_NATIVE"
              ? compareDesiredVsConfirmed({
                  id: stopLeg.id,
                  providerId: "alpaca_paper",
                  instrumentId: position.pairAddress,
                  origin: "VENUE_NATIVE",
                  stopPrice: stopLeg.desiredTriggerPriceUsd?.toString() ?? stopLeg.triggerPriceUsd?.toString() ?? null,
                  takeProfitPrice:
                    tpLeg?.desiredTriggerPriceUsd?.toString() ?? tpLeg?.triggerPriceUsd?.toString() ?? null,
                  qty: stopLeg.protectedQty.toString(),
                  lastConfirmedStopPrice: stopLeg.confirmedTriggerPriceUsd?.toString() ?? null,
                  lastConfirmedTakeProfitPrice: tpLeg?.confirmedTriggerPriceUsd?.toString() ?? null,
                  ackState: (stopLeg.ackState as "DESIRED_ONLY" | "SUBMITTED" | "ACKED" | "REJECTED" | "CANCELLED" | "UNKNOWN") ?? "UNKNOWN",
                  venueOrderId: null,
                  lastError: null,
                })
              : null;
          return {
            ...position,
            openedAt,
            stopUsd: durableConfirmedStop ?? stopUsd,
            targetUsd: durableConfirmedTarget ?? targetUsd,
            stopLossPct,
            takeProfitPct,
            exposurePct,
            // R12: only active current-lot stop coverage counts as protected — never FAILED/historical.
            protected: coverage.protected,
            protectionStatus: coverage.status,
            protectionRecoveryNeeded: coverage.recoveryNeeded,
            protectionOrigin: coverage.origin,
            protectionKinds: coverage.kinds,
            protectionAckState: stopLeg?.ackState ?? tpLeg?.ackState ?? null,
            protectionConfirmed: confirmed,
            protectionHelper: helperOnly,
            protectionVenueConfirmed: venueConfirmed,
            protectionDesireDiverges: desireReport?.desireDivergesFromConfirmed ?? false,
            protectionStatuses: coverage.statuses,
            productLabel: semantics?.productLabel ?? null,
            paperFamily: semantics?.paperFamily ?? null,
            sessionStatus: session?.status ?? null,
            sessionReason: session?.reason ?? null,
          };
        }),
      },
      agents: this.agentStatus(recentAgentDecisions.length > 0 ? recentAgentDecisions : decisions),
      watchlist: await this.watchlist(pairs, decisions),
      health: {
        postgres: "up",
        // UI bug 3: report Redis from the queue's own connection instead of a hard-coded "unknown".
        redis: (await this.queueRedisUp()) ? "up" : "down",
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
      historyMeta: {
        orderTotal,
        fillTotal,
        snapshotLimit: 40,
        truncated: orderTotal > 40,
        endpoint: "/api/terminal/history",
      },
      orders: orders.map((order) => this.presentHistoryOrder(order)),
    };
  }

  /**
   * Paginated ledger query for History (D22). Snapshot still embeds the latest 40;
   * this endpoint pages beyond that with order vs trade (fill) views.
   */
  /**
   * ASCEND-00 trade autopsy: evidence for the most recent closed round trips of the active account.
   * Stop overshoot is measured against the current stopLossPct (returned), not the value at the time.
   */
  async tradeAutopsy(limitText: string) {
    const parsed = Number.parseInt(limitText, 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 25;
    const accountId = await this.activeAccountId();
    const engineRow = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const stopLossPct = this.readConfig(engineRow?.config)?.stopLossPct ?? DEFAULT_STRATEGY.stopLossPct;
    const rows = await this.prisma.fill.findMany({
      where: { order: { accountId } },
      include: { order: true },
      orderBy: { createdAt: "desc" },
      take: 4000,
    });
    rows.reverse();
    const observationIds = [
      ...new Set(rows.flatMap((row) => [row.observationId, row.order.decisionObservationId]).filter((id): id is string => Boolean(id))),
    ];
    const observations = await this.prisma.marketObservation.findMany({
      where: { id: { in: observationIds } },
      select: { id: true, priceUsd: true, priceChangeM5: true, priceChangeH1: true, liquidityUsd: true, pairCreatedAt: true },
    });
    const byId = new Map(observations.map((row) => [row.id, row]));
    const byPair = new Map<string, { symbol: string; fills: AutopsyFill[]; entryObs: Map<string, string | null> }>();
    for (const row of rows) {
      const group = byPair.get(row.pairAddress) ?? {
        symbol: row.order.baseSymbol,
        fills: [] as AutopsyFill[],
        entryObs: new Map<string, string | null>(),
      };
      group.fills.push({
        id: row.id,
        side: row.side as "BUY" | "SELL",
        qty: row.qty.toString(),
        priceUsd: row.priceUsd.toString(),
        notionalUsd: row.notionalUsd.toString(),
        feeUsd: row.feeUsd.toString(),
        slippageBps: row.slippageBps.toString(),
        createdAt: row.createdAt.toISOString(),
        observedMidUsd: (row.observationId ? byId.get(row.observationId)?.priceUsd?.toString() : null) ?? null,
        ownerScope: row.order.ownerScope,
        reasonCodes: row.order.reasonCodes ?? [],
        strategyInstanceId: row.strategyInstanceId ?? row.order.strategyInstanceId,
      });
      group.entryObs.set(row.id, row.order.decisionObservationId ?? row.observationId);
      byPair.set(row.pairAddress, group);
    }
    const trips = [...byPair.entries()]
      .flatMap(([pairAddress, group]) => closedRoundTrips(group.fills).map((fills) => ({ pairAddress, group, fills })))
      .sort((left, right) => left.fills.at(-1)!.createdAt.localeCompare(right.fills.at(-1)!.createdAt))
      .slice(-limit);
    const autopsies = [];
    for (const trip of trips) {
      const first = trip.fills[0]!;
      const last = trip.fills.at(-1)!;
      const entryObservation = byId.get(trip.group.entryObs.get(first.id) ?? "");
      const path = await this.prisma.marketObservation.findMany({
        where: { pairAddress: trip.pairAddress, receivedAt: { gt: new Date(first.createdAt), lte: new Date(last.createdAt) }, priceUsd: { not: null } },
        select: { receivedAt: true, priceUsd: true },
        orderBy: { receivedAt: "asc" },
        take: 5000,
      });
      autopsies.push(
        autopsyRoundTrip({
          pairAddress: trip.pairAddress,
          baseSymbol: trip.group.symbol,
          fills: trip.fills,
          entry: entryObservation
            ? {
                priceChangeM5Pct: entryObservation.priceChangeM5?.toString() ?? null,
                priceChangeH1Pct: entryObservation.priceChangeH1?.toString() ?? null,
                liquidityUsd: entryObservation.liquidityUsd?.toString() ?? null,
                pairCreatedAt: entryObservation.pairCreatedAt?.toISOString() ?? null,
              }
            : null,
          observations: path.map((row) => ({ receivedAt: row.receivedAt.toISOString(), priceUsd: row.priceUsd!.toString() })),
          stopLossPct,
        }),
      );
    }
    autopsies.reverse();
    return { accountId, stopLossPct, summary: summariseAutopsies(autopsies), trades: autopsies };
  }

  /**
   * ASCEND-06: predicted versus observed execution cost for the most recent closed round trips. Research
   * and advisory only. Predictions use entry-time liquidity and the current feeBps/spreadBpsEstimate (the
   * config in force at each trade is not reconstructed); decision-to-fill delay is not recorded.
   */
  async executionCostReport(limitText: string) {
    const autopsy = await this.tradeAutopsy(limitText);
    const engineRow = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const config = this.readConfig(engineRow?.config);
    const feeBps = Number(config?.feeBps ?? DEFAULT_STRATEGY.feeBps);
    const spreadBpsEstimate = Number(config?.spreadBpsEstimate ?? DEFAULT_STRATEGY.spreadBpsEstimate);
    const records = autopsy.trades
      .map((trip) => forecastRecordFromAutopsy(trip, { feeBps, spreadBpsEstimate }))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    return {
      evidence: "VERIFIED_HISTORICAL",
      mode: "ADVISORY",
      accountId: autopsy.accountId,
      tripsConsidered: autopsy.trades.length,
      tripsPredicted: records.length,
      assumptions: [
        `Predictions use current feeBps ${feeBps} and spreadBpsEstimate ${spreadBpsEstimate}`,
        "Entry-time liquidity from the decision observation; trips without it are excluded",
        "Paper fills are simulated by the same impact model, so error reflects liquidity change between decision and fill, not real-venue execution",
      ],
      report: costForecastReport(records),
      records,
    };
  }

  /** The account the terminal is showing: the active environment's paper account (same as the snapshot). */
  async activeAccountId(): Promise<string> {
    const engineRow = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const config = this.readConfig(engineRow?.config);
    return resolveExecutionContext({
      config: { tradingEnvironment: config?.tradingEnvironment ?? "MARKET_DATA_PAPER" },
      dataMode: this.mode(),
    }).accountId;
  }

  async orderHistory(input: {
    kind: "orders" | "trades" | "all";
    limit: number;
    offset: number;
    side?: string;
    symbol?: string;
    status?: string;
  }) {
    const limit = Math.min(Math.max(input.limit || 40, 1), 100);
    const offset = Math.max(input.offset || 0, 0);
    // Audit F3: only the active account's orders (another environment's account never bleeds in).
    const accountId = await this.activeAccountId();
    const where: {
      accountId: string;
      side?: string;
      baseSymbol?: { contains: string; mode: "insensitive" };
      status?: string;
      fills?: { some: Record<string, never> };
    } = { accountId };
    if (input.side === "BUY" || input.side === "SELL") where.side = input.side;
    if (input.symbol?.trim()) {
      where.baseSymbol = { contains: input.symbol.trim(), mode: "insensitive" };
    }
    if (input.status?.trim()) where.status = input.status.trim().toUpperCase();
    if (input.kind === "trades") where.fills = { some: {} };

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
        include: { fills: true },
      }),
    ]);

    const items = rows.map((order) => {
      const presented = this.presentHistoryOrder(order);
      const fillQty = order.fills.reduce((sum, fill) => sum.plus(d(fill.qty.toString())), d("0"));
      const fillNotional = order.fills.reduce((sum, fill) => sum.plus(d(fill.notionalUsd.toString())), d("0"));
      const fillFees = order.fills.reduce((sum, fill) => sum.plus(d(fill.feeUsd.toString())), d("0"));
      const avgFillPx =
        fillQty.gt(0) && fillNotional.gt(0) ? usd(fillNotional.div(fillQty)) : null;
      return {
        ...presented,
        recordKind: order.fills.length > 0 ? ("trade" as const) : ("order" as const),
        fillCount: order.fills.length,
        avgFillPx,
        fillQty: fillQty.toFixed(8),
        fillNotionalUsd: usd(fillNotional),
        fillFeesUsd: usd(fillFees),
      };
    });

    return {
      kind: input.kind,
      limit,
      offset,
      total,
      hasMore: offset + items.length < total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
      items,
      note:
        input.kind === "trades"
          ? "Trades are orders with at least one fill (weighted avg fill shown)."
          : "Orders include rejects and unfilled intents; use kind=trades for fills only.",
    };
  }

  private presentHistoryOrder(order: {
    id: string;
    clientOrderId: string;
    pairAddress: string;
    baseSymbol: string;
    side: string;
    intent: string;
    status: string;
    qty: { toString(): string };
    rejectReason: string | null;
    executionMode: string;
    strategyVersion: string | null;
    createdAt: Date;
    fills: Array<{
      id: string;
      qty: { toString(): string };
      priceUsd: { toString(): string };
      notionalUsd: { toString(): string };
      feeUsd: { toString(): string };
      slippageBps: { toString(): string };
      observationId: string | null;
    }>;
  }) {
    return {
      id: order.id,
      clientOrderId: order.clientOrderId,
      pairAddress: order.pairAddress,
      baseSymbol: order.baseSymbol,
      side: order.side,
      intent: order.intent,
      status: order.status,
      qty: order.qty.toString(),
      rejectReason: order.rejectReason,
      executionMode: order.executionMode,
      strategyVersion: order.strategyVersion,
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
    };
  }

  /**
   * ACK is notification-only (R06). Never resolves AccountSafetyState —
   * worker suspension continues until clean reconcile activates resolveSafetyState.
   */
  async ackAlert(id: string, actor: string) {
    const row = await this.prisma.durableAlert.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Alert not found");
    if (row.acked) return row;
    const prior =
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    return this.prisma.durableAlert.update({
      where: { id },
      data: {
        acked: true,
        ackedAt: new Date(),
        payload: toJson({
          ...prior,
          ackedBy: actor,
          ackDoesNotClearSafety: alertAckDoesNotClearSafety(row.code),
        }),
      },
    });
  }

  async listAlerts(includeAcked = false) {
    return this.prisma.durableAlert.findMany({
      where: includeAcked ? undefined : { acked: false },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async equityHistory(rangeRaw: string) {
    const range = ["1H", "24H", "7D", "30D", "ALL"].includes(rangeRaw.toUpperCase())
      ? rangeRaw.toUpperCase()
      : "24H";
    const since = equityRangeStart(range);
    const engineRow = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    const config = this.readConfig(engineRow?.config);
    const ctx = resolveExecutionContext({
      config: { tradingEnvironment: config?.tradingEnvironment ?? "MARKET_DATA_PAPER" },
      dataMode: this.mode(),
    });
    const rows = await this.prisma.equitySnapshot.findMany({
      where: {
        accountId: ctx.metricsAccountId,
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: 2_000,
    });
    const account = await this.prisma.paperAccount.findUnique({ where: { id: ctx.accountId } });
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
    // Audit F3: scope every source to the active account. Decisions carry no account, so they are
    // taken from the account's own recent cycles.
    const accountId = await this.activeAccountId();
    const accountCycles = await this.prisma.cycleRun.findMany({
      where: { accountId },
      orderBy: { startedAt: "desc" },
      take: 200,
      select: { id: true },
    });
    const [decisions, orders, cycles] = await Promise.all([
      this.prisma.agentDecision.findMany({
        where: { cycleId: { in: accountCycles.map((cycle) => cycle.id) } },
        orderBy: { createdAt: "desc" },
        take,
      }),
      this.prisma.order.findMany({ where: { accountId }, orderBy: { createdAt: "desc" }, take, include: { fills: true } }),
      this.prisma.cycleRun.findMany({
        where: { accountId, OR: [{ status: "FAILED" }, { error: { not: null } }] },
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
    // UI item 10: carry 5-minute volume so the chart can show it under price.
    const points: Array<{ time: number; priceUsd: string; volumeUsd: string | null }> = [];
    for (const row of rows) {
      if (!row.priceUsd) continue;
      const time = Math.floor(row.receivedAt.getTime() / 1000);
      const priceUsd = row.priceUsd.toString();
      const volumeUsd = row.volume5mUsd?.toString() ?? null;
      const previous = points.at(-1);
      if (previous && previous.time === time) {
        previous.priceUsd = priceUsd;
        previous.volumeUsd = volumeUsd;
      } else points.push({ time, priceUsd, volumeUsd });
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
    // D16: resume/start must not silently clear an incomplete flatten request.
    if ((action === "resume" || action === "start") && flattenRequested) {
      const config = this.readConfig(engine.config);
      const tradingEnvironment = config?.tradingEnvironment ?? "MARKET_DATA_PAPER";
      const ctx = resolveExecutionContext({
        config: { tradingEnvironment },
        dataMode: this.mode(),
      });
      const open = await this.prisma.position.count({
        where: { accountId: ctx.accountId, baseQty: { gt: 0 } },
      });
      if (open === 0) flattenRequested = false;
    }
    const updated = await this.prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: next, flattenRequested, updatedBy: actor },
    });
    return { status: updated.status, flattenRequested: updated.flattenRequested, allowedActions: allowedActions(next) };
  }

  async configHistory(limitText: string) {
    const parsed = Number.parseInt(limitText, 10);
    const take = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    const rows = await this.prisma.engineConfigRevision.findMany({
      where: { engineId: "primary" },
      orderBy: { id: "desc" },
      take,
    });
    return {
      revisions: rows.map((row) => {
        const next = (row.config ?? {}) as Record<string, unknown>;
        const previous = (row.previousConfig ?? null) as Record<string, unknown> | null;
        return {
          id: row.id.toString(),
          source: row.source,
          actor: row.actor,
          configHash: row.configHash,
          engineUpdatedAt: row.engineUpdatedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          changes: row.changedKeys.map((key) => ({ key, from: previous?.[key] ?? null, to: next[key] ?? null })),
        };
      }),
    };
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
    // Audit C4 (review): the same engine-row lock as promotion, so a PATCH can never overwrite a
    // promotion that committed after this request read the engine.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "EngineControl" WHERE id = ${"primary"} FOR UPDATE`;
      const engine = await tx.engineControl.findUnique({ where: { id: "primary" } });
      if (!engine) throw new NotFoundException("Engine is not initialised");
      const patchRecord = parsedPatch as Record<string, unknown>;
      const operationalOnly = strategyPatchOnlyOperational(patchRecord);
      // D16: operational flags work while RUNNING; strategy/risk patches still require pause.
      if (engine.status === "RUNNING" && strategyPatchHasNonOperationalKeys(patchRecord)) {
        throw new ConflictException("Pause the engine before changing risk limits");
      }
      // Audit H1 (review F1): an invalid stored config must stay fixable, so validate stored ⊕ patch
      // rather than parsing the stored value on its own first. Missing keys come from DEFAULT_STRATEGY.
      const stored =
        engine.config && typeof engine.config === "object" && !Array.isArray(engine.config)
          ? (engine.config as Record<string, unknown>)
          : {};
      const current: Record<string, unknown> = { ...DEFAULT_STRATEGY, ...stored };
      if (promotedPaperStrategy(engine.activeStrategy)) {
        const strategyChanged = Object.entries(parsedPatch).some(([key, value]) => {
          if (value === undefined || isOperationalStrategyKey(key)) return false;
          return String(current[key]) !== String(value);
        });
        if (strategyChanged) {
          throw new ConflictException("The promoted paper strategy stays unchanged until a new operator promotion");
        }
      }
      const next = parseStrategyConfig({ ...stored, ...parsedPatch });
      if (!d(next.startingBalanceUsd).eq(d(String(current.startingBalanceUsd)))) {
        await resetPaperBalance(tx, next.startingBalanceUsd, "Reset paper starting balance");
      }
      const updated = await tx.engineControl.update({
        where: { id: "primary" },
        data: { config: toJson(next), updatedBy: actor },
      });
      return {
        config: parseStrategyConfig(updated.config),
        status: updated.status,
        operationalOnly,
        configRevision: updated.updatedAt.toISOString(),
      };
    }, { timeout: 15_000, maxWait: 10_000 });
  }

  async submitOrder(body: unknown) {
    const order = operatorOrderSchema.parse(body);
    const engine = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
    if (!engine) throw new ConflictException("Paper orders are accepted only while the engine is initialised");
    // D16/D19: BUY requires RUNNING; reduce-only SELL allowed while PAUSED.
    if (order.side === "BUY" && engine.status !== "RUNNING") {
      throw new ConflictException("Paper buys are accepted only while the engine is running");
    }
    if (order.side === "SELL" && engine.status !== "RUNNING" && engine.status !== "PAUSED") {
      throw new ConflictException("Reduce-only closes are accepted while running or paused");
    }

    const clientIntentId = order.clientIntentId ?? null;
    if (clientIntentId) {
      const existing = await this.findOperatorCycleByIntent(clientIntentId);
      if (existing) return this.presentOrderReceipt(existing.id, clientIntentId, true);
    }

    const config = this.readConfig(engine.config);
    const tradingEnvironment = config?.tradingEnvironment ?? "MARKET_DATA_PAPER";
    const ctx = resolveExecutionContext({
      config: { tradingEnvironment },
      dataMode: this.mode(),
    });
    const pinned = {
      accountId: ctx.accountId,
      tradingEnvironment: ctx.tradingEnvironment,
      dataMode: ctx.dataMode,
      metricsAccountId: ctx.metricsAccountId,
      configRevision: engine.updatedAt.toISOString(),
    };
    const cycleId = newId("cyc");
    await this.prisma.cycleRun.create({
      data: {
        id: cycleId,
        trigger: "operator",
        status: "RUNNING",
        stage: "created",
        dataState: "PENDING",
        accountId: pinned.accountId,
        tradingEnvironment: pinned.tradingEnvironment,
        dataMode: pinned.dataMode,
        configRevision: pinned.configRevision,
        pinnedContext: pinned as object,
        operator: toJson(order),
        startedAt: new Date(),
      },
    });
    await this.ingest.add(
      "ingest",
      { cycleId, trigger: "operator" },
      { jobId: stageJobId("ingest", cycleId), attempts: 3, removeOnComplete: 100, removeOnFail: 50 },
    );
    // D19: accept asynchronously — do not block 12s and label in-flight work as an error.
    return this.presentOrderReceipt(cycleId, clientIntentId, false);
  }

  async orderReceipt(query: { cycleId?: string; clientIntentId?: string }) {
    const cycleId = query.cycleId?.trim();
    const clientIntentId = query.clientIntentId?.trim();
    if (!cycleId && !clientIntentId) {
      throw new NotFoundException("Provide cycleId or clientIntentId");
    }
    if (cycleId) return this.presentOrderReceipt(cycleId, clientIntentId ?? null, false);
    const existing = await this.findOperatorCycleByIntent(clientIntentId!);
    if (!existing) throw new NotFoundException("No operator intent receipt found");
    return this.presentOrderReceipt(existing.id, clientIntentId!, true);
  }

  private async findOperatorCycleByIntent(clientIntentId: string) {
    const recent = await this.prisma.cycleRun.findMany({
      where: { trigger: "operator" },
      orderBy: { startedAt: "desc" },
      take: 80,
    });
    return (
      recent.find((row) => {
        if (!row.operator || typeof row.operator !== "object" || Array.isArray(row.operator)) return false;
        return (row.operator as { clientIntentId?: unknown }).clientIntentId === clientIntentId;
      }) ?? null
    );
  }

  private async presentOrderReceipt(cycleId: string, clientIntentId: string | null, replayed: boolean) {
    const cycle = await this.prisma.cycleRun.findUnique({ where: { id: cycleId } });
    if (!cycle) throw new NotFoundException(`Operator cycle ${cycleId} not found`);
    const orders = await this.prisma.order.findMany({ where: { cycleId }, include: { fills: true } });
    const status = cycle.status;
    const pending = status === "RUNNING";
    return {
      cycleId,
      clientIntentId,
      accepted: true,
      replayed,
      pending,
      status,
      stage: cycle.stage,
      error: cycle.error ?? null,
      message: pending
        ? "Order accepted — worker cycle still running"
        : status === "COMPLETE"
          ? "Order cycle complete"
          : `Order cycle ${status}`,
      orders: orders.map((item) => ({
        id: item.id,
        clientOrderId: item.clientOrderId,
        status: item.status,
        side: item.side,
        pairAddress: item.pairAddress,
        baseSymbol: item.baseSymbol,
        qty: item.qty.toString(),
        filledQty: item.filledQty.toString(),
        ownerScope: item.ownerScope,
        strategyInstanceId: item.strategyInstanceId,
        intentId: item.intentId,
        submissionState: item.submissionState,
        executionMode: item.executionMode,
        rejectReason: item.rejectReason,
        fills: item.fills.map((fill) => ({
          priceUsd: fill.priceUsd.toString(),
          qty: fill.qty.toString(),
          feeUsd: fill.feeUsd.toString(),
        })),
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

  private freshnessForObservation(
    row: {
      source: string;
      receivedAt: Date;
      freshness?: string | null;
      dataOrigin?: string | null;
      tradingEnvironment?: string | null;
      raw?: unknown;
    },
    now: Date,
    config: StrategyConfig | null,
  ): DataState {
    const classified = classifyFreshness({
      mode: this.mode(),
      receivedAt: row.receivedAt,
      now,
      liveMaxAgeMs: config?.liveMaxAgeMs ?? 45_000,
      delayedMaxAgeMs: config?.delayedMaxAgeMs ?? 180_000,
    });
    const provenance = inferObservationProvenance({
      source: row.source,
      freshness: row.freshness,
      dataOrigin: row.dataOrigin,
      raw: row.raw,
    });
    // Prefer stored FIXTURE/REPLAY/DELAYED provenance over receipt-age LIVE invention.
    return freshnessFromProvenance(provenance, classified);
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
      freshness?: string | null;
      dataOrigin?: string | null;
      tradingEnvironment?: string | null;
      raw?: unknown;
    },
    now: Date,
    config: StrategyConfig | null,
  ) {
    const freshness = this.freshnessForObservation(row, now, config);
    return {
      observationId: row.id,
      pairAddress: row.pairAddress,
      baseSymbol: row.baseSymbol,
      quoteSymbol: row.quoteSymbol,
      baseAddress: row.baseAddress,
      dexId: row.dexId,
      url: row.url,
      source: row.source,
      dataOrigin: row.dataOrigin ?? null,
      tradingEnvironment: row.tradingEnvironment ?? null,
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

  /** Opened-at scoped to account + current lifecycle (R01) — never first BUY ever for the pair. */
  private async positionOpenedAt(
    accountId: string,
    positions: Array<{ pairAddress: string; lifecycleId: string | null }>,
  ) {
    const result = new Map<string, string>();
    for (const position of positions) {
      let since: Date | null = null;
      if (position.lifecycleId) {
        const lifecycleStart = await this.prisma.protectionOrder.findFirst({
          where: { accountId, lifecycleId: position.lifecycleId },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        });
        since = lifecycleStart?.createdAt ?? null;
      }
      const fill = await this.prisma.fill.findFirst({
        where: {
          pairAddress: position.pairAddress,
          side: "BUY",
          order: { accountId, side: "BUY" },
          ...(since ? { createdAt: { gte: since } } : {}),
        },
        orderBy: { createdAt: "asc" },
      });
      if (fill) result.set(position.pairAddress, fill.createdAt.toISOString());
    }
    return result;
  }
}

/** Grouping scope for repeated alerts: account plus the instrument/instance the payload names. */
function alertScope(accountId: string | null, payload: unknown): string {
  const parts = [accountId ?? "global"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    for (const key of ["pairAddress", "instrumentId", "strategyInstanceId"]) {
      if (typeof row[key] === "string" && row[key]) {
        parts.push(row[key] as string);
        break;
      }
    }
  }
  return parts.join(":");
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
