import {
  ALERT_CODES,
  allocateOpportunities,
  assessSecurity,
  ensureDefaultStrategyInstances,
  entriesSuspendedAlert,
  evaluateConcurrentInstances,
  funnelEventsFromPlan,
  uniqueFunnelEvents,
  liveGateAlert,
  parseActiveStrategyIdentity,
  planCycle,
  reconcileIssueAlert,
  strategyVersionStamp,
  unknownAssessment,
  type DecisionDraft,
} from "@odin/agent-core";
import { performanceReport, valuePortfolio, type Mark } from "@odin/analytics";
import {
  BirdeyeClient,
  buildFixturePairsAtStep,
  fetchMandatorySolanaMarks,
  fetchSolanaUniverse,
  FrankfurterFxProvider,
  MarketDataGateway,
  type ProviderResult,
} from "@odin/market-data";
import { ObservabilityRegistry } from "@odin/analytics";
import type { ReservationBudget } from "@odin/risk-engine";
import { releaseInTx, reserveInTx } from "@odin/risk-engine";
import type { ObservationPoint, SecurityAssessment } from "@odin/shared";
import {
  AGENT_BUS_CHANNEL,
  TERMINAL_CHANNEL,
  assertPaperOrSandboxOnly,
  buildPositionKey,
  checkRowEnvironmentIsolation,
  classifyFreshness,
  d,
  freshnessFromProvenance,
  inferObservationProvenance,
  instrumentIdFromPositionKey,
  loadPinnedExecutionContext,
  newId,
  operatorOrderSchema,
  parseStrategyConfig,
  pinExecutionContext,
  resolveExecutionContext,
  rollSessionEquity,
  SAFETY_CODES,
  usd,
  type CyclePair,
  type DataMode,
  type DataState,
  type ExecutionContext,
  type NormalizedPair,
  type OperatorOrder,
  type StrategyConfig,
  type TradingEnvironment,
} from "@odin/shared";
import { Prisma, PrismaClient, toJson } from "@odin/shared/db";
import {
  activateSafetyState,
  armLongShortOco,
  claimOcoTriggerInTx,
  commitProposedOrder,
  isEntriesSuspended,
  lockAccount,
  persistOcoGroup,
  positionOpenMetaForLifecycle,
  protectionGroupId,
  enrichReconcileReport,
  reconcileOrders,
  reconcilePositionQty,
  recoverProtectionAfterRestart,
  resolveSafetyState,
  retryUnresolvedProtectionIntents,
  settlePendingOrder,
  updateTrailing,
} from "@odin/trading-engine";

export type MarketFeed = {
  fetchUniverse(limit: number): Promise<ProviderResult<NormalizedPair[]>>;
};

export type AgentBus = {
  publish(channel: string, payload: unknown): Promise<void>;
};

export const silentBus: AgentBus = { async publish() {} };

export class StageRunner {
  private readonly observability = new ObservabilityRegistry();

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
      // D01: pin account/environment/config revision at creation — stages must load this, not live config.
      const bootConfig = await this.config();
      const engineMeta = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
      const pinned = pinExecutionContext(
        resolveExecutionContext({
          config: bootConfig,
          dataMode: this.dataMode,
          configRevision: engineMeta?.updatedAt?.toISOString() ?? null,
          strategyRevision: engineMeta?.activeStrategy
            ? JSON.stringify(engineMeta.activeStrategy).slice(0, 120)
            : null,
        }),
        now,
      );
      await this.prisma.cycleRun.create({
        data: {
          id: cycleId,
          trigger: input.trigger,
          status: "RUNNING",
          stage: "created",
          dataState: "PENDING",
          startedAt: now,
          accountId: pinned.accountId,
          tradingEnvironment: pinned.tradingEnvironment,
          dataMode: pinned.dataMode,
          configRevision: pinned.configRevision ?? null,
          strategyRevision: pinned.strategyRevision ?? null,
          riskRevision: pinned.riskRevision ?? null,
          pinnedContext: pinned as object,
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
    const loaded = await this.loadPlan(cycleId, this.now(), this.prisma);
    if (!loaded) return;
    for (const decision of loaded.plan.decisions.filter((item) => item.agent === "SENTINEL")) {
      await upsertDecision(this.prisma, cycleId, decision);
    }
    for (const entry of loaded.plan.watchlist) {
      await this.prisma.watchlistEntry.upsert({
        where: { pairAddress: entry.pairAddress },
        create: {
          pairAddress: entry.pairAddress,
          baseAddress: entry.baseAddress,
          baseSymbol: entry.baseSymbol,
          quoteAddress: entry.quoteAddress,
          quoteSymbol: entry.quoteSymbol,
          dexId: entry.dexId,
          source: entry.source,
          score: entry.discoveryScore,
          rank: entry.rank,
          reasonCodes: entry.reasonCodes,
          cycleId,
          observedAt: new Date(entry.receivedAt),
        },
        update: {
          score: entry.discoveryScore,
          rank: entry.rank,
          reasonCodes: entry.reasonCodes,
          cycleId,
          observedAt: new Date(entry.receivedAt),
          baseSymbol: entry.baseSymbol,
          source: entry.source,
        },
      });
    }
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
    const ctx = await this.contextForCycle(cycleId);
    if (!ctx) return;
    await this.ensureAccount(ctx);
    // Crash/restart: restore confirmed protection + durable unresolved exit intents before admission.
    await recoverProtectionAfterRestart(this.prisma, { accountId: ctx.accountId });
    await this.prisma.$transaction(async (tx) => {
      await lockAccount(tx, ctx.accountId);

      // R05: settle/cancel pending under explicit policy FIRST, then refresh book/caps, then admit.
      const engine = await tx.engineControl.findUnique({ where: { id: "primary" } });
      const config = parseStrategyConfig(engine?.config ?? {});
      const pending = await tx.order.findMany({
        where: { accountId: ctx.accountId, status: "PENDING" },
        orderBy: { submittedAt: "asc" },
      });
      let filled = 0;
      const settleBudget = await this.buildReservationBudget(tx, {
        accountId: ctx.accountId,
        config,
        valuation: { equityUsd: null },
      });
      for (const row of pending) {
        // Pause / emergency: still settle eligible EXITs; cancel pending ENTRY/OPERATOR buys when halted.
        const haltEntries =
          engine?.status === "PAUSED" ||
          engine?.status === "EMERGENCY_STOP" ||
          engine?.status === "STOPPED" ||
          config.pauseNewEntries === true;
        if (
          haltEntries &&
          row.side === "BUY" &&
          (row.intent === "ENTRY" || row.intent === "OPERATOR")
        ) {
          await tx.order.update({
            where: { id: row.id },
            data: {
              status: "CANCELLED",
              rejectReason: "ENGINE_HALTED",
              reasonCodes: [...row.reasonCodes, "ENGINE_HALTED"],
            },
          });
          await releaseInTx(
            tx,
            { accountId: ctx.accountId, mode: "PAPER", clientOrderId: row.clientOrderId },
            settleBudget,
            now,
          );
          continue;
        }
        const settled = await settlePendingOrder(tx, {
          accountId: ctx.accountId,
          orderId: row.id,
          config,
          mode: this.dataMode,
          now,
          tradingEnvironment: ctx.tradingEnvironment,
        });
        if (settled.status === "FILLED") {
          filled += 1;
          if (settled.side === "BUY" && settled.pairAddress) {
            await this.armProtectionForFill(tx, {
              accountId: ctx.accountId,
              pairAddress: settled.pairAddress,
              qty: settled.filledQty ?? row.qty.toString(),
              config,
              markUsd: null,
            });
          }
        }
        if (settled.status === "FILLED" || settled.status === "REJECTED" || settled.status === "EXPIRED") {
          await releaseInTx(
            tx,
            { accountId: ctx.accountId, mode: "PAPER", clientOrderId: row.clientOrderId },
            settleBudget,
            now,
          );
        }
      }

      // Refresh authoritative book after settlement (R05).
      const loaded = await this.loadPlan(cycleId, now, tx, ctx);
      if (!loaded) return;
      for (const decision of loaded.plan.decisions.filter((item) => item.agent === "AEGIS" || item.agent === "ATLAS" || item.agent === "EXECUTOR")) {
        await upsertDecision(tx, cycleId, decision);
      }

      await this.reconcileAndAlert(tx, ctx);

      const liveGate = assertPaperOrSandboxOnly(process.env);
      const filledIds: string[] = [];
      const reservationBudget = await this.buildReservationBudget(tx, {
        accountId: ctx.accountId,
        config: loaded.config,
        valuation: loaded.valuation,
      });

      // Remaining PENDING after settle still consume slots/exposure/risk.
      const stillPending = await tx.order.findMany({
        where: { accountId: ctx.accountId, status: "PENDING" },
      });
      const pendingPairSuppress = new Set(
        stillPending.filter((o) => o.side === "BUY").map((o) => o.pairAddress),
      );

      if (!liveGate.ok) {
        await this.persistAlert(tx, liveGateAlert(liveGate.reason, liveGate.mode), ctx.accountId);
        await upsertDecision(tx, cycleId, {
          agent: "EXECUTOR",
          modelVersion: "executor-paper-1.2.0",
          pairAddress: "",
          decision: "REJECT",
          confidence: "1.000000",
          reasonCodes: ["REJECTED"],
          input: {},
          output: { error: liveGate.reason, mode: liveGate.mode },
          inputSource: "execution-gate",
          durationMs: 0,
        });
      } else {
        for (const order of loaded.plan.orders) {
          // Suppress duplicate pending intent for same instrument (R05).
          if (order.side === "BUY" && pendingPairSuppress.has(order.pairAddress)) {
            await upsertDecision(tx, cycleId, {
              agent: "EXECUTOR",
              modelVersion: "executor-paper-1.2.0",
              pairAddress: order.pairAddress,
              decision: "REJECT",
              confidence: "1.000000",
              reasonCodes: ["REJECTED"],
              input: { clientOrderId: order.clientOrderId },
              output: { reservationDenied: "PENDING_DUPLICATE" },
              inputSource: "pending-suppress",
              durationMs: 0,
            });
            continue;
          }
          const needsReservation =
            order.side === "BUY" && (order.intent === "ENTRY" || order.intent === "OPERATOR");
          if (needsReservation) {
            const mark = loaded.marks?.[order.pairAddress]?.priceUsd;
            const exposureUsd =
              mark && d(mark).gt(0) ? usd(d(order.qty).mul(d(mark))) : order.qty;
            const admitted = await reserveInTx(
              tx,
              {
                id: newId("rsv"),
                accountId: ctx.accountId,
                mode: "PAPER",
                clientOrderId: order.clientOrderId,
                cashUsd: exposureUsd,
                exposureUsd,
                slots: 1,
                riskUsd: usd(d(exposureUsd).mul(d(loaded.config.stopLossPct)).div(100)),
              },
              reservationBudget,
              now,
            );
            if (!admitted.ok) {
              await upsertDecision(tx, cycleId, {
                agent: "EXECUTOR",
                modelVersion: "executor-paper-1.2.0",
                pairAddress: order.pairAddress,
                decision: "REJECT",
                confidence: "1.000000",
                reasonCodes: ["REJECTED"],
                input: { clientOrderId: order.clientOrderId },
                output: { reservationDenied: admitted.reason },
                inputSource: "pg-reservations",
                durationMs: 0,
              });
              continue;
            }
          }
          const result = await commitProposedOrder(tx, {
            accountId: ctx.accountId,
            cycleId,
            order: {
              ...order,
              eligibleAt: order.eligibleAt,
              expiresAt: order.expiresAt,
              executionMode: liveGate.mode === "SANDBOX" ? "SANDBOX" : "PAPER",
              venue: "PAPER",
              instrumentId: order.pairAddress.includes(":") ? order.pairAddress : null,
              strategyVersion: strategyVersionStamp(loaded.activeStrategy, loaded.config.entryM5ChangePct),
            },
            config: loaded.config,
            mode: this.dataMode,
            now,
          });
          if (needsReservation) {
            if (result.status === "FILLED" || result.status === "REJECTED" || result.status === "EXPIRED") {
              await releaseInTx(
                tx,
                { accountId: ctx.accountId, mode: "PAPER", clientOrderId: order.clientOrderId },
                reservationBudget,
                now,
              );
            }
          }
          if (result.status === "PENDING" && order.side === "BUY") {
            pendingPairSuppress.add(order.pairAddress);
          }
          if (result.status === "FILLED") {
            filled += 1;
            filledIds.push(order.clientOrderId);
            if (order.side === "BUY") {
              await this.armProtectionForFill(tx, {
                accountId: ctx.accountId,
                pairAddress: order.pairAddress,
                qty: order.qty,
                config: loaded.config,
                markUsd: loaded.marks?.[order.pairAddress]?.priceUsd ?? null,
              });
            }
          }
        }
      }
      await this.evaluateProtections(tx, loaded, now, ctx);
      await this.persistFunnel(tx, cycleId, loaded, filledIds, now);

      if (loaded.flattenRequested) {
        const open = await tx.position.findMany({ where: { accountId: ctx.accountId } });
        const remaining = open.some((position) => d(position.baseQty.toString()).gt(0));
        if (!remaining) {
          await tx.engineControl.update({ where: { id: "primary" }, data: { flattenRequested: false } });
        } else {
          await upsertDecision(tx, cycleId, {
            agent: "EXECUTOR",
            modelVersion: "executor-paper-1.2.0",
            pairAddress: "",
            decision: "HOLD",
            confidence: "1.000000",
            reasonCodes: ["FLATTEN_INCOMPLETE"],
            input: {},
            output: { remainingOpen: open.filter((p) => d(p.baseQty.toString()).gt(0)).length },
            inputSource: "ledger",
            durationMs: 0,
          });
        }
      }
      await tx.cycleRun.update({ where: { id: cycleId }, data: { orderCount: filled } });
    });
    // Retry unresolved protection exits — account-scoped, lifecycle-fenced (D07).
    await retryUnresolvedProtectionIntents(this.prisma, {
      now,
      accountId: ctx.accountId,
      attemptExit: async (intent) => {
        try {
          const leg = await this.prisma.protectionOrder.findUnique({ where: { id: intent.legId } });
          if (!leg) return { ok: false, error: "LEG_MISSING" };
          if (leg.accountId !== intent.accountId) return { ok: false, error: "ACCOUNT_MISMATCH" };
          const pair = instrumentIdFromPositionKey(leg.positionKey, intent.accountId);
          if (!pair) return { ok: false, error: "POSITION_KEY_DECODE" };
          const observation = await this.prisma.marketObservation.findFirst({
            where: {
              pairAddress: pair,
              priceUsd: { not: null },
              tradingEnvironment: ctx.tradingEnvironment,
            },
            orderBy: { receivedAt: "desc" },
          });
          if (!observation) return { ok: false, error: "MISSING_PRICE" };
          const position = await this.prisma.position.findFirst({
            where: { accountId: intent.accountId, pairAddress: pair },
          });
          if (!position || d(position.baseQty.toString()).lte(0)) {
            return { ok: true };
          }
          // Fence: do not reduce a reopened lot with an old unresolved intent.
          if (leg.lifecycleId && position.lifecycleId && leg.lifecycleId !== position.lifecycleId) {
            return { ok: true };
          }
          const config = await this.prisma.engineControl.findUnique({ where: { id: "primary" } });
          const parsed = parseStrategyConfig(config?.config ?? {});
          const result = await this.prisma.$transaction(async (tx) => {
            await lockAccount(tx, intent.accountId);
            return commitProposedOrder(tx, {
              accountId: intent.accountId,
              cycleId: `prot_retry_${intent.id}`,
              order: {
                clientOrderId: `prot_retry_${intent.legId}_${intent.id}`,
                pairAddress: pair,
                baseSymbol: position.baseSymbol,
                side: "SELL",
                intent: "EXIT",
                qty: position.baseQty.toString(),
                observationId: observation.id,
                reasonCodes: ["STOP_LOSS"],
                executionMode: "PAPER",
                venue: "PAPER",
                instrumentId: pair.includes(":") ? pair : null,
              },
              config: parsed,
              mode: ctx.dataMode,
              now,
            });
          });
          return result.status === "FILLED"
            ? { ok: true }
            : { ok: false, error: result.reason ?? result.status };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "RETRY_FAILED" };
        }
      },
    });
    await this.advance(cycleId, "executor");
  }

  async archivist(cycleId: string): Promise<void> {
    if (!(await this.ready(cycleId, "executor"))) return;
    const count = await this.prisma.agentDecision.count({ where: { cycleId } });
    const orders = await this.prisma.order.count({ where: { cycleId, status: "FILLED" } });
    const loaded = await this.loadPlan(cycleId, this.now(), this.prisma);
    const archivist = loaded?.plan.decisions.find((item) => item.agent === "ARCHIVIST");
    await upsertDecision(this.prisma, cycleId, archivist ?? {
      agent: "ARCHIVIST",
      modelVersion: "archivist-research-1.1.0",
      pairAddress: "",
      decision: "PASS",
      confidence: "1.000000",
      reasonCodes: ["AUDIT_RECORDED"],
      input: {},
      output: { decisions: count + 1, orders },
      inputSource: "ledger+decisions",
      durationMs: 0,
    });
    if (loaded) {
      await this.persistEquitySnapshot(cycleId, loaded);
    }
    await this.persistTradeReconstruction(cycleId);
    await this.persistObservability(cycleId);
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
    const pinnedCtx = await this.contextForCycle(cycleId);
    const tradingEnvironment: TradingEnvironment =
      pinnedCtx?.tradingEnvironment ?? config.tradingEnvironment ?? "MARKET_DATA_PAPER";
    // Fixtures only when explicitly in FIXTURE environment.
    // Never inject fixture pairs into MARKET_DATA_PAPER / EXTERNAL_DEMO / REPLAY accounts.
    let paperExtras: NormalizedPair[] =
      tradingEnvironment === "FIXTURE"
        ? buildFixturePairsAtStep({ stepIndex: Math.floor(now.getTime() / 60_000) % 9, now })
        : [];
    // MARKET_DATA_PAPER: optional delayed FX marks from Frankfurter (not fixtures).
    if (tradingEnvironment === "MARKET_DATA_PAPER" && config.marketDataPaperFxIngest === true) {
      const fxPairs = await this.fetchFrankfurterPaperPairs(now);
      paperExtras = [...paperExtras, ...fxPairs];
    }

    const ctx =
      pinnedCtx ?? resolveExecutionContext({ config, dataMode: this.dataMode });
    await this.ensureAccount(ctx);

    // R02: mandatory independent refresh for open holdings / pending / protected — prioritise over discovery.
    const mandatoryTargets = await this.collectMandatoryMarkTargets(ctx.accountId);
    const mandatoryRefresh = await fetchMandatorySolanaMarks({
      targets: mandatoryTargets,
      now,
    });
    const mandatoryByAddress = new Map(
      (mandatoryRefresh.ok ? mandatoryRefresh.data : []).map((p) => [p.pairAddress, p]),
    );
    if (!mandatoryRefresh.ok) {
      // Provider outage: do NOT pretend old marks are fresh — record decision, continue with discovery.
      await upsertDecision(
        this.prisma,
        cycleId,
        emptyDecision("UPSTREAM_UNAVAILABLE", `Held-mark refresh failed: ${mandatoryRefresh.error}`),
      );
    }

    if (!result.ok && paperExtras.length === 0 && mandatoryByAddress.size === 0) {
      await this.prisma.cycleRun.update({
        where: { id: cycleId },
        data: { dataState: "STALE", observationCount: 0, error: result.error },
      });
      await upsertDecision(this.prisma, cycleId, emptyDecision("UPSTREAM_UNAVAILABLE", result.error));
      return;
    }

    const solanaPairs = result.ok ? result.data : [];
    // Merge mandatory marks first (override discovery for held instruments).
    const byAddress = new Map<string, NormalizedPair>();
    for (const pair of solanaPairs) byAddress.set(pair.pairAddress, pair);
    for (const [addr, pair] of mandatoryByAddress) byAddress.set(addr, pair);

    let liveCount = 0;
    let demoCount = 0;
    let delayedCount = 0;
    let isolationSkips = 0;

    for (const pair of byAddress.values()) {
      const provenance = inferObservationProvenance({
        source: pair.source,
        raw: pair.raw,
      });
      const isolation = checkRowEnvironmentIsolation(provenance, tradingEnvironment);
      if (!isolation.ok) {
        isolationSkips += 1;
        continue;
      }
      const classified = classifyFreshness({
        mode: "live",
        receivedAt: now,
        now,
        liveMaxAgeMs: config.liveMaxAgeMs,
        delayedMaxAgeMs: config.delayedMaxAgeMs,
      });
      const freshness = freshnessFromProvenance(provenance, classified);
      await this.prisma.marketObservation.upsert({
        where: { ingestJobId_pairAddress: { ingestJobId: cycleId, pairAddress: pair.pairAddress } },
        create: observationData(cycleId, pair, freshness, now, {
          dataOrigin: provenance.dataOrigin,
          tradingEnvironment,
          eventTime: provenance.eventTime ? new Date(provenance.eventTime) : now,
        }),
        update: {},
      });
      if (freshness === "LIVE") liveCount += 1;
      else if (freshness === "DELAYED") delayedCount += 1;
      else demoCount += 1;
    }

    // R09: validate each extra row's typed origin — do not abort healthy Solana ingest for FX.
    for (const pair of paperExtras) {
      const provenance = inferObservationProvenance({
        source: pair.source,
        raw: pair.raw,
      });
      const isolation = checkRowEnvironmentIsolation(provenance, tradingEnvironment);
      if (!isolation.ok) {
        isolationSkips += 1;
        await upsertDecision(
          this.prisma,
          cycleId,
          emptyDecision("FIXTURE_ISOLATION", `${pair.pairAddress}: ${isolation.reason}`),
        );
        continue;
      }
      const freshness: DataState =
        tradingEnvironment === "FIXTURE"
          ? "DEMO"
          : freshnessFromProvenance(provenance, "DELAYED");
      await this.prisma.marketObservation.upsert({
        where: { ingestJobId_pairAddress: { ingestJobId: cycleId, pairAddress: pair.pairAddress } },
        create: observationData(cycleId, pair, freshness, now, {
          dataOrigin: provenance.dataOrigin,
          tradingEnvironment,
          eventTime: provenance.eventTime ? new Date(provenance.eventTime) : now,
        }),
        update: {},
      });
      if (freshness === "DELAYED") delayedCount += 1;
      else demoCount += 1;
    }

    const total = liveCount + demoCount + delayedCount;
    const state: DataState =
      liveCount > 0 ? "LIVE" : delayedCount > 0 ? "DELAYED" : demoCount > 0 ? "DEMO" : "STALE";
    await this.prisma.cycleRun.update({
      where: { id: cycleId },
      data: {
        dataState: state,
        observationCount: total,
        error:
          total === 0
            ? "DexScreener returned no Solana pairs and multi-market paper ingest empty"
            : !result.ok
              ? `Solana upstream unavailable; paper multi-market / held marks ingested (${demoCount + delayedCount})`
              : isolationSkips > 0
                ? `Scoped ${isolationSkips} isolation skip(s); healthy rows retained`
                : null,
      },
    });
    if (total === 0) {
      await upsertDecision(this.prisma, cycleId, emptyDecision("EMPTY_UNIVERSE", "No Solana or paper multi-market pairs"));
    }
  }

  private async persistAgent(cycleId: string, agent: DecisionDraft["agent"]): Promise<void> {
    const loaded = await this.loadPlan(cycleId, this.now(), this.prisma);
    if (!loaded) return;
    for (const decision of loaded.plan.decisions.filter((item) => item.agent === agent)) {
      await upsertDecision(this.prisma, cycleId, decision);
    }
  }

  private async loadPlan(
    cycleId: string,
    now: Date,
    db: PrismaClient | Prisma.TransactionClient,
    ctxOverride?: ExecutionContext,
  ) {
    const cycle = await db.cycleRun.findUnique({ where: { id: cycleId } });
    const engine = await db.engineControl.findUnique({ where: { id: "primary" } });
    if (!cycle || !engine) return null;
    let config: StrategyConfig;
    try {
      config = parseStrategyConfig(engine.config);
    } catch {
      await upsertDecision(db, cycleId, emptyDecision("CONFIG_INVALID", "Strategy configuration failed validation"));
      return null;
    }
    const ctx =
      ctxOverride ??
      (await this.contextForCycle(cycleId, db)) ??
      resolveExecutionContext({ config, dataMode: this.dataMode });
    const account = await db.paperAccount.findUnique({ where: { id: ctx.accountId } });
    if (!account) return null;
    // D02: exact environment match only — null provenance is quarantined, not trusted.
    const rows = await db.marketObservation.findMany({
      where: {
        ingestJobId: cycleId,
        tradingEnvironment: ctx.tradingEnvironment,
      },
    });
    const pairsByAddress = new Map<string, CyclePair>();
    for (const row of rows) {
      pairsByAddress.set(row.pairAddress, toCyclePair(row, now, config, this.dataMode));
    }
    const positions = await db.position.findMany({ where: { accountId: ctx.accountId } });
    const marks: Record<string, Mark | undefined> = {};
    for (const pair of pairsByAddress.values()) {
      if (pair.priceUsd) marks[pair.pairAddress] = { priceUsd: pair.priceUsd, freshness: pair.freshness };
    }
    // Held positions monitored from THIS cycle's mandatory refresh when present.
    // Never treat a prior-cycle stored mark as freshly ingested (R02).
    for (const position of positions) {
      if (!d(position.baseQty.toString()).gt(0)) continue;
      if (pairsByAddress.has(position.pairAddress)) continue;
      // Missing from this cycle → mark as STALE/MISSING for eval (do not invent freshness).
      marks[position.pairAddress] = { priceUsd: null, freshness: "STALE" };
    }
    const pairs = [...pairsByAddress.values()];
    const positionViews = await Promise.all(
      positions.map(async (position) => {
        const openMeta = await positionOpenMetaForLifecycle(db, {
          accountId: ctx.accountId,
          pairAddress: position.pairAddress,
          lifecycleId: position.lifecycleId,
          currentMarkUsd: marks[position.pairAddress]?.priceUsd ?? null,
        });
        return {
          pairAddress: position.pairAddress,
          baseSymbol: position.baseSymbol,
          baseQty: position.baseQty.toString(),
          avgCostUsd: position.avgCostUsd.toString(),
          realizedPnlUsd: position.realizedPnlUsd.toString(),
          openedAt: openMeta.openedAt,
          peakMarkUsd: openMeta.peakMarkUsd,
        };
      }),
    );
    const valuation = valuePortfolio({ cashUsd: account.cashUsd.toString(), positions: positionViews, marks });
    // UTC midnight session roll + HWM ratchet — must persist so daily PnL resets honestly.
    const sessionRoll = rollSessionEquity({
      now,
      sessionStartedAt: account.sessionStartedAt,
      sessionStartEquityUsd: account.sessionStartEquityUsd?.toString() ?? null,
      currentEquityUsd: valuation.equityUsd,
      highWaterMarkUsd: account.highWaterMarkUsd?.toString() ?? null,
      startingBalanceUsd: account.startingBalanceUsd.toString(),
    });
    if (
      sessionRoll.rolled ||
      sessionRoll.highWaterMarkUsd !== (account.highWaterMarkUsd?.toString() ?? null)
    ) {
      await db.paperAccount.update({
        where: { id: account.id },
        data: {
          sessionStartedAt: sessionRoll.sessionStartedAt,
          sessionStartEquityUsd: sessionRoll.sessionStartEquityUsd,
          highWaterMarkUsd: sessionRoll.highWaterMarkUsd,
        },
      });
    }
    const dailyPnlUsd =
      valuation.valuation !== "CASH_ONLY" && valuation.valuation !== "LIVE"
        ? null
        : sessionRoll.dailyPnlUsd;
    const operator = parseOperator(cycle.operator);
    const historyAddresses = [
      ...new Set([
        ...pairs.map((pair) => pair.pairAddress),
        ...positions.filter((p) => d(p.baseQty.toString()).gt(0)).map((p) => p.pairAddress),
      ]),
    ];
    const observationHistory = await this.loadObservationHistory(
      db,
      historyAddresses,
      ctx.tradingEnvironment,
    );
    const securityByMint = await this.loadSecurity(pairs);
    const aggregateExposureUsd =
      valuation.equityUsd === null
        ? "0"
        : usd(d(valuation.equityUsd).minus(d(account.cashUsd.toString())));
    const highWaterMarkUsd = sessionRoll.highWaterMarkUsd;
    const activeStrategy = parseActiveStrategyIdentity(engine.activeStrategy);
    // R06: suspension from AccountSafetyState — never from DurableAlert.acked alone.
    const suspensionActive = await isEntriesSuspended(db, ctx.accountId);
    // Durable concurrent StrategyInstances — seed defaults, evaluate, allocate entries.
    const instances = await ensureDefaultStrategyInstances(db, ctx.accountId);
    const bars = pairs.map((pair) => ({
      instrumentId: pair.pairAddress.includes(":") ? pair.pairAddress : `solana:spot:universe`,
      pairAddress: pair.pairAddress,
      receivedAt: pair.receivedAt,
      priceUsd: pair.priceUsd,
      liquidityUsd: pair.liquidityUsd,
      volume24hUsd: pair.volume24hUsd,
      priceChangeM5Pct: pair.priceChangeM5Pct,
      priceChangeH1Pct: pair.priceChangeH1Pct,
      txnsM5Buys: pair.txnsM5Buys,
      txnsM5Sells: pair.txnsM5Sells,
      dataState: pair.freshness,
    }));
    const concurrentSignals = evaluateConcurrentInstances({
      instances,
      bars,
      context: {
        config,
        openPositions: positionViews.map((p) => ({
          instrumentId: p.pairAddress,
          pairAddress: p.pairAddress,
          qty: p.baseQty,
        })),
        history: [],
      },
    });
    const allocated = allocateOpportunities({
      signals: concurrentSignals,
      maxNewEntries: Math.max(1, config.maxPositions - positionViews.filter((p) => d(p.baseQty).gt(0)).length),
    });
    const concurrentEntryAllowlist = new Set(
      allocated.accepted
        .filter((s) => s.intent === "ENTER_LONG")
        .map((s) => s.pairAddress || s.instrumentId)
        .filter((id): id is string => Boolean(id)),
    );
    // Always allow pulse path when no ENTER signals produced (cold start / insufficient bars).
    const gateEntries = concurrentEntryAllowlist.size > 0 ? concurrentEntryAllowlist : null;
    const concurrentInstanceByPair = new Map<string, string>();
    for (const signal of allocated.accepted) {
      const key = signal.pairAddress || signal.instrumentId;
      if (key) concurrentInstanceByPair.set(key, signal.strategyInstanceId);
    }
    return {
      config,
      ctx,
      flattenRequested: engine.flattenRequested,
      valuation,
      highWaterMarkUsd,
      activeStrategy,
      marks,
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
        observationHistory,
        securityByMint,
        highWaterMarkUsd,
        aggregateExposureUsd,
        entriesSuspended: suspensionActive,
        activeStrategyId: activeStrategy?.strategyId ?? null,
        concurrentEntryAllowlist: gateEntries,
        concurrentInstanceByPair,
        now,
      }),
    };
  }

  /** Load durable pinned cycle context; refuse economic work when pin is missing/corrupt (D01). */
  private async contextForCycle(
    cycleId: string,
    db: PrismaClient | Prisma.TransactionClient = this.prisma,
  ): Promise<ExecutionContext | null> {
    const cycle = await db.cycleRun.findUnique({ where: { id: cycleId } });
    if (!cycle) return null;
    if (cycle.pinnedContext) {
      const loaded = loadPinnedExecutionContext(cycle.pinnedContext);
      if (loaded.ok) return loaded.ctx;
    }
    // Legacy cycles created before pinning: resolve once and backfill for subsequent stages.
    const config = await this.config();
    const ctx = resolveExecutionContext({
      config,
      dataMode: (cycle.dataMode as DataMode | null) ?? this.dataMode,
    });
    if (!cycle.pinnedContext) {
      const pinned = pinExecutionContext(ctx);
      await db.cycleRun.update({
        where: { id: cycleId },
        data: {
          accountId: pinned.accountId,
          tradingEnvironment: pinned.tradingEnvironment,
          dataMode: pinned.dataMode,
          configRevision: pinned.configRevision ?? null,
          pinnedContext: pinned as object,
        },
      });
    }
    return ctx;
  }

  private async buildReservationBudget(
    tx: Prisma.TransactionClient,
    loaded: {
      accountId: string;
      config: StrategyConfig;
      valuation: { equityUsd: string | null };
    },
  ): Promise<ReservationBudget> {
    const account = await tx.paperAccount.findUniqueOrThrow({ where: { id: loaded.accountId } });
    const openPositions = await tx.position.findMany({
      where: { accountId: loaded.accountId, baseQty: { gt: 0 } },
    });
    // D04: open-book baseline only. Pending HELD reservations are added in reconstructBudget.
    // Never treat base quantity as dollar exposure.
    const openSlots = openPositions.length;
    const equity = loaded.valuation.equityUsd ?? account.cashUsd.toString();
    const exposureCap = usd(d(equity).mul(d(loaded.config.maxAggregateExposurePct)).div(100));
    let openExposure = d("0");
    for (const position of openPositions) {
      openExposure = openExposure.plus(
        d(position.baseQty.toString()).mul(d(position.avgCostUsd.toString())),
      );
    }
    const openRisk = openExposure.mul(d(loaded.config.stopLossPct)).div(100);
    const riskBudget = usd(
      d(equity).mul(d(loaded.config.maxRiskPerTradePct)).mul(loaded.config.maxPositions).div(100),
    );
    return {
      cashAvailableUsd: account.cashUsd.toString(),
      exposureCapUsd: exposureCap,
      exposureUsedUsd: usd(openExposure),
      // Total capacity — reconstructBudget adds HELD slot remainders to slotsUsed.
      slotsAvailable: loaded.config.maxPositions,
      slotsUsed: openSlots,
      riskBudgetUsd: riskBudget,
      riskUsedUsd: usd(openRisk),
    };
  }

  private async persistFunnel(
    db: PrismaClient | Prisma.TransactionClient,
    cycleId: string,
    loaded: NonNullable<Awaited<ReturnType<StageRunner["loadPlan"]>>>,
    filledClientOrderIds: string[],
    now: Date,
  ): Promise<void> {
    const events = uniqueFunnelEvents(
      funnelEventsFromPlan({
        cycleId,
        decisions: loaded.plan.decisions,
        orders: loaded.plan.orders,
        filledClientOrderIds,
        at: now.toISOString(),
      }),
    );
    if (events.length === 0) return;
    const accountId = loaded.ctx?.metricsAccountId
      ?? resolveExecutionContext({ config: loaded.config, dataMode: this.dataMode }).metricsAccountId;
    // Skip stages already persisted for this cycle (idempotent retry).
    const existing = await db.opportunityFunnelEvent.findMany({
      where: { cycleId, accountId },
      select: { pairAddress: true, stage: true },
    });
    const seen = new Set(existing.map((row) => `${row.pairAddress}|${row.stage}`));
    const fresh = events.filter((event) => !seen.has(`${event.pairAddress}|${event.stage}`));
    if (fresh.length === 0) return;
    await db.opportunityFunnelEvent.createMany({
      data: fresh.map((event) => ({
        accountId,
        cycleId: event.cycleId,
        pairAddress: event.pairAddress,
        instrumentId: event.instrumentId ?? null,
        stage: event.stage,
        reasonCodes: event.reasonCodes.map(String),
        detail: event.detail ? toJson(event.detail) : undefined,
        createdAt: new Date(event.at),
      })),
    });
  }

  private async persistAlert(
    db: PrismaClient | Prisma.TransactionClient,
    alert: { severity: string; code: string; message: string; payload?: Record<string, unknown> },
    accountId?: string,
  ): Promise<void> {
    const existing = await db.durableAlert.findFirst({
      where: {
        acked: false,
        code: alert.code,
        ...(accountId ? { accountId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return;
    await db.durableAlert.create({
      data: {
        accountId: accountId ?? null,
        severity: alert.severity,
        code: alert.code,
        message: alert.message,
        payload: alert.payload ? toJson(alert.payload) : undefined,
      },
    });
  }

  /**
   * Resolve safety controls (R06). Optionally ACK related notification alerts —
   * ACK alone never clears safety; this path is reconcile-driven.
   */
  private async resolveSafetyAndAlerts(
    db: PrismaClient | Prisma.TransactionClient,
    accountId: string,
    codes: string[],
    now: Date,
  ): Promise<void> {
    await resolveSafetyState(db, { accountId, codes, now });
    await db.durableAlert.updateMany({
      where: {
        acked: false,
        code: { in: codes },
        OR: [{ accountId }, { accountId: null }],
      },
      data: { acked: true, ackedAt: now },
    });
  }

  /**
   * Paper venue is self-truthful: broker rows mirror durable ledger.
   * Fault-injection / external brokers pass mismatched truth via env ODIN_RECONCILE_FAULT=1
   * to prove suspension alerts; clean reconcile resolves ENTRIES_SUSPENDED.
   */
  private async reconcileAndAlert(
    db: PrismaClient | Prisma.TransactionClient,
    ctx: ExecutionContext,
  ): Promise<void> {
    const orders = await db.order.findMany({
      where: { accountId: ctx.accountId },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const ledger = orders.map((row) => ({
      clientOrderId: row.clientOrderId,
      status: row.status,
      filledQty: row.filledQty.toString(),
      venue: row.venue,
    }));
    const broker = ledger.map((row) => ({
      clientOrderId: row.clientOrderId,
      status: (row.status === "PENDING"
        ? "ACKED"
        : row.status === "FILLED"
          ? "FILLED"
          : row.status === "CANCELLED"
            ? "CANCELLED"
            : row.status === "REJECTED"
              ? "REJECTED"
              : "UNKNOWN") as "ACKED" | "FILLED" | "CANCELLED" | "REJECTED" | "UNKNOWN",
      filledQty: row.filledQty,
      venue: row.venue,
    }));
    if (process.env.ODIN_RECONCILE_FAULT === "1") {
      broker.push({
        clientOrderId: "fault_unknown_exposure",
        status: "FILLED",
        filledQty: "1",
        venue: "EXTERNAL",
      });
    }
    const baseReport = reconcileOrders({ broker, ledger });
    const positions = await db.position.findMany({ where: { accountId: ctx.accountId } });
    const positionDrifts: Array<{ pairAddress: string; driftQty: string }> = [];
    for (const position of positions) {
      const filledOrders = await db.order.findMany({
        where: { accountId: ctx.accountId, pairAddress: position.pairAddress, status: "FILLED" },
        include: { fills: true },
      });
      const buys: string[] = [];
      const sells: string[] = [];
      for (const order of filledOrders) {
        for (const fill of order.fills) {
          if (order.side === "BUY") buys.push(fill.qty.toString());
          else sells.push(fill.qty.toString());
        }
      }
      const qtyCheck = reconcilePositionQty({
        pairAddress: position.pairAddress,
        positionQty: position.baseQty.toString(),
        buyFillQtys: buys,
        sellFillQtys: sells,
      });
      if (!qtyCheck.ok) {
        positionDrifts.push({ pairAddress: position.pairAddress, driftQty: qtyCheck.driftQty });
      }
    }
    const report = enrichReconcileReport(baseReport, { positionDrifts });
    this.observability.record({
      category: "portfolio_reconciliation",
      name: report.ok ? "reconcile_clean" : "reconcile_dirty",
      value: report.issues.length,
      unit: "issues",
      meta: { suspendEntries: report.suspendEntries, accountId: ctx.accountId },
    });
    if (report.suspendEntries) {
      await activateSafetyState(db, {
        accountId: ctx.accountId,
        code: SAFETY_CODES.ENTRIES_SUSPENDED,
        detail: { issues: report.issues, at: this.now().toISOString() },
        now: this.now(),
      });
      await this.persistAlert(
        db,
        entriesSuspendedAlert({ issues: report.issues, at: this.now().toISOString() }),
        ctx.accountId,
      );
      await this.persistAlert(db, reconcileIssueAlert({ issues: report.issues }), ctx.accountId);
    } else if (report.ok) {
      await this.resolveSafetyAndAlerts(
        db,
        ctx.accountId,
        [ALERT_CODES.ENTRIES_SUSPENDED, ALERT_CODES.RECONCILE_ISSUE, SAFETY_CODES.ENTRIES_SUSPENDED],
        this.now(),
      );
    } else {
      await this.persistAlert(db, reconcileIssueAlert({ issues: report.issues }), ctx.accountId);
    }
  }

  private async loadObservationHistory(
    db: PrismaClient | Prisma.TransactionClient,
    pairAddresses: string[],
    tradingEnvironment: TradingEnvironment,
  ): Promise<Record<string, ObservationPoint[]>> {
    const history: Record<string, ObservationPoint[]> = {};
    for (const pairAddress of pairAddresses) {
      // D02: latest window scoped to trading environment — never mix fixture into paper.
      const rows = await db.marketObservation.findMany({
        where: { pairAddress, tradingEnvironment },
        orderBy: { receivedAt: "desc" },
        take: 40,
      });
      history[pairAddress] = rows
        .slice()
        .reverse()
        .map((row) => ({
          receivedAt: row.receivedAt.toISOString(),
          priceUsd: row.priceUsd?.toString() ?? null,
          liquidityUsd: row.liquidityUsd?.toString() ?? null,
          volume5mUsd: row.volume5mUsd?.toString() ?? null,
          volume24hUsd: row.volume24hUsd?.toString() ?? null,
          txnsM5Buys: row.txnsM5Buys,
          txnsM5Sells: row.txnsM5Sells,
          priceChangeM5Pct: row.priceChangeM5?.toString() ?? null,
        }));
    }
    return history;
  }

  private async loadSecurity(pairs: CyclePair[]): Promise<Record<string, SecurityAssessment>> {
    const out: Record<string, SecurityAssessment> = {};
    const client = new BirdeyeClient(process.env.BIRDEYE_API_KEY || undefined);
    const unique = [...new Map(pairs.map((pair) => [pair.baseAddress, pair])).values()];
    for (const pair of unique.slice(0, 8)) {
      const cached = await this.prisma.securityAssessment.findUnique({ where: { tokenAddress: pair.baseAddress } });
      const cachedAssessment = cached ? toSecurityAssessment(cached) : null;
      if (!process.env.BIRDEYE_API_KEY) {
        const assessment = unknownAssessment(pair.baseAddress, "unavailable", this.now(), [
          "SECURITY_UNKNOWN",
          "UPSTREAM_UNAVAILABLE",
        ]);
        out[pair.baseAddress] = assessment;
        continue;
      }
      if (cachedAssessment && cachedAssessment.fetchedAt) {
        const age = this.now().getTime() - Date.parse(cachedAssessment.fetchedAt);
        if (Number.isFinite(age) && age < 3_600_000) {
          out[pair.baseAddress] = { ...cachedAssessment, stale: false };
          continue;
        }
      }
      const security = await client.getTokenSecurity(pair.baseAddress);
      const holders = await client.getHolders(pair.baseAddress);
      const assessment = assessSecurity({
        tokenAddress: pair.baseAddress,
        security: security.ok
          ? { ok: true, fetchedAt: security.fetchedAt, fields: security.data.fields }
          : { ok: false, code: security.code, error: security.error },
        holders: holders.ok
          ? { ok: true, fields: holders.data.fields, holderCount: holders.data.holderCount }
          : { ok: false, code: holders.code, error: holders.error },
        liquidityUsd: pair.liquidityUsd,
        now: this.now(),
        cached: cachedAssessment,
      });
      out[pair.baseAddress] = assessment;
      await this.prisma.securityAssessment.upsert({
        where: { tokenAddress: pair.baseAddress },
        create: {
          tokenAddress: assessment.tokenAddress,
          category: assessment.category,
          confidence: assessment.confidence,
          reasonCodes: assessment.reasonCodes,
          mintAuthority: assessment.mintAuthority,
          freezeAuthority: assessment.freezeAuthority,
          transferRestricted: assessment.transferRestricted,
          holderConcentrationTop10Pct: assessment.holderConcentrationTop10Pct,
          suspiciousDeployer: assessment.suspiciousDeployer,
          liquidityFragile: assessment.liquidityFragile,
          largeWalletMove: assessment.largeWalletMove,
          fraudIndicators: assessment.fraudIndicators,
          source: assessment.source,
          stale: assessment.stale,
          fields: toJson(assessment.fields),
          fetchedAt: assessment.fetchedAt ? new Date(assessment.fetchedAt) : null,
        },
        update: {
          category: assessment.category,
          confidence: assessment.confidence,
          reasonCodes: assessment.reasonCodes,
          mintAuthority: assessment.mintAuthority,
          freezeAuthority: assessment.freezeAuthority,
          transferRestricted: assessment.transferRestricted,
          holderConcentrationTop10Pct: assessment.holderConcentrationTop10Pct,
          suspiciousDeployer: assessment.suspiciousDeployer,
          liquidityFragile: assessment.liquidityFragile,
          largeWalletMove: assessment.largeWalletMove,
          fraudIndicators: assessment.fraudIndicators,
          source: assessment.source,
          stale: assessment.stale,
          fields: toJson(assessment.fields),
          fetchedAt: assessment.fetchedAt ? new Date(assessment.fetchedAt) : null,
        },
      });
    }
    return out;
  }

  private async persistTradeReconstruction(cycleId: string): Promise<void> {
    const orders = await this.prisma.order.findMany({
      where: { cycleId, status: "FILLED" },
      include: { fills: true },
    });
    for (const order of orders) {
      for (const fill of order.fills) {
        const capturedAt = fill.createdAt;
        const rows = [
          {
            phase: "BEFORE",
            postExit: false,
            context: {
              side: order.side,
              intent: order.intent,
              reasonCodes: order.reasonCodes,
              pairAddress: order.pairAddress,
              baseSymbol: order.baseSymbol,
            },
          },
          {
            phase: "DURING",
            postExit: false,
            context: {
              priceUsd: fill.priceUsd.toString(),
              qty: fill.qty.toString(),
              notionalUsd: fill.notionalUsd.toString(),
              feeUsd: fill.feeUsd.toString(),
              slippageBps: fill.slippageBps.toString(),
            },
          },
          {
            phase: "AFTER",
            postExit: true,
            context: {
              feeUsd: fill.feeUsd.toString(),
              outcome: order.intent === "ENTRY" ? "OPEN" : "CLOSED",
            },
          },
        ];
        for (const row of rows) {
          await this.prisma.tradeMemory.create({
            data: {
              tradeId: fill.id,
              pairAddress: fill.pairAddress,
              phase: row.phase,
              postExit: row.postExit,
              context: toJson(row.context),
              capturedAt,
            },
          });
        }
      }
    }
  }

  private async persistEquitySnapshot(
    cycleId: string,
    loaded: NonNullable<Awaited<ReturnType<StageRunner["loadPlan"]>>>,
  ): Promise<void> {
    const ctx =
      loaded.ctx ??
      (await this.contextForCycle(cycleId)) ??
      resolveExecutionContext({ config: loaded.config, dataMode: this.dataMode });
    const account = await this.prisma.paperAccount.findUnique({ where: { id: ctx.accountId } });
    if (!account) return;
    const fees = await this.prisma.ledgerEntry.aggregate({
      where: { accountId: ctx.accountId, type: "FEE" },
      _sum: { amountUsd: true },
    });
    const closed = await this.prisma.ledgerEntry.findMany({
      where: { accountId: ctx.accountId, type: "REALIZED_PNL" },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const report = performanceReport({
      valuation: loaded.valuation,
      startingBalanceUsd: account.startingBalanceUsd.toString(),
      feesUsd: usd(d(fees._sum.amountUsd?.toString() ?? "0").abs()),
      closedTradePnlUsd: closed.map((entry) => entry.amountUsd.toString()),
    });
    const equityUsd = loaded.valuation.equityUsd;
    const hwm =
      equityUsd === null
        ? loaded.highWaterMarkUsd
        : usd(DecimalMax(d(loaded.highWaterMarkUsd), d(equityUsd)));
    await this.prisma.equitySnapshot.create({
      data: {
        accountId: ctx.metricsAccountId,
        cycleId,
        cashUsd: account.cashUsd.toString(),
        equityUsd,
        unrealizedPnlUsd: loaded.valuation.unrealizedPnlUsd,
        realizedPnlUsd: loaded.valuation.realizedPnlUsd,
        highWaterMarkUsd: hwm,
        exposureUsd:
          equityUsd === null ? null : usd(d(equityUsd).minus(d(account.cashUsd.toString()))),
        valuation: loaded.valuation.valuation,
        feesUsd: report.feesUsd,
        metrics: toJson({
          tradingEnvironment: ctx.tradingEnvironment,
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
        }),
      },
    });
    if (hwm) {
      await this.prisma.paperAccount.update({
        where: { id: ctx.accountId },
        data: { highWaterMarkUsd: hwm },
      });
    }
  }

  /** Flush in-cycle observability counters into durable ObservabilityEvent rows. */
  private async persistObservability(cycleId: string): Promise<void> {
    this.observability.record({
      category: "simulation_uptime",
      name: "cycle_complete",
      value: 1,
      unit: "cycle",
      meta: { cycleId },
    });
    const rows = this.observability.snapshot();
    if (rows.length === 0) return;
    await this.prisma.observabilityEvent.createMany({
      data: rows.map((row) => ({
        category: row.category,
        name: row.name,
        value: row.value,
        unit: row.unit,
        meta: toJson({ ...row.meta, cycleId }),
        createdAt: new Date(row.at),
      })),
    });
    this.observability.clear();
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

  /**
   * Delayed FX (+ optional ETF when READY) marks for MARKET_DATA_PAPER via MarketDataGateway.
   * Never fixtures, never invents levels when provider not READY.
   */
  private async fetchFrankfurterPaperPairs(now: Date): Promise<NormalizedPair[]> {
    try {
      const gateway = new MarketDataGateway({
        frankfurter: new FrankfurterFxProvider({ now: () => now }),
      });
      this.observability.record({
        category: "provider_api",
        name: "gateway_fx_fetch",
        value: 1,
        unit: "call",
        meta: { readiness: gateway.readiness() },
        at: now.toISOString(),
      });
      const ids = ["fx:EURUSD", "fx:GBPUSD"];
      const quotes = await gateway.getQuotes(ids);
      if (!quotes.ok) return [];
      return quotes.data
        .filter((q) => q.level !== null)
        .map((q) => ({
          source: "fx_stub" as const,
          chainId: "fx" as const,
          pairAddress: q.instrumentId,
          dexId: "frankfurter-fx",
          url: null,
          baseAddress: q.instrumentId.split(":")[1]?.slice(0, 3) ?? "EUR",
          baseSymbol: q.symbol,
          baseName: q.symbol,
          quoteAddress: "USD",
          quoteSymbol: "USD",
          priceUsd: q.level,
          liquidityUsd: null,
          volume24hUsd: null,
          volume5mUsd: null,
          priceChangeM5Pct: null,
          priceChangeH1Pct: null,
          priceChangeH24Pct: null,
          txnsM5Buys: null,
          txnsM5Sells: null,
          pairCreatedAt: null,
          fdvUsd: null,
          marketCapUsd: null,
          raw: {
            provenance: q.provenance,
            dataState: q.dataState,
            dataOrigin: "DELAYED_FEED",
            tradingEnvironment: "MARKET_DATA_PAPER",
            bid: q.bid ?? null,
            ask: q.ask ?? null,
            eventTime: q.eventTime ?? null,
            receivedAt: q.receivedAt,
            providerId: "frankfurter_fx",
          },
        }));
    } catch {
      return [];
    }
  }

  private async ensureAccount(ctx: ExecutionContext): Promise<void> {
    const existing = await this.prisma.paperAccount.findUnique({ where: { id: ctx.accountId } });
    if (existing) return;
    const config = await this.config();
    const starting = usd(d(config.startingBalanceUsd));
    await this.prisma.paperAccount.create({
      data: {
        id: ctx.accountId,
        cashUsd: starting,
        startingBalanceUsd: starting,
        tradingEnvironment: ctx.tradingEnvironment,
      },
    });
    await this.prisma.ledgerEntry.create({
      data: {
        accountId: ctx.accountId,
        type: "OPENING_BALANCE",
        amountUsd: starting,
        affectsCash: true,
        note: `Opening balance for ${ctx.tradingEnvironment}`,
      },
    });
  }

  /** Open holdings + pending + protected instruments that must be refreshed independently (R02). */
  private async collectMandatoryMarkTargets(
    accountId: string,
  ): Promise<Array<{ pairAddress: string; baseAddress?: string | null }>> {
    const positions = await this.prisma.position.findMany({
      where: { accountId, baseQty: { gt: 0 } },
      select: { pairAddress: true, baseSymbol: true },
    });
    const pending = await this.prisma.order.findMany({
      where: { accountId, status: "PENDING" },
      select: { pairAddress: true },
    });
    const protectedRows = await this.prisma.protectionOrder.findMany({
      where: { accountId, status: { in: ["ARMED", "TRIGGERED", "SUBMITTED", "FAILED"] } },
      select: { positionKey: true },
    });
    const addresses = new Set<string>();
    for (const p of positions) addresses.add(p.pairAddress);
    for (const p of pending) addresses.add(p.pairAddress);
    for (const row of protectedRows) {
      const pair = instrumentIdFromPositionKey(row.positionKey, accountId);
      if (pair) addresses.add(pair);
    }
    const targets: Array<{ pairAddress: string; baseAddress?: string | null }> = [];
    for (const pairAddress of addresses) {
      const latest = await this.prisma.marketObservation.findFirst({
        where: { pairAddress },
        orderBy: { receivedAt: "desc" },
        select: { baseAddress: true },
      });
      targets.push({ pairAddress, baseAddress: latest?.baseAddress ?? null });
    }
    return targets;
  }

  private async armProtectionForFill(
    tx: Prisma.TransactionClient,
    input: {
      accountId: string;
      pairAddress: string;
      qty: string;
      config: StrategyConfig;
      markUsd: string | null;
    },
  ): Promise<void> {
    const position = await tx.position.findUnique({
      where: {
        accountId_pairAddress: { accountId: input.accountId, pairAddress: input.pairAddress },
      },
    });
    if (!position || d(position.baseQty.toString()).lte(0)) return;
    let lifecycleId = position.lifecycleId;
    if (!lifecycleId) {
      lifecycleId = newId("lot");
      await tx.position.update({
        where: {
          accountId_pairAddress: { accountId: input.accountId, pairAddress: input.pairAddress },
        },
        data: { lifecycleId },
      });
    }
    const entryPrice =
      input.markUsd && d(input.markUsd).gt(0)
        ? input.markUsd
        : position.avgCostUsd.toString();
    if (!entryPrice || !d(entryPrice).gt(0)) {
      // Urgent recovery: cannot arm without a price — surface safety state.
      await activateSafetyState(tx, {
        accountId: input.accountId,
        code: SAFETY_CODES.PROTECTION_RECOVERY,
        detail: { pairAddress: input.pairAddress, lifecycleId, reason: "MISSING_MARK_FOR_PROTECTION" },
        now: this.now(),
      });
      return;
    }
    const groupId = protectionGroupId(input.accountId, input.pairAddress, lifecycleId);
    const existing = await tx.protectionOrder.count({
      where: { ocoGroupId: groupId, status: "ARMED" },
    });
    if (existing > 0) {
      // Scale protected qty up to current position size on partial adds.
      await tx.protectionOrder.updateMany({
        where: { ocoGroupId: groupId, status: "ARMED" },
        data: {
          protectedQty: position.baseQty.toString(),
          remainingQty: position.baseQty.toString(),
        },
      });
      return;
    }
    const group = armLongShortOco({
      groupId,
      positionKey: buildPositionKey(input.accountId, input.pairAddress),
      direction: "LONG",
      qty: position.baseQty.toString(),
      entryPriceUsd: entryPrice,
      stopLossPct: input.config.stopLossPct,
      takeProfitPct: input.config.takeProfitPct,
      origin: "SYNTHETIC_ENGINE",
    });
    await persistOcoGroup(tx, {
      accountId: input.accountId,
      group,
      lifecycleId,
    });
  }

  private async evaluateProtections(
    tx: Prisma.TransactionClient,
    loaded: {
      marks?: Record<string, { priceUsd: string | null } | undefined>;
      config: StrategyConfig;
    },
    _now: Date,
    ctx: ExecutionContext,
  ): Promise<void> {
    const armed = await tx.protectionOrder.findMany({
      where: { accountId: ctx.accountId, status: "ARMED" },
      distinct: ["ocoGroupId"],
    });
    for (const row of armed) {
      const pair = instrumentIdFromPositionKey(row.positionKey, ctx.accountId);
      if (!pair) continue;
      const mark = loaded.marks?.[pair]?.priceUsd;
      if (!mark) continue;
      // Persist trailing peak/trough; amend STOP/TRAILING triggers only (never TP).
      const trailPct = row.trailPct?.toString() ?? loaded.config.trailingStopPct;
      if (trailPct != null) {
        const direction = (row.direction as "LONG" | "SHORT") || "LONG";
        const trail = updateTrailing({
          direction,
          markUsd: mark,
          extremePriceUsd: row.extremePriceUsd?.toString() ?? null,
          trailPct: String(trailPct),
        });
        await tx.protectionOrder.updateMany({
          where: { ocoGroupId: row.ocoGroupId, status: "ARMED" },
          data: { extremePriceUsd: trail.extremePriceUsd },
        });
        await tx.protectionOrder.updateMany({
          where: {
            ocoGroupId: row.ocoGroupId,
            status: "ARMED",
            kind: { in: ["STOP", "TRAILING"] },
          },
          data: {
            triggerPriceUsd: trail.stopPriceUsd,
            confirmedTriggerPriceUsd: trail.stopPriceUsd,
          },
        });
      }
      const claim = await claimOcoTriggerInTx(tx, {
        ocoGroupId: row.ocoGroupId,
        markUsd: mark,
        workerId: "worker-primary",
      });
      if (!claim.ok) continue;
      // Synthetic exit: propose reduce-only by committing via mark; on failure leave unresolved.
      const position = await tx.position.findFirst({
        where: { accountId: ctx.accountId, pairAddress: pair },
      });
      if (!position || d(position.baseQty.toString()).lte(0)) continue;
      const observation = await tx.marketObservation.findFirst({
        where: {
          pairAddress: pair,
          priceUsd: { not: null },
          tradingEnvironment: ctx.tradingEnvironment,
        },
        orderBy: { receivedAt: "desc" },
      });
      if (!observation) {
        await tx.protectionOrder.updateMany({
          where: { id: claim.claimedLegId },
          data: { status: "FAILED" },
        });
        await tx.protectionIntent.create({
          data: {
            id: newId("protint"),
            accountId: ctx.accountId,
            ocoGroupId: row.ocoGroupId,
            legId: claim.claimedLegId,
            status: "UNRESOLVED",
            reason: "MISSING_PRICE",
            kind: "EXIT_RETRY",
            lifecycleId: row.lifecycleId ?? position.lifecycleId,
            instrumentId: pair,
            retryAfter: new Date(_now.getTime() + 5_000),
            attempts: 1,
          },
        });
        continue;
      }
      try {
        const result = await commitProposedOrder(tx, {
          accountId: ctx.accountId,
          cycleId: `prot_${row.ocoGroupId}`,
          order: {
            clientOrderId: `prot_exit_${claim.claimedLegId}_${_now.getTime()}`,
            pairAddress: pair,
            baseSymbol: position.baseSymbol,
            side: "SELL",
            intent: "EXIT",
            qty: position.baseQty.toString(),
            observationId: observation.id,
            reasonCodes: claim.group.legs.find((l) => l.id === claim.claimedLegId)?.kind === "STOP"
              ? ["STOP_LOSS"]
              : ["TAKE_PROFIT"],
            executionMode: "PAPER",
            venue: "PAPER",
            instrumentId: pair.includes(":") ? pair : null,
          },
          config: loaded.config,
          mode: this.dataMode,
          now: _now,
        });
        if (result.status === "FILLED") {
          await tx.protectionOrder.updateMany({
            where: { id: claim.claimedLegId },
            data: { status: "FILLED" },
          });
        } else if (result.status === "REJECTED" || result.status === "EXPIRED") {
          await tx.protectionOrder.updateMany({
            where: { id: claim.claimedLegId },
            data: { status: "FAILED" },
          });
          await tx.protectionIntent.create({
            data: {
              id: newId("protint"),
              accountId: ctx.accountId,
              ocoGroupId: row.ocoGroupId,
              legId: claim.claimedLegId,
              status: "UNRESOLVED",
              reason: result.reason ?? "PROTECTION_UNRESOLVED",
              kind: "EXIT_RETRY",
              lifecycleId: row.lifecycleId ?? position.lifecycleId,
              instrumentId: pair,
              retryAfter: new Date(_now.getTime() + 5_000),
              attempts: 1,
            },
          });
          await tx.durableAlert.create({
            data: {
              accountId: ctx.accountId,
              severity: "ERROR",
              code: "PROTECTION_EXIT_FAILED",
              message: `Protective exit failed: ${result.reason ?? "unknown"}`,
              acked: false,
              payload: { ocoGroupId: row.ocoGroupId, legId: claim.claimedLegId, unresolved: true },
            },
          });
        }
      } catch (error) {
        await tx.protectionOrder.updateMany({
          where: { id: claim.claimedLegId },
          data: { status: "FAILED" },
        });
        await tx.protectionIntent.create({
          data: {
            id: newId("protint"),
            accountId: ctx.accountId,
            ocoGroupId: row.ocoGroupId,
            legId: claim.claimedLegId,
            status: "UNRESOLVED",
            reason: error instanceof Error ? error.message : "PROTECTION_UNRESOLVED",
            kind: "EXIT_RETRY",
            lifecycleId: row.lifecycleId ?? position.lifecycleId,
            instrumentId: pair,
            retryAfter: new Date(_now.getTime() + 5_000),
            attempts: 1,
          },
        });
      }
    }
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

function observationData(
  cycleId: string,
  pair: NormalizedPair,
  freshness: DataState,
  receivedAt: Date,
  meta?: {
    dataOrigin?: string | null;
    tradingEnvironment?: string | null;
    eventTime?: Date | null;
  },
) {
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
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null,
    fdvUsd: pair.fdvUsd ?? null,
    marketCapUsd: pair.marketCapUsd ?? null,
    freshness,
    dataOrigin: meta?.dataOrigin ?? null,
    tradingEnvironment: meta?.tradingEnvironment ?? null,
    eventTime: meta?.eventTime ?? null,
    receivedAt,
    raw: toJson(pair.raw ?? {}),
  };
}

function toCyclePair(
  row: {
    id: string;
    source: string;
    chainId?: string;
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
    pairCreatedAt?: Date | null;
    fdvUsd?: { toString(): string } | null;
    marketCapUsd?: { toString(): string } | null;
    freshness?: string;
    dataOrigin?: string | null;
    receivedAt: Date;
    raw?: unknown;
  },
  now: Date,
  config: StrategyConfig,
  mode: DataMode,
): CyclePair {
  const source =
    row.source === "birdeye" ||
    row.source === "replay" ||
    row.source === "fx_stub" ||
    row.source === "etf_stub" ||
    row.source === "index_stub" ||
    row.source === "commodity_stub"
      ? row.source
      : "dexscreener";
  const chainId =
    row.chainId === "fx" ||
    row.chainId === "equity" ||
    row.chainId === "commodity" ||
    row.chainId === "solana"
      ? row.chainId
      : source === "fx_stub"
        ? "fx"
        : source === "commodity_stub"
          ? "commodity"
          : source === "etf_stub" || source === "index_stub"
            ? "equity"
            : "solana";
  const provenance = inferObservationProvenance({
    source: row.source,
    freshness: row.freshness,
    dataOrigin: row.dataOrigin,
    raw: row.raw,
  });
  const classified =
    row.freshness === "DEMO" || row.freshness === "DELAYED" || row.freshness === "REPLAY"
      ? (row.freshness as DataState)
      : classifyFreshness({
          mode,
          receivedAt: row.receivedAt,
          now,
          liveMaxAgeMs: config.liveMaxAgeMs,
          delayedMaxAgeMs: config.delayedMaxAgeMs,
        });
  // R09: DELAYED_FEED / frankfurter stay DELAYED — never force DEMO solely because source=fx_stub.
  const freshness = freshnessFromProvenance(provenance, classified);
  return {
    source,
    chainId,
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
    pairCreatedAt: row.pairCreatedAt?.toISOString() ?? null,
    fdvUsd: row.fdvUsd?.toString() ?? null,
    marketCapUsd: row.marketCapUsd?.toString() ?? null,
    observationId: row.id,
    freshness,
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
      inputSource: decision.inputSource ?? null,
      durationMs: decision.durationMs ?? null,
    },
    update: {
      modelVersion: decision.modelVersion,
      decision: decision.decision,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      input: toJson(decision.input),
      output: toJson(decision.output),
      inputSource: decision.inputSource ?? null,
      durationMs: decision.durationMs ?? null,
    },
  });
}

function DecimalMax(left: ReturnType<typeof d>, right: ReturnType<typeof d>) {
  return left.gte(right) ? left : right;
}

function toSecurityAssessment(row: {
  tokenAddress: string;
  category: string;
  confidence: { toString(): string };
  reasonCodes: string[];
  mintAuthority: string;
  freezeAuthority: string;
  transferRestricted: boolean | null;
  holderConcentrationTop10Pct: { toString(): string } | null;
  suspiciousDeployer: boolean | null;
  liquidityFragile: boolean | null;
  largeWalletMove: boolean | null;
  fraudIndicators: string[];
  source: string;
  stale: boolean;
  fields: unknown;
  fetchedAt: Date | null;
}): SecurityAssessment {
  return {
    tokenAddress: row.tokenAddress,
    category: row.category as SecurityAssessment["category"],
    confidence: row.confidence.toString(),
    reasonCodes: row.reasonCodes as SecurityAssessment["reasonCodes"],
    mintAuthority: row.mintAuthority as SecurityAssessment["mintAuthority"],
    freezeAuthority: row.freezeAuthority as SecurityAssessment["freezeAuthority"],
    transferRestricted: row.transferRestricted,
    token2022Extensions: null,
    holderConcentrationTop10Pct: row.holderConcentrationTop10Pct?.toString() ?? null,
    suspiciousDeployer: row.suspiciousDeployer,
    liquidityFragile: row.liquidityFragile,
    largeWalletMove: row.largeWalletMove,
    fraudIndicators: row.fraudIndicators,
    source: row.source as SecurityAssessment["source"],
    fetchedAt: row.fetchedAt?.toISOString() ?? null,
    stale: row.stale,
    fields: (row.fields ?? {}) as SecurityAssessment["fields"],
  };
}

export const liveFeed: MarketFeed = {
  fetchUniverse(limit) {
    return fetchSolanaUniverse({ limit });
  },
};
