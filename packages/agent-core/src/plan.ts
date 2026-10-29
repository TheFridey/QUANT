import { valuePortfolio } from "@odin/analytics";
import { evaluateCircuitBreaker, evaluateRisk, evaluateRiskHierarchy } from "@odin/risk-engine";
import {
  clientOrderIdFor,
  d,
  entriesAllowedInSession,
  findInstrument,
  intentIdFor,
  intentIdempotencyKey,
  type CyclePair,
  type OrderIntent,
  type OrderOwnerScope,
  type OrderSide,
  type ReasonCode,
  type SecurityAssessment,
  type TradeIntentAction,
  type TradeIntentSource,
} from "@odin/shared";
import {
  admitNotionalAgainstMinOrder,
  applyFill,
  maxEntryNotional,
  qtyForNotional,
  quoteFill,
  type BookState,
} from "@odin/trading-engine";
import { runAegis } from "./aegis.js";
import { computeResearchMetrics } from "./archivist.js";
import { isAutomaticEntryEnabled, resolveMarketInstrumentId } from "./market-admission.js";
import { runPulse } from "./pulse.js";
import { rankWatchlist, runSentinel } from "./sentinel.js";
import {
  isIntent,
  type DecisionDraft,
  type IntentOutcome,
  type PlanInput,
  type PlanIntent,
  type PositionView,
  type ProposedOrder,
} from "./types.js";
import { MODEL_VERSIONS } from "./versions.js";

export type { DecisionDraft, IntentOutcome, PlanInput, PlanIntent, PositionView, ProposedOrder } from "./types.js";

type Identity = {
  intentId: string;
  idempotencyKey: string;
  clientOrderId: string;
  source: TradeIntentSource;
  action: TradeIntentAction;
  ownerScope: OrderOwnerScope;
  strategyInstanceId: string | null;
  strategyVersion: string | null;
};

export function planCycle(input: PlanInput): {
  decisions: DecisionDraft[];
  orders: ProposedOrder[];
  watchlist: ReturnType<typeof rankWatchlist>;
  intentOutcomes: IntentOutcome[];
} {
  const now = input.now ?? new Date();
  const decisions: DecisionDraft[] = [];
  const orders: ProposedOrder[] = [];
  const intentOutcomes: IntentOutcome[] = [];
  const sentinel = new Map<string, DecisionDraft>();
  const pulses = new Map<string, DecisionDraft>();
  const candidates = [];

  for (const pair of input.pairs) {
    const surveillance = runSentinel(pair, input.config, now);
    sentinel.set(pair.pairAddress, surveillance.decision);
    decisions.push(surveillance.decision);
    candidates.push(surveillance.candidate);
    const pulse = runPulse(pair, findPosition(input.positions, pair.pairAddress), surveillance.decision, input);
    pulses.set(pair.pairAddress, pulse);
    decisions.push(pulse);
  }

  const watchlist = rankWatchlist(candidates, input.config.universeLimit);

  if (input.operator && !input.pairs.some((pair) => pair.pairAddress === input.operator?.pairAddress)) {
    decisions.push(row("SENTINEL", input.operator.pairAddress, "REJECT", ["PAIR_NOT_IN_SNAPSHOT"], "1.000000"));
    decisions.push(row("EXECUTOR", input.operator.pairAddress, "HOLD", ["NO_ORDER", "PAIR_NOT_IN_SNAPSHOT"], "1.000000"));
  }
  if (input.flatten) {
    for (const position of input.positions.filter((item) => d(item.baseQty).gt(0))) {
      if (!input.pairs.some((pair) => pair.pairAddress === position.pairAddress)) {
        decisions.push(row("EXECUTOR", position.pairAddress, "REJECT", ["FLATTEN_BLOCKED", "PAIR_NOT_IN_SNAPSHOT"], "1.000000"));
      }
    }
  }

  let book: BookState = { cashUsd: input.cashUsd, positions: input.positions.map((position) => ({ ...position })) };
  let dailyPnl = input.dailyPnlUsd;
  let aggregateExposure = input.aggregateExposureUsd ?? "0";
  const ordered = [...input.pairs].sort((left, right) => rank(pulses.get(left.pairAddress)) - rank(pulses.get(right.pairAddress)));

  const valuedSeed = valuePortfolio({ cashUsd: book.cashUsd, positions: book.positions, marks: input.marks });
  const breaker = evaluateCircuitBreaker({
    dailyPnlUsd: dailyPnl,
    startingBalanceUsd: input.startingBalanceUsd,
    maxDailyLossPct: input.config.maxDailyLossPct,
    equityUsd: valuedSeed.equityUsd,
    highWaterMarkUsd: input.highWaterMarkUsd ?? valuedSeed.equityUsd,
    maxTotalDrawdownPct: input.config.maxTotalDrawdownPct,
  });
  // Hierarchy snapshot for diagnostics — ACK never clears breaker/suspension ranks.
  const riskHierarchy = evaluateRiskHierarchy({
    engineStatus: input.engineStatus,
    circuitBreakerOpen: breaker.open,
    circuitBreakerReasons: breaker.reasonCodes,
    entriesSuspended: input.entriesSuspended === true,
    pauseNewEntries: input.config.pauseNewEntries === true,
  });

  const applyExecuted = (
    executed: ReturnType<typeof executeOrder>,
    side: OrderSide,
    pair: CyclePair,
    qty: string,
  ) => {
    decisions.push(executed.decision);
    if (!executed.order) return false;
    orders.push(executed.order);
    if (executed.book) {
      book = executed.book;
      if (side === "BUY" && pair.priceUsd) {
        aggregateExposure = d(aggregateExposure).plus(d(qty).mul(d(pair.priceUsd))).toFixed(8);
      }
      if (side === "SELL" && pair.priceUsd) {
        // Release in-cycle capacity when a sell completes in the simulated book.
        aggregateExposure = DecimalMax0(d(aggregateExposure).minus(d(qty).mul(d(pair.priceUsd)))).toFixed(8);
      }
      if (dailyPnl !== null && executed.realizedPnlUsd) {
        dailyPnl = d(dailyPnl).plus(d(executed.realizedPnlUsd)).toFixed(8);
      }
    }
    return true;
  };

  const riskFor = (pair: CyclePair, side: OrderSide, intent: OrderIntent, proposedNotional: string | null) => {
    const valued = valuePortfolio({ cashUsd: book.cashUsd, positions: book.positions, marks: input.marks });
    const openPositions = book.positions.filter((position) => d(position.baseQty).gt(0)).length;
    const risk = evaluateRisk({
      engineStatus: input.engineStatus,
      side,
      intent,
      freshness: pair.freshness,
      allowDelayedExits: input.config.allowDelayedExits,
      allowDemoPaperEntries: input.config.allowDemoPaperEntries,
      pauseNewEntries: input.config.pauseNewEntries,
      entriesSuspended: input.entriesSuspended === true,
      openPositions,
      maxPositions: input.config.maxPositions,
      dailyPnlUsd: dailyPnl,
      startingBalanceUsd: input.startingBalanceUsd,
      maxDailyLossPct: input.config.maxDailyLossPct,
      valuation: valued.valuation,
      equityUsd: valued.equityUsd,
      highWaterMarkUsd: input.highWaterMarkUsd ?? valued.equityUsd,
      maxTotalDrawdownPct: input.config.maxTotalDrawdownPct,
      aggregateExposureUsd: aggregateExposure,
      proposedNotionalUsd: proposedNotional,
      maxAggregateExposurePct: input.config.maxAggregateExposurePct,
      circuitBreakerOpen: breaker.open,
    });
    return { risk, valued, openPositions };
  };

  const accountCap = (pair: CyclePair, equityUsd: string | null) =>
    pair.priceUsd && equityUsd
      ? maxEntryNotional({
          cashUsd: book.cashUsd,
          equityUsd,
          liquidityUsd: pair.liquidityUsd ?? "0",
          maxPositionPctEquity: input.config.maxPositionPctEquity,
          maxParticipationPctLiquidity: input.config.maxParticipationPctLiquidity,
          feeBps: input.config.feeBps,
          maxSlippageBps: input.config.maxSlippageBps,
          maxRiskPerTradePct: input.config.maxRiskPerTradePct,
          stopLossPct: input.config.stopLossPct,
          midPriceUsd: pair.priceUsd,
          maxAggregateExposurePct: input.config.maxAggregateExposurePct,
          aggregateExposureUsd: aggregateExposure,
          maxPriceImpactBps: input.config.maxPriceImpactBps,
        })
      : null;

  // Pairs closed at net level this cycle (flatten / protective / operator net) — owner exits wait.
  const netClosedThisCycle = new Set<string>();
  const inCycleExitQty = new Map<string, ReturnType<typeof d>>();

  for (const pair of ordered) {
    const pulse = pulses.get(pair.pairAddress);
    if (!pulse) continue;
    const side = pulse.output.side;
    const intent = pulse.output.intent;
    if (pulse.decision !== "ACT" || (side !== "BUY" && side !== "SELL") || !isIntent(intent)) {
      const aegis = runAegis({
        pair,
        assessment: securityFor(input, pair),
        hasIntent: false,
        side: null,
      });
      decisions.push(aegis.decision);
      decisions.push(row("ATLAS", pair.pairAddress, "HOLD", ["NO_INTENT"], "1.000000", {}, {}, "portfolio:idle"));
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000"));
      continue;
    }

    const aegis = runAegis({
      pair,
      assessment: securityFor(input, pair),
      hasIntent: true,
      side,
    });
    decisions.push(aegis.decision);
    if (aegis.blocksEntry) {
      decisions.push(row("ATLAS", pair.pairAddress, "HOLD", ["NO_INTENT"], "1.000000", { blockedBy: "AEGIS" }, {}, "portfolio:blocked"));
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000", { blockedBy: "AEGIS" }));
      continue;
    }

    const valuedNow = valuePortfolio({ cashUsd: book.cashUsd, positions: book.positions, marks: input.marks });
    const proposedNotional = side === "BUY" ? accountCap(pair, valuedNow.equityUsd) : null;
    const { risk, valued, openPositions } = riskFor(pair, side, intent, proposedNotional);

    const atlasStarted = Date.now();
    if (risk.decision !== "PASS") {
      decisions.push(
        row("ATLAS", pair, "REJECT", risk.reasonCodes, risk.confidence, {}, {
          freshness: pair.freshness,
          valuation: valued.valuation,
          dailyPnlUsd: dailyPnl,
          openPositions,
          circuitBreaker: breaker,
          riskHierarchy: {
            dominantHard: riskHierarchy.dominantHard?.kind ?? null,
            blocksNewEntries: riskHierarchy.blocksNewEntries,
          },
        }, "portfolio:risk", Date.now() - atlasStarted),
      );
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000", { blockedBy: "ATLAS" }));
      continue;
    }

    // Session gate for registered multi-market instruments — BUY entries only; exits still flow.
    if (side === "BUY" && intent === "ENTRY") {
      const instrument = findInstrument(pair.pairAddress);
      if (instrument && !entriesAllowedInSession(instrument.session, now)) {
        decisions.push(
          row(
            "ATLAS",
            pair.pairAddress,
            "REJECT",
            ["SESSION_CLOSED"],
            "1.000000",
            {},
            { session: instrument.session, riskHierarchy: riskHierarchy.dominantHard?.kind ?? null },
            "portfolio:session",
          ),
        );
        decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000", { blockedBy: "ATLAS" }));
        continue;
      }
    }

    // MarketSelection: block new automatic ENTRY for disabled markets; exits still flow (D15).
    if (side === "BUY" && intent === "ENTRY" && !isAutomaticEntryEnabled(pair, input.marketEntryEnabled)) {
      decisions.push(
        row(
          "ATLAS",
          pair.pairAddress,
          "HOLD",
          ["MARKET_ENTRY_DISABLED"],
          "1.000000",
          { blockedBy: "MARKET_SELECTION" },
          { instrumentId: resolveMarketInstrumentId(pair) },
          "market-selection:admission",
        ),
      );
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000", { blockedBy: "MARKET_SELECTION" }));
      continue;
    }

    const identity = globalIdentity(input, pair.pairAddress, side, intent);
    const sized = sizeOrder(pair, book, input, side, intent, valued.equityUsd, aggregateExposure, identity);
    decisions.push({
      ...sized.decision,
      inputSource: sized.decision.inputSource ?? "portfolio:sizing",
      durationMs: sized.decision.durationMs ?? Date.now() - atlasStarted,
    });
    if (sized.decision.decision !== "ACT" || !sized.qty) {
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000"));
      intentOutcomes.push(outcomeFor(identity, pair.pairAddress, "REJECTED", sized.decision.reasonCodes[0] ?? "NO_ORDER"));
      continue;
    }
    const executed = executeOrder(pair, side, intent, sized.qty, book, input.config, now, identity);
    const placed = applyExecuted(executed, side, pair, sized.qty);
    if (placed && side === "SELL" && identity.ownerScope !== "STRATEGY") netClosedThisCycle.add(pair.pairAddress);
    if (placed && side === "SELL" && identity.ownerScope === "STRATEGY" && identity.strategyInstanceId) {
      const key = `${identity.strategyInstanceId}::${pair.pairAddress}`;
      inCycleExitQty.set(key, (inCycleExitQty.get(key) ?? d("0")).plus(d(executed.order!.qty)));
    }
    intentOutcomes.push(
      outcomeFor(
        identity,
        pair.pairAddress,
        placed ? "ADMITTED" : "REJECTED",
        placed ? "INTENT_ADMITTED" : (executed.decision.reasonCodes[0] ?? "REJECTED"),
        placed ? (executed.order?.qty ?? null) : null,
        placed ? (executed.order?.estimatedNotionalUsd ?? null) : null,
      ),
    );
  }

  if (input.instanceIntents) {
    planInstanceIntents(input.instanceIntents);
  }

  function planInstanceIntents(intents: readonly PlanIntent[]) {
    const pairsByAddress = new Map(input.pairs.map((pair) => [pair.pairAddress, pair] as const));
    const instanceSpent = new Map<string, ReturnType<typeof d>>();
    const enteredKeys = new Set<string>();
    const pairsEntered = new Set<string>();
    let entrySlots = Math.max(0, input.maxNewEntries ?? Number.POSITIVE_INFINITY);

    for (const planned of intents) {
      const key = `${planned.strategyInstanceId}::${planned.pairAddress}`;
      const identity: Identity = {
        intentId: planned.intentId,
        idempotencyKey: planned.idempotencyKey,
        clientOrderId: planned.clientOrderId,
        source: "STRATEGY",
        action: planned.action,
        ownerScope: "STRATEGY",
        strategyInstanceId: planned.strategyInstanceId,
        strategyVersion: planned.strategyVersion,
      };
      const audit = {
        intentId: planned.intentId,
        strategyInstanceId: planned.strategyInstanceId,
        strategyVersion: planned.strategyVersion,
        action: planned.action,
      };
      const settle = (
        status: IntentOutcome["status"],
        reason: ReasonCode,
        qty: string | null = null,
        notional: string | null = null,
      ) => {
        intentOutcomes.push(outcomeFor(identity, planned.pairAddress, status, reason, qty, notional));
        if (status !== "ADMITTED") {
          decisions.push(
            row("ATLAS", planned.pairAddress, status === "DEFERRED" ? "HOLD" : "REJECT", [reason], "1.000000", audit, {}, "strategy-instances:admission"),
          );
        }
      };
      const pair = pairsByAddress.get(planned.pairAddress);
      if (!pair) {
        settle("REJECTED", "PAIR_NOT_IN_SNAPSHOT");
        continue;
      }
      const position = findPosition(book.positions, pair.pairAddress);

      if (planned.action === "EXIT" || planned.action === "REDUCE") {
        if (netClosedThisCycle.has(pair.pairAddress) || input.pendingNetCloseByPair?.has(pair.pairAddress)) {
          settle("DEFERRED", "NET_CLOSE_IN_FLIGHT");
          continue;
        }
        const allocation = input.allocations?.get(key);
        const ownedQty = allocation ? d(allocation.qty) : d("0");
        if (ownedQty.lte(0)) {
          settle("REJECTED", "ALLOCATION_NOT_OWNED");
          continue;
        }
        const available = ownedQty
          .minus(d(allocation?.reservedExitQty ?? "0"))
          .minus(inCycleExitQty.get(key) ?? d("0"));
        if (available.lte(0)) {
          settle("DEFERRED", "EXIT_QTY_RESERVED");
          continue;
        }
        let exitQty = available;
        if (planned.action === "REDUCE" && planned.requestedQty && d(planned.requestedQty).gt(0)) {
          exitQty = Decimal.minOf(exitQty, d(planned.requestedQty));
        }
        const venueQty = position ? d(position.baseQty) : d("0");
        if (venueQty.lte(0)) {
          settle("REJECTED", "NO_POSITION");
          continue;
        }
        if (exitQty.gt(venueQty)) exitQty = venueQty;
        const { risk } = riskFor(pair, "SELL", "EXIT", null);
        if (risk.decision !== "PASS") {
          settle("REJECTED", risk.reasonCodes[0] ?? "REJECTED");
          continue;
        }
        const qtyText = exitQty.toFixed(8);
        decisions.push(
          row("ATLAS", pair, "ACT", ["SIZE_COMPUTED", "ALLOCATION_EXIT"], "1.000000", {
            ...audit,
            side: "SELL",
            intent: "EXIT",
            qty: qtyText,
            ownedQty: ownedQty.toFixed(8),
            venueQty: venueQty.toFixed(8),
          }, {}, "portfolio:sizing"),
        );
        const executed = executeOrder(pair, "SELL", "EXIT", qtyText, book, input.config, now, identity);
        if (applyExecuted(executed, "SELL", pair, qtyText)) {
          inCycleExitQty.set(key, (inCycleExitQty.get(key) ?? d("0")).plus(d(executed.order!.qty)));
          settle("ADMITTED", "INTENT_ADMITTED", executed.order!.qty, executed.order!.estimatedNotionalUsd ?? null);
        } else {
          settle("REJECTED", executed.decision.reasonCodes[0] ?? "REJECTED");
        }
        continue;
      }

      // ENTER
      if (sentinel.get(pair.pairAddress)?.decision === "REJECT") {
        settle("REJECTED", "BLOCKED_BY_SENTINEL");
        continue;
      }
      const aegis = runAegis({ pair, assessment: securityFor(input, pair), hasIntent: true, side: "BUY" });
      if (aegis.blocksEntry) {
        settle("REJECTED", aegis.decision.reasonCodes[0] ?? "SECURITY_BLOCK");
        continue;
      }
      const owned = input.allocations?.get(key);
      if (enteredKeys.has(key) || (owned && d(owned.qty).gt(0))) {
        settle("REJECTED", "INSTANCE_ALREADY_OWNS");
        continue;
      }
      if (input.pendingEntryKeys?.has(key)) {
        settle("REJECTED", "PENDING_ENTRY_IN_FLIGHT");
        continue;
      }
      const valuedNow = valuePortfolio({ cashUsd: book.cashUsd, positions: book.positions, marks: input.marks });
      const cap = accountCap(pair, valuedNow.equityUsd);
      const { risk } = riskFor(pair, "BUY", "ENTRY", cap);
      if (risk.decision !== "PASS") {
        settle("REJECTED", risk.reasonCodes[0] ?? "REJECTED");
        continue;
      }
      const instrument = findInstrument(pair.pairAddress);
      if (instrument && !entriesAllowedInSession(instrument.session, now)) {
        settle("REJECTED", "SESSION_CLOSED");
        continue;
      }
      if (!isAutomaticEntryEnabled(pair, input.marketEntryEnabled)) {
        settle("REJECTED", "MARKET_ENTRY_DISABLED");
        continue;
      }
      // A slot is a new NET position; joining a pair another owner already holds does not open one.
      const opensNetPosition = (!position || d(position.baseQty).lte(0)) && !pairsEntered.has(pair.pairAddress);
      if (opensNetPosition && entrySlots <= 0) {
        settle("DEFERRED", "WAITING_FAIR_ALLOCATION");
        continue;
      }
      if (pair.priceUsd === null || pair.liquidityUsd === null || valuedNow.equityUsd === null || cap === null) {
        settle("REJECTED", "MARK_UNAVAILABLE");
        continue;
      }
      if (d(pair.liquidityUsd).lt(input.config.minLiquidityUsd)) {
        settle("REJECTED", "LIQUIDITY_FLOOR");
        continue;
      }
      // Instance capital: budget − filled − pending − this cycle. Missing = fail closed.
      const instanceAvailable = input.instanceAvailableUsd
        ? d(input.instanceAvailableUsd.get(planned.strategyInstanceId) ?? "0").minus(
            instanceSpent.get(planned.strategyInstanceId) ?? d("0"),
          )
        : null;
      let notional = d(cap);
      let resized = false;
      if (instanceAvailable !== null) {
        const costMultiplier = d("1")
          .plus(d(input.config.maxSlippageBps).div("10000"))
          .mul(d("1").plus(d(input.config.feeBps).div("10000")));
        const instanceCap = instanceAvailable.gt(0) ? instanceAvailable.div(costMultiplier) : d("0");
        if (instanceCap.lt(notional)) {
          notional = instanceCap;
          resized = true;
        }
      }
      const admitted = admitNotionalAgainstMinOrder({
        riskSizedNotionalUsd: notional.toFixed(8),
        minOrderNotionalUsd: input.config.minOrderNotionalUsd,
      });
      if (!admitted.ok) {
        settle("REJECTED", resized ? "INSTANCE_BUDGET_EXHAUSTED" : admitted.reason);
        continue;
      }
      const qtyText = qtyForNotional(admitted.notionalUsd, pair.priceUsd);
      if (d(qtyText).lte(0)) {
        settle("REJECTED", "SIZE_ZERO");
        continue;
      }
      decisions.push(
        row(
          "ATLAS",
          pair,
          "ACT",
          resized
            ? ["SIZE_COMPUTED", "INSTANCE_BUDGET_RESIZED", "COST_ESTIMATED"]
            : ["SIZE_COMPUTED", "STOP_DISTANCE_SIZE", "RISK_PER_TRADE", "COST_ESTIMATED"],
          "1.000000",
          {
            ...audit,
            side: "BUY",
            intent: "ENTRY",
            qty: qtyText,
            notionalUsd: admitted.notionalUsd,
            accountCapUsd: cap,
            instanceAvailableUsd: instanceAvailable?.toFixed(8) ?? null,
          },
          {},
          "portfolio:sizing",
        ),
      );
      const executed = executeOrder(pair, "BUY", "ENTRY", qtyText, book, input.config, now, identity);
      const cost = executed.order?.estimatedCostUsd;
      if (executed.order && instanceAvailable !== null && cost && d(cost).gt(instanceAvailable)) {
        settle("REJECTED", "INSTANCE_BUDGET_EXHAUSTED");
        continue;
      }
      if (!applyExecuted(executed, "BUY", pair, qtyText)) {
        settle("REJECTED", executed.decision.reasonCodes[0] ?? "REJECTED");
        continue;
      }
      enteredKeys.add(key);
      pairsEntered.add(pair.pairAddress);
      if (opensNetPosition) entrySlots -= 1;
      instanceSpent.set(
        planned.strategyInstanceId,
        (instanceSpent.get(planned.strategyInstanceId) ?? d("0")).plus(d(cost ?? admitted.notionalUsd)),
      );
      settle("ADMITTED", resized ? "INSTANCE_BUDGET_RESIZED" : "INTENT_ADMITTED", executed.order!.qty, executed.order!.estimatedNotionalUsd ?? null);
    }
  }

  const metrics = computeResearchMetrics({
    decisions,
    orders: orders.length,
    startingBalanceUsd: input.startingBalanceUsd,
    cashUsd: book.cashUsd,
    positions: book.positions,
    marks: input.marks,
  });
  decisions.push(
    row(
      "ARCHIVIST",
      "",
      "PASS",
      metrics.reasonCodes,
      "1.000000",
      {
        decisions: decisions.length + 1,
        orders: orders.length,
        watchlistSize: watchlist.length,
        intents: intentOutcomes.length,
        metrics,
      },
      { circuitBreaker: breaker },
      "ledger+decisions",
    ),
  );
  return { decisions: mergeDecisions(decisions), orders, watchlist, intentOutcomes };
}

/**
 * AgentDecision is unique per (cycle, agent, pair). Several independent intents on one pair
 * each produce ATLAS/EXECUTOR rows; merge them so the persisted row keeps every intent
 * (`output.intents`) instead of the last writer silently overwriting earlier ones.
 */
export function mergeDecisions(decisions: DecisionDraft[]): DecisionDraft[] {
  const merged: DecisionDraft[] = [];
  const index = new Map<string, number>();
  for (const decision of decisions) {
    const key = `${decision.agent}\u0000${decision.pairAddress}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, merged.length);
      merged.push(decision);
      continue;
    }
    const prior = merged[at]!;
    const priorIntents = Array.isArray(prior.output.intents)
      ? (prior.output.intents as unknown[])
      : [{ decision: prior.decision, reasonCodes: prior.reasonCodes, ...prior.output }];
    const primary = decisionRank(decision.decision) > decisionRank(prior.decision) ? decision : prior;
    merged[at] = {
      ...primary,
      reasonCodes: [...new Set([...prior.reasonCodes, ...decision.reasonCodes])],
      output: {
        ...primary.output,
        intents: [...priorIntents, { decision: decision.decision, reasonCodes: decision.reasonCodes, ...decision.output }],
      },
      durationMs: (prior.durationMs ?? 0) + (decision.durationMs ?? 0),
    };
  }
  return merged;
}

function decisionRank(value: DecisionDraft["decision"]): number {
  return value === "ACT" ? 3 : value === "REJECT" ? 2 : value === "HOLD" ? 1 : 0;
}

/** Identity for pair-level (non-instance) orders: operator, flatten, protective/net close, legacy entry. */
function globalIdentity(input: PlanInput, pairAddress: string, side: OrderSide, intent: OrderIntent): Identity {
  const accountId = input.accountId ?? "account";
  let source: TradeIntentSource;
  let action: TradeIntentAction;
  let ownerScope: OrderOwnerScope;
  let ownerRef: string;
  let strategyInstanceId: string | null = null;
  if (intent === "FLATTEN") {
    source = "ACCOUNT_FLATTEN";
    action = "FLATTEN";
    ownerScope = "ACCOUNT_FLATTEN";
    ownerRef = "flatten";
  } else if (intent === "OPERATOR") {
    source = "OPERATOR";
    ownerRef = input.operator?.clientIntentId ?? input.cycleId;
    const op = input.operator;
    if (side === "SELL" && op?.side === "SELL" && op.scope === "ALLOCATION" && op.strategyInstanceId) {
      action = op.qty ? "REDUCE" : "EXIT";
      ownerScope = "STRATEGY";
      strategyInstanceId = op.strategyInstanceId;
    } else {
      action = side === "BUY" ? "ENTER" : "CLOSE_NET";
      ownerScope = "OPERATOR";
    }
  } else if (side === "SELL") {
    source = "NET_CLOSE";
    action = "CLOSE_NET";
    ownerScope = "NET_CLOSE";
    ownerRef = "net";
  } else {
    source = "STRATEGY";
    action = "ENTER";
    ownerScope = "LEGACY";
    ownerRef = input.activeStrategyId ? `global:${input.activeStrategyId}` : "global:pulse";
  }
  const idempotencyKey = intentIdempotencyKey({ cycleId: input.cycleId, accountId, source, ownerRef, pairAddress, action });
  return {
    intentId: intentIdFor(idempotencyKey),
    idempotencyKey,
    clientOrderId: clientOrderIdFor(idempotencyKey),
    source,
    action,
    ownerScope,
    strategyInstanceId,
    strategyVersion: null,
  };
}

function outcomeFor(
  identity: Identity,
  pairAddress: string,
  status: IntentOutcome["status"],
  reason: string,
  sizedQty: string | null = null,
  sizedNotionalUsd: string | null = null,
): IntentOutcome {
  return {
    intentId: identity.intentId,
    idempotencyKey: identity.idempotencyKey,
    clientOrderId: identity.clientOrderId,
    strategyInstanceId: identity.strategyInstanceId,
    pairAddress,
    action: identity.action,
    status,
    reason,
    sizedQty,
    sizedNotionalUsd,
  };
}

function securityFor(input: PlanInput, pair: CyclePair): SecurityAssessment | null {
  return input.securityByMint?.[pair.baseAddress] ?? null;
}

function sizeOrder(
  pair: CyclePair,
  book: BookState,
  input: PlanInput,
  side: OrderSide,
  intent: OrderIntent,
  equityUsd: string | null,
  aggregateExposureUsd: string,
  identity: Identity,
): { decision: DecisionDraft; qty: string | null } {
  const started = Date.now();
  if (side === "SELL") {
    const position = findPosition(book.positions, pair.pairAddress);
    if (!position || d(position.baseQty).lte(0)) {
      return {
        qty: null,
        decision: row("ATLAS", pair, "REJECT", ["NO_POSITION"], "1.000000", {}, {}, "portfolio:sizing", Date.now() - started),
      };
    }
    // Operator close of one owner's allocation: never more than that owner's unreserved quantity.
    if (identity.ownerScope === "STRATEGY" && identity.strategyInstanceId) {
      const allocation = input.allocations?.get(`${identity.strategyInstanceId}::${pair.pairAddress}`);
      const available = allocation ? d(allocation.qty).minus(d(allocation.reservedExitQty)) : d("0");
      if (available.lte(0)) {
        return {
          qty: null,
          decision: row(
            "ATLAS",
            pair,
            "REJECT",
            [allocation && d(allocation.qty).gt(0) ? "EXIT_QTY_RESERVED" : "ALLOCATION_NOT_OWNED"],
            "1.000000",
            { side, intent, strategyInstanceId: identity.strategyInstanceId },
            {},
            "portfolio:sizing",
            Date.now() - started,
          ),
        };
      }
      const op = input.operator;
      let exitQty = available;
      if (op?.side === "SELL" && op.qty && d(op.qty).gt(0)) exitQty = Decimal.minOf(exitQty, d(op.qty));
      if (exitQty.gt(d(position.baseQty))) exitQty = d(position.baseQty);
      return {
        qty: exitQty.toFixed(8),
        decision: row(
          "ATLAS",
          pair,
          "ACT",
          ["SIZE_COMPUTED", "ALLOCATION_EXIT"],
          "1.000000",
          { side, intent, qty: exitQty.toFixed(8), strategyInstanceId: identity.strategyInstanceId, venueQty: position.baseQty },
          {},
          "portfolio:sizing",
          Date.now() - started,
        ),
      };
    }
    return {
      qty: position.baseQty,
      decision: row(
        "ATLAS",
        pair,
        "ACT",
        ["SIZE_COMPUTED", "FULL_POSITION_EXIT"],
        "1.000000",
        { side, intent, qty: position.baseQty, ownerScope: identity.ownerScope },
        {},
        "portfolio:sizing",
        Date.now() - started,
      ),
    };
  }
  if (pair.priceUsd === null || pair.liquidityUsd === null || equityUsd === null) {
    return {
      qty: null,
      decision: row("ATLAS", pair, "REJECT", ["MARK_UNAVAILABLE"], "0.000000", {}, {}, "portfolio:sizing", Date.now() - started),
    };
  }
  if (d(pair.liquidityUsd).lt(input.config.minLiquidityUsd)) {
    return {
      qty: null,
      decision: row("ATLAS", pair, "REJECT", ["LIQUIDITY_FLOOR"], "1.000000", {}, {}, "portfolio:sizing", Date.now() - started),
    };
  }
  const cap = maxEntryNotional({
    cashUsd: book.cashUsd,
    equityUsd,
    liquidityUsd: pair.liquidityUsd,
    maxPositionPctEquity: input.config.maxPositionPctEquity,
    maxParticipationPctLiquidity: input.config.maxParticipationPctLiquidity,
    feeBps: input.config.feeBps,
    maxSlippageBps: input.config.maxSlippageBps,
    maxRiskPerTradePct: input.config.maxRiskPerTradePct,
    stopLossPct: input.config.stopLossPct,
    midPriceUsd: pair.priceUsd,
    maxAggregateExposurePct: input.config.maxAggregateExposurePct,
    aggregateExposureUsd,
    maxPriceImpactBps: input.config.maxPriceImpactBps,
  });
  let notional = cap;
  if (intent === "OPERATOR" && input.operator?.side === "BUY") {
    if (d(input.operator.notionalUsd).gt(d(cap))) {
      return {
        qty: null,
        decision: row(
          "ATLAS",
          pair,
          "REJECT",
          ["SIZE_ABOVE_CAP"],
          "1.000000",
          { maxNotionalUsd: cap },
          {},
          "portfolio:sizing",
          Date.now() - started,
        ),
      };
    }
    notional = input.operator.notionalUsd;
  }
  const admitted = admitNotionalAgainstMinOrder({
    riskSizedNotionalUsd: notional,
    minOrderNotionalUsd: input.config.minOrderNotionalUsd,
  });
  if (!admitted.ok) {
    return {
      qty: null,
      decision: row(
        "ATLAS",
        pair,
        "REJECT",
        [admitted.reason],
        "1.000000",
        { notionalUsd: notional, minOrderNotionalUsd: input.config.minOrderNotionalUsd, maxNotionalUsd: cap },
        {},
        "portfolio:sizing",
        Date.now() - started,
      ),
    };
  }
  notional = admitted.notionalUsd;
  const quantity = qtyForNotional(notional, pair.priceUsd);
  if (d(quantity).lte(0)) {
    return {
      qty: null,
      decision: row("ATLAS", pair, "REJECT", ["SIZE_ZERO"], "1.000000", {}, {}, "portfolio:sizing", Date.now() - started),
    };
  }
  return {
    qty: quantity,
    decision: row(
      "ATLAS",
      pair,
      "ACT",
      ["SIZE_COMPUTED", "STOP_DISTANCE_SIZE", "RISK_PER_TRADE", "COST_ESTIMATED"],
      "1.000000",
      { side, intent, qty: quantity, notionalUsd: notional },
      {},
      "portfolio:sizing",
      Date.now() - started,
    ),
  };
}

function executeOrder(
  pair: CyclePair,
  side: OrderSide,
  intent: OrderIntent,
  quantity: string,
  book: BookState,
  config: PlanInput["config"],
  now: Date,
  identity: Identity,
): { decision: DecisionDraft; order?: ProposedOrder; book?: BookState; realizedPnlUsd?: string } {
  const started = Date.now();
  const audit = {
    intentId: identity.intentId,
    clientOrderId: identity.clientOrderId,
    ownerScope: identity.ownerScope,
    strategyInstanceId: identity.strategyInstanceId,
  };
  if (pair.priceUsd === null || pair.liquidityUsd === null) {
    return {
      decision: row("EXECUTOR", pair, "REJECT", ["MISSING_PRICE"], "0.000000", audit, {}, "quote", Date.now() - started),
    };
  }
  if (d(quantity).lte(0)) {
    return {
      decision: row("EXECUTOR", pair, "REJECT", ["NON_POSITIVE_QTY"], "1.000000", audit, {}, "quote", Date.now() - started),
    };
  }
  const quoted = quoteFill({
    side,
    midPriceUsd: pair.priceUsd,
    quantity,
    liquidityUsd: pair.liquidityUsd,
    feeBps: config.feeBps,
    maxSlippageBps: config.maxSlippageBps,
    spreadBpsEstimate: config.spreadBpsEstimate,
    maxPriceImpactBps: config.maxPriceImpactBps,
  });
  if (!quoted.ok) {
    return {
      decision: row("EXECUTOR", pair, "REJECT", [quoted.reason], "1.000000", audit, {}, "quote", Date.now() - started),
    };
  }

  const eligibleAt = new Date(now.getTime() + config.paperLatencyMs);
  const expiresAt = new Date(eligibleAt.getTime() + config.orderExpiryMs);
  const deferFill = config.paperLatencyMs > 0;
  let nextBook = book;
  let realizedPnlUsd: string | undefined;
  if (!deferFill) {
    const applied = applyFill(book, {
      pairAddress: pair.pairAddress,
      baseSymbol: pair.baseSymbol,
      side,
      fill: quoted.fill,
    });
    if (!applied.ok) {
      return {
        decision: row("EXECUTOR", pair, "REJECT", [applied.reason], "1.000000", audit, {}, "quote", Date.now() - started),
      };
    }
    nextBook = applied.state;
    realizedPnlUsd = applied.realizedPnlUsd;
  }
  const reasonCodes: ReasonCode[] = ["ORDER_PROPOSED", "COST_ESTIMATED", "SPREAD_APPLIED"];
  if (deferFill) reasonCodes.push("ORDER_PENDING");
  const estimatedCostUsd =
    side === "BUY"
      ? d(quoted.fill.notionalUsd).plus(d(quoted.fill.feeUsd)).toFixed(8)
      : d(quoted.fill.feeUsd).toFixed(8);
  return {
    book: nextBook,
    realizedPnlUsd,
    order: {
      clientOrderId: identity.clientOrderId,
      pairAddress: pair.pairAddress,
      baseSymbol: pair.baseSymbol,
      side,
      intent,
      qty: quoted.fill.qty,
      observationId: pair.observationId,
      reasonCodes,
      eligibleAt: eligibleAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      strategyInstanceId: identity.strategyInstanceId,
      intentId: identity.intentId,
      idempotencyKey: identity.idempotencyKey,
      intentSource: identity.source,
      intentAction: identity.action,
      ownerScope: identity.ownerScope,
      estimatedCostUsd,
      estimatedNotionalUsd: d(quoted.fill.notionalUsd).toFixed(8),
      strategyVersion: identity.strategyVersion,
    },
    decision: row(
      "EXECUTOR",
      pair,
      "ACT",
      reasonCodes,
      "1.000000",
      {
        ...audit,
        qty: quoted.fill.qty,
        priceUsd: quoted.fill.priceUsd,
        notionalUsd: quoted.fill.notionalUsd,
        feeUsd: quoted.fill.feeUsd,
        slippageBps: quoted.fill.slippageBps,
        estimatedCostUsd: quoted.fill.estimatedCostUsd,
        spreadBps: quoted.fill.spreadBps,
        impactBps: quoted.fill.impactBps,
        venue: "PAPER",
        paperLatencyMs: config.paperLatencyMs,
        eligibleAt: eligibleAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        deferred: deferFill,
      },
      {},
      "quote",
      Date.now() - started,
    ),
  };
}

function DecimalMax0(value: ReturnType<typeof d>) {
  return value.gt(0) ? value : d("0");
}

const Decimal = {
  minOf(left: ReturnType<typeof d>, right: ReturnType<typeof d>) {
    return left.lte(right) ? left : right;
  },
};

function row(
  agent: DecisionDraft["agent"],
  pair: CyclePair | string,
  decision: DecisionDraft["decision"],
  reasonCodes: ReasonCode[],
  confidence: string,
  output: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
  inputSource = "rules",
  durationMs = 0,
): DecisionDraft {
  const pairAddress = typeof pair === "string" ? pair : pair.pairAddress;
  return {
    agent,
    modelVersion: MODEL_VERSIONS[agent],
    pairAddress,
    decision,
    confidence,
    reasonCodes,
    input: typeof pair === "string" ? input : { observationId: pair.observationId, freshness: pair.freshness, ...input },
    output,
    inputSource,
    durationMs,
  };
}

function rank(pulse: DecisionDraft | undefined): number {
  return pulse?.decision === "ACT" && pulse.output.side === "SELL" ? 0 : 1;
}

function findPosition(positions: PositionView[], pairAddress: string): PositionView | undefined {
  return positions.find((position) => position.pairAddress === pairAddress);
}
