import { valuePortfolio } from "@odin/analytics";
import { evaluateCircuitBreaker, evaluateRisk } from "@odin/risk-engine";
import { d, type CyclePair, type OrderIntent, type OrderSide, type ReasonCode, type SecurityAssessment } from "@odin/shared";
import { applyFill, maxEntryNotional, qtyForNotional, quoteFill, type BookState } from "@odin/trading-engine";
import { runAegis } from "./aegis.js";
import { computeResearchMetrics } from "./archivist.js";
import { runPulse } from "./pulse.js";
import { rankWatchlist, runSentinel } from "./sentinel.js";
import {
  isIntent,
  type DecisionDraft,
  type PlanInput,
  type PositionView,
  type ProposedOrder,
} from "./types.js";
import { MODEL_VERSIONS } from "./versions.js";

export type { DecisionDraft, PlanInput, PositionView, ProposedOrder } from "./types.js";

export function planCycle(input: PlanInput): {
  decisions: DecisionDraft[];
  orders: ProposedOrder[];
  watchlist: ReturnType<typeof rankWatchlist>;
} {
  const now = input.now ?? new Date();
  const decisions: DecisionDraft[] = [];
  const orders: ProposedOrder[] = [];
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

    const valued = valuePortfolio({ cashUsd: book.cashUsd, positions: book.positions, marks: input.marks });
    const openPositions = book.positions.filter((position) => d(position.baseQty).gt(0)).length;
    const proposedNotional =
      side === "BUY" && pair.priceUsd && valued.equityUsd
        ? maxEntryNotional({
            cashUsd: book.cashUsd,
            equityUsd: valued.equityUsd,
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

    const risk = evaluateRisk({
      engineStatus: input.engineStatus,
      side,
      intent,
      freshness: pair.freshness,
      allowDelayedExits: input.config.allowDelayedExits,
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

    const atlasStarted = Date.now();
    if (risk.decision !== "PASS") {
      decisions.push(
        row("ATLAS", pair, "REJECT", risk.reasonCodes, risk.confidence, {}, {
          freshness: pair.freshness,
          valuation: valued.valuation,
          dailyPnlUsd: dailyPnl,
          openPositions,
          circuitBreaker: breaker,
        }, "portfolio:risk", Date.now() - atlasStarted),
      );
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000", { blockedBy: "ATLAS" }));
      continue;
    }

    const sized = sizeOrder(pair, book, input, side, intent, valued.equityUsd, aggregateExposure);
    decisions.push({
      ...sized.decision,
      inputSource: sized.decision.inputSource ?? "portfolio:sizing",
      durationMs: sized.decision.durationMs ?? Date.now() - atlasStarted,
    });
    if (sized.decision.decision !== "ACT" || !sized.qty) {
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000"));
      continue;
    }
    const executed = executeOrder(input.cycleId, pair, side, intent, sized.qty, book, input.config, now);
    decisions.push(executed.decision);
    if (executed.order && executed.book) {
      orders.push(executed.order);
      book = executed.book;
      if (side === "BUY" && pair.priceUsd) {
        aggregateExposure = d(aggregateExposure).plus(d(sized.qty).mul(d(pair.priceUsd))).toFixed(8);
      }
      if (dailyPnl !== null && executed.realizedPnlUsd) dailyPnl = d(dailyPnl).plus(d(executed.realizedPnlUsd)).toFixed(8);
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
        metrics,
      },
      { circuitBreaker: breaker },
      "ledger+decisions",
    ),
  );
  return { decisions, orders, watchlist };
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
    return {
      qty: position.baseQty,
      decision: row(
        "ATLAS",
        pair,
        "ACT",
        ["SIZE_COMPUTED", "FULL_POSITION_EXIT"],
        "1.000000",
        { side, intent, qty: position.baseQty },
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
  if (d(notional).lt(input.config.minOrderNotionalUsd)) {
    return {
      qty: null,
      decision: row(
        "ATLAS",
        pair,
        "REJECT",
        ["BELOW_MIN_NOTIONAL"],
        "1.000000",
        { notionalUsd: notional },
        {},
        "portfolio:sizing",
        Date.now() - started,
      ),
    };
  }
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
  cycleId: string,
  pair: CyclePair,
  side: OrderSide,
  intent: OrderIntent,
  quantity: string,
  book: BookState,
  config: PlanInput["config"],
  now: Date,
): { decision: DecisionDraft; order?: ProposedOrder; book?: BookState; realizedPnlUsd?: string } {
  const started = Date.now();
  if (pair.priceUsd === null || pair.liquidityUsd === null) {
    return {
      decision: row("EXECUTOR", pair, "REJECT", ["MISSING_PRICE"], "0.000000", {}, {}, "quote", Date.now() - started),
    };
  }
  if (d(quantity).lte(0)) {
    return {
      decision: row("EXECUTOR", pair, "REJECT", ["NON_POSITIVE_QTY"], "1.000000", {}, {}, "quote", Date.now() - started),
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
      decision: row("EXECUTOR", pair, "REJECT", [quoted.reason], "1.000000", {}, {}, "quote", Date.now() - started),
    };
  }

  const eligibleAt = new Date(now.getTime() + config.paperLatencyMs);
  const expiresAt = new Date(eligibleAt.getTime() + config.orderExpiryMs);
  const applied = applyFill(book, { pairAddress: pair.pairAddress, baseSymbol: pair.baseSymbol, side, fill: quoted.fill });
  if (!applied.ok) {
    return {
      decision: row("EXECUTOR", pair, "REJECT", [applied.reason], "1.000000", {}, {}, "quote", Date.now() - started),
    };
  }
  const reasonCodes: ReasonCode[] = ["ORDER_PROPOSED", "COST_ESTIMATED", "SPREAD_APPLIED"];
  if (config.paperLatencyMs > 0) reasonCodes.push("ORDER_PENDING");
  return {
    book: applied.state,
    realizedPnlUsd: applied.realizedPnlUsd,
    order: {
      clientOrderId: `${cycleId}:${pair.pairAddress}:${side}:${intent}`,
      pairAddress: pair.pairAddress,
      baseSymbol: pair.baseSymbol,
      side,
      intent,
      qty: quoted.fill.qty,
      observationId: pair.observationId,
      reasonCodes,
      eligibleAt: eligibleAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    decision: row(
      "EXECUTOR",
      pair,
      "ACT",
      reasonCodes,
      "1.000000",
      {
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
      },
      {},
      "quote",
      Date.now() - started,
    ),
  };
}

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
