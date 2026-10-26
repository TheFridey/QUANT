import { valuePortfolio, type Mark } from "@odin/analytics";
import { evaluateRisk } from "@odin/risk-engine";
import {
  confidenceFixed,
  d,
  isTradableQuote,
  type AgentName,
  type CyclePair,
  type EngineStatus,
  type OperatorOrder,
  type OrderIntent,
  type OrderSide,
  type ReasonCode,
  type StrategyConfig,
  Decimal,
} from "@odin/shared";
import { applyFill, maxEntryNotional, qtyForNotional, quoteFill, type BookState } from "@odin/trading-engine";
import { MODEL_VERSIONS } from "./versions.js";

export type PositionView = {
  pairAddress: string;
  baseSymbol: string;
  baseQty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
};

export type DecisionDraft = {
  agent: AgentName;
  modelVersion: string;
  pairAddress: string;
  decision: "PASS" | "REJECT" | "HOLD" | "ACT";
  confidence: string;
  reasonCodes: ReasonCode[];
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type ProposedOrder = {
  clientOrderId: string;
  pairAddress: string;
  baseSymbol: string;
  side: OrderSide;
  intent: OrderIntent;
  qty: string;
  observationId: string;
  reasonCodes: ReasonCode[];
};

export type PlanInput = {
  cycleId: string;
  engineStatus: EngineStatus;
  config: StrategyConfig;
  cashUsd: string;
  startingBalanceUsd: string;
  positions: PositionView[];
  pairs: CyclePair[];
  marks: Record<string, Mark | undefined>;
  dailyPnlUsd: string | null;
  flatten: boolean;
  operator: OperatorOrder | null;
};

export function planCycle(input: PlanInput): { decisions: DecisionDraft[]; orders: ProposedOrder[] } {
  const decisions: DecisionDraft[] = [];
  const orders: ProposedOrder[] = [];
  const sentinel = new Map<string, DecisionDraft>();
  const pulses = new Map<string, DecisionDraft>();

  for (const pair of input.pairs) {
    const surveillance = runSentinel(pair, input.config);
    sentinel.set(pair.pairAddress, surveillance);
    decisions.push(surveillance);
    const pulse = runPulse(pair, findPosition(input.positions, pair.pairAddress), surveillance, input);
    pulses.set(pair.pairAddress, pulse);
    decisions.push(pulse);
  }

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
  const ordered = [...input.pairs].sort((left, right) => rank(pulses.get(left.pairAddress)) - rank(pulses.get(right.pairAddress)));

  for (const pair of ordered) {
    const pulse = pulses.get(pair.pairAddress);
    if (!pulse) continue;
    const side = pulse.output.side;
    const intent = pulse.output.intent;
    if (pulse.decision !== "ACT" || (side !== "BUY" && side !== "SELL") || !isIntent(intent)) {
      decisions.push(row("AEGIS", pair.pairAddress, "HOLD", ["NO_INTENT"], "1.000000"));
      decisions.push(row("ATLAS", pair.pairAddress, "HOLD", ["NO_INTENT"], "1.000000"));
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000"));
      continue;
    }

    const valued = valuePortfolio({ cashUsd: book.cashUsd, positions: book.positions, marks: input.marks });
    const openPositions = book.positions.filter((position) => d(position.baseQty).gt(0)).length;
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
    });
    decisions.push(
      row("AEGIS", pair, risk.decision === "PASS" ? "PASS" : "REJECT", risk.reasonCodes, risk.confidence, {}, {
        freshness: pair.freshness,
        valuation: valued.valuation,
        dailyPnlUsd: dailyPnl,
        openPositions,
      }),
    );
    if (risk.decision !== "PASS") {
      decisions.push(row("ATLAS", pair.pairAddress, "HOLD", ["NO_INTENT"], "1.000000"));
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000", { blockedBy: "AEGIS" }));
      continue;
    }

    const sized = sizeOrder(pair, book, input, side, intent, valued.equityUsd);
    decisions.push(sized.decision);
    if (sized.decision.decision !== "ACT" || !sized.qty) {
      decisions.push(row("EXECUTOR", pair.pairAddress, "HOLD", ["NO_ORDER"], "1.000000"));
      continue;
    }
    const executed = executeOrder(input.cycleId, pair, side, intent, sized.qty, book, input.config);
    decisions.push(executed.decision);
    if (executed.order && executed.book) {
      orders.push(executed.order);
      book = executed.book;
      if (dailyPnl !== null && executed.realizedPnlUsd) dailyPnl = d(dailyPnl).plus(d(executed.realizedPnlUsd)).toFixed(8);
    }
  }

  decisions.push(
    row("ARCHIVIST", "", "PASS", ["AUDIT_RECORDED"], "1.000000", {
      decisions: decisions.length + 1,
      orders: orders.length,
    }),
  );
  return { decisions, orders };
}

function runSentinel(pair: CyclePair, config: StrategyConfig): DecisionDraft {
  const reasons: ReasonCode[] = [];
  if (pair.freshness === "STALE") reasons.push("DATA_STALE");
  if (pair.freshness === "REPLAY") reasons.push("DATA_REPLAY");
  if (pair.freshness === "DEMO") reasons.push("DATA_DEMO");
  if (pair.priceUsd === null) reasons.push("MISSING_PRICE");
  else if (d(pair.priceUsd).lte(0)) reasons.push("NON_POSITIVE_PRICE");
  if (pair.liquidityUsd === null) reasons.push("MISSING_LIQUIDITY");
  else if (d(pair.liquidityUsd).lt(config.minLiquidityUsd)) reasons.push("LIQUIDITY_FLOOR");
  if (pair.volume24hUsd === null) reasons.push("MISSING_VOLUME");
  else if (d(pair.volume24hUsd).lt(config.minVolume24hUsd)) reasons.push("VOLUME_FLOOR");
  if (reasons.length === 0 && pair.freshness === "DELAYED") reasons.push("DATA_DELAYED");
  if (reasons.length === 0) reasons.push("DATA_OK");
  const rejected = reasons.some((reason) => reason !== "DATA_OK" && reason !== "DATA_DELAYED");
  return row("SENTINEL", pair, rejected ? "REJECT" : "PASS", reasons, "1.000000");
}

function runPulse(pair: CyclePair, position: PositionView | undefined, surveillance: DecisionDraft, input: PlanInput): DecisionDraft {
  const held = position !== undefined && d(position.baseQty).gt(0);
  if (input.operator && input.operator.pairAddress !== pair.pairAddress) {
    return row("PULSE", pair, "HOLD", ["NO_INTENT"], "1.000000");
  }
  if (input.operator?.pairAddress === pair.pairAddress) {
    if (input.operator.side === "SELL") {
      if (!held) return row("PULSE", pair, "REJECT", ["NO_POSITION"], "1.000000", { side: "SELL", intent: "OPERATOR" });
      return row("PULSE", pair, "ACT", ["OPERATOR_OVERRIDE", "FULL_POSITION_EXIT"], "1.000000", { side: "SELL", intent: "OPERATOR" });
    }
    if (held) return row("PULSE", pair, "HOLD", ["ALREADY_HELD"], "1.000000");
    return row("PULSE", pair, "ACT", ["OPERATOR_OVERRIDE"], "1.000000", { side: "BUY", intent: "OPERATOR" });
  }
  if (input.flatten) {
    if (!held) return row("PULSE", pair, "HOLD", ["NO_INTENT"], "1.000000");
    return row("PULSE", pair, "ACT", ["FULL_POSITION_EXIT"], "1.000000", { side: "SELL", intent: "FLATTEN" });
  }
  if (!held && surveillance.decision === "REJECT") return row("PULSE", pair, "HOLD", ["BLOCKED_BY_SENTINEL"], "1.000000");
  if (held && position) {
    if (pair.priceUsd === null || d(pair.priceUsd).lte(0) || d(position.avgCostUsd).lte(0)) {
      return row("PULSE", pair, "HOLD", ["MARK_UNAVAILABLE"], "0.000000");
    }
    const pnlPct = d(pair.priceUsd).minus(d(position.avgCostUsd)).div(d(position.avgCostUsd)).mul(100);
    if (pnlPct.lte(d(input.config.stopLossPct).neg())) {
      return row("PULSE", pair, "ACT", ["STOP_LOSS"], "1.000000", { side: "SELL", intent: "EXIT", pnlPct: pnlPct.toFixed(4) });
    }
    if (pnlPct.gte(input.config.takeProfitPct)) {
      return row("PULSE", pair, "ACT", ["TAKE_PROFIT"], "1.000000", { side: "SELL", intent: "EXIT", pnlPct: pnlPct.toFixed(4) });
    }
    if (pair.priceChangeM5Pct !== null && d(pair.priceChangeM5Pct).lte(input.config.exitM5ChangePct)) {
      return row("PULSE", pair, "ACT", ["EXIT_MOMENTUM"], "1.000000", { side: "SELL", intent: "EXIT" });
    }
    return row("PULSE", pair, "HOLD", ["HOLD_POSITION"], "1.000000");
  }
  if (pair.priceChangeM5Pct === null || pair.priceChangeH1Pct === null || pair.txnsM5Buys === null || pair.txnsM5Sells === null) {
    return row("PULSE", pair, "HOLD", ["INSUFFICIENT_DATA"], "0.000000");
  }
  if (!isTradableQuote(pair.quoteAddress)) {
    return row("PULSE", pair, "HOLD", ["QUOTE_NOT_ALLOWED"], "1.000000");
  }
  if (d(pair.priceChangeM5Pct).abs().gt(input.config.maxEntryM5ChangePct)) {
    return row("PULSE", pair, "HOLD", ["PRICE_ANOMALY"], "1.000000", { priceChangeM5Pct: pair.priceChangeM5Pct });
  }
  const entry =
    d(pair.priceChangeM5Pct).gte(input.config.entryM5ChangePct) &&
    d(pair.priceChangeH1Pct).gte(input.config.minH1ChangePct) &&
    pair.txnsM5Buys > pair.txnsM5Sells;
  if (!entry) return row("PULSE", pair, "HOLD", ["NO_EDGE"], "1.000000");
  const threshold = d(input.config.entryM5ChangePct);
  const confidence = threshold.eq(0)
    ? "1.000000"
    : confidenceFixed(Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), d(pair.priceChangeM5Pct).minus(threshold).div(threshold))));
  return row("PULSE", pair, "ACT", ["ENTRY_MOMENTUM"], confidence, { side: "BUY", intent: "ENTRY" });
}

function sizeOrder(
  pair: CyclePair,
  book: BookState,
  input: PlanInput,
  side: OrderSide,
  intent: OrderIntent,
  equityUsd: string | null,
): { decision: DecisionDraft; qty: string | null } {
  if (side === "SELL") {
    const position = findPosition(book.positions, pair.pairAddress);
    if (!position || d(position.baseQty).lte(0)) {
      return { qty: null, decision: row("ATLAS", pair, "REJECT", ["NO_POSITION"], "1.000000") };
    }
    return {
      qty: position.baseQty,
      decision: row("ATLAS", pair, "ACT", ["SIZE_COMPUTED", "FULL_POSITION_EXIT"], "1.000000", {
        side,
        intent,
        qty: position.baseQty,
      }),
    };
  }
  if (pair.priceUsd === null || pair.liquidityUsd === null || equityUsd === null) {
    return { qty: null, decision: row("ATLAS", pair, "REJECT", ["MARK_UNAVAILABLE"], "0.000000") };
  }
  const cap = maxEntryNotional({
    cashUsd: book.cashUsd,
    equityUsd,
    liquidityUsd: pair.liquidityUsd,
    maxPositionPctEquity: input.config.maxPositionPctEquity,
    maxParticipationPctLiquidity: input.config.maxParticipationPctLiquidity,
    feeBps: input.config.feeBps,
    maxSlippageBps: input.config.maxSlippageBps,
  });
  let notional = cap;
  if (intent === "OPERATOR" && input.operator?.side === "BUY") {
    if (d(input.operator.notionalUsd).gt(d(cap))) {
      return { qty: null, decision: row("ATLAS", pair, "REJECT", ["SIZE_ABOVE_CAP"], "1.000000", { maxNotionalUsd: cap }) };
    }
    notional = input.operator.notionalUsd;
  }
  if (d(notional).lt(input.config.minOrderNotionalUsd)) {
    return { qty: null, decision: row("ATLAS", pair, "REJECT", ["BELOW_MIN_NOTIONAL"], "1.000000", { notionalUsd: notional }) };
  }
  const quantity = qtyForNotional(notional, pair.priceUsd);
  if (d(quantity).lte(0)) return { qty: null, decision: row("ATLAS", pair, "REJECT", ["SIZE_ZERO"], "1.000000") };
  return {
    qty: quantity,
    decision: row("ATLAS", pair, "ACT", ["SIZE_COMPUTED"], "1.000000", { side, intent, qty: quantity, notionalUsd: notional }),
  };
}

function executeOrder(
  cycleId: string,
  pair: CyclePair,
  side: OrderSide,
  intent: OrderIntent,
  quantity: string,
  book: BookState,
  config: StrategyConfig,
): { decision: DecisionDraft; order?: ProposedOrder; book?: BookState; realizedPnlUsd?: string } {
  if (pair.priceUsd === null || pair.liquidityUsd === null) {
    return { decision: row("EXECUTOR", pair, "REJECT", ["MISSING_PRICE"], "0.000000") };
  }
  const quoted = quoteFill({
    side,
    midPriceUsd: pair.priceUsd,
    quantity,
    liquidityUsd: pair.liquidityUsd,
    feeBps: config.feeBps,
    maxSlippageBps: config.maxSlippageBps,
  });
  if (!quoted.ok) return { decision: row("EXECUTOR", pair, "REJECT", [quoted.reason], "1.000000") };
  const applied = applyFill(book, { pairAddress: pair.pairAddress, baseSymbol: pair.baseSymbol, side, fill: quoted.fill });
  if (!applied.ok) return { decision: row("EXECUTOR", pair, "REJECT", [applied.reason], "1.000000") };
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
      reasonCodes: ["ORDER_PROPOSED"],
    },
    decision: row("EXECUTOR", pair, "ACT", ["ORDER_PROPOSED"], "1.000000", {
      qty: quoted.fill.qty,
      priceUsd: quoted.fill.priceUsd,
      notionalUsd: quoted.fill.notionalUsd,
      feeUsd: quoted.fill.feeUsd,
      slippageBps: quoted.fill.slippageBps,
      venue: "PAPER",
    }),
  };
}

function row(
  agent: AgentName,
  pair: CyclePair | string,
  decision: DecisionDraft["decision"],
  reasonCodes: ReasonCode[],
  confidence: string,
  output: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
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
  };
}

function rank(pulse: DecisionDraft | undefined): number {
  return pulse?.decision === "ACT" && pulse.output.side === "SELL" ? 0 : 1;
}

function findPosition(positions: PositionView[], pairAddress: string): PositionView | undefined {
  return positions.find((position) => position.pairAddress === pairAddress);
}

function isIntent(value: unknown): value is OrderIntent {
  return value === "ENTRY" || value === "EXIT" || value === "FLATTEN" || value === "OPERATOR";
}
