import { confidenceFixed, d, type DataState, type EngineStatus, type OrderIntent, type OrderSide, type ReasonCode } from "@odin/shared";
import { Decimal } from "@odin/shared";

export type ValuationState = DataState | "INCOMPLETE" | "CASH_ONLY";

export type RiskContext = {
  engineStatus: EngineStatus;
  side: OrderSide;
  intent: OrderIntent;
  freshness: DataState;
  allowDelayedExits: boolean;
  /** When true, DEMO freshness may open paper risk (never relabelled LIVE). */
  allowDemoPaperEntries?: boolean;
  /** Hard advisory: block buys while exits remain allowed. */
  pauseNewEntries?: boolean;
  /** Account-wide suspension after unknown exposure / reconcile failure. */
  entriesSuspended?: boolean;
  openPositions: number;
  maxPositions: number;
  dailyPnlUsd: string | null;
  startingBalanceUsd: string;
  /**
   * Equity at the start of the trading day (Europe/London midnight session roll). The daily loss
   * limit is a percentage of this, not of startingBalanceUsd (audit L3). Callers without a session
   * fall back to startingBalanceUsd.
   */
  dayStartEquityUsd?: string | null;
  /**
   * Worst daily P&L seen this London day (session-low equity − start-of-day equity). Once it reaches
   * the limit, entries stay blocked until the next London day even if equity recovers (ASCEND-00 F1).
   */
  worstDailyPnlUsd?: string | null;
  maxDailyLossPct: string;
  valuation: ValuationState;
  equityUsd?: string | null;
  highWaterMarkUsd?: string | null;
  maxTotalDrawdownPct?: string;
  aggregateExposureUsd?: string | null;
  proposedNotionalUsd?: string | null;
  maxAggregateExposurePct?: string;
  circuitBreakerOpen?: boolean;
};

export type RiskGate = {
  decision: "PASS" | "REJECT";
  reasonCodes: ReasonCode[];
  confidence: string;
};

export function evaluateRisk(input: RiskContext): RiskGate {
  if (input.circuitBreakerOpen && input.side === "BUY") {
    return gate("REJECT", ["CIRCUIT_BREAKER"], 1);
  }
  if (input.engineStatus === "EMERGENCY_STOP" && input.intent !== "FLATTEN") {
    return gate("REJECT", ["EMERGENCY_STOP"], 1);
  }
  if (input.intent === "FLATTEN") {
    if (input.engineStatus !== "EMERGENCY_STOP" && input.engineStatus !== "RUNNING") {
      return gate("REJECT", ["ENGINE_HALTED"], 1);
    }
  } else if (input.engineStatus !== "RUNNING") {
    // D16: reduce-only operator close remains available while PAUSED.
    const reduceOnlyWhilePaused =
      input.engineStatus === "PAUSED" && input.side === "SELL" && input.intent === "OPERATOR";
    if (!reduceOnlyWhilePaused) {
      return gate("REJECT", ["ENGINE_HALTED"], 1);
    }
  }

  const freshness = freshnessGate(input);
  if (freshness) return freshness;

  if (input.side === "BUY") {
    if (input.pauseNewEntries) {
      return gate("REJECT", ["PAUSE_NEW_ENTRIES"], 1);
    }
    if (input.entriesSuspended) {
      return gate("REJECT", ["ENTRIES_SUSPENDED"], 1);
    }
    if (input.valuation === "INCOMPLETE") return gate("REJECT", ["MARK_UNAVAILABLE"], 0);
    const demoOk = input.allowDemoPaperEntries === true && (input.valuation === "DEMO" || input.freshness === "DEMO");
    if (input.valuation !== "LIVE" && input.valuation !== "CASH_ONLY" && !demoOk) {
      return gate("REJECT", ["VALUATION_NOT_LIVE"], 1);
    }
    if (input.dailyPnlUsd === null) return gate("REJECT", ["DAILY_PNL_UNAVAILABLE"], 0);
    const limit = dailyLossLimitUsd(input);
    if (d(input.dailyPnlUsd).lte(limit.neg())) return gate("REJECT", ["DAILY_LOSS_LIMIT"], 1);
    if (input.worstDailyPnlUsd != null && d(input.worstDailyPnlUsd).lte(limit.neg())) {
      return gate("REJECT", ["DAILY_LOSS_LIMIT"], 1);
    }
    if (input.openPositions >= input.maxPositions) return gate("REJECT", ["MAX_POSITIONS"], 1);

    const drawdown = totalDrawdownGate(input);
    if (drawdown) return drawdown;

    const exposure = aggregateExposureGate(input);
    if (exposure) return exposure;
  }

  const reasons: ReasonCode[] = [];
  if (input.freshness === "DELAYED") reasons.push("DATA_DELAYED_EXIT_ALLOWED");
  reasons.push("RISK_OK");
  return gate("PASS", reasons, 1);
}

/**
 * Loss still allowed today before the daily limit: limit + dailyPnl, floored at zero. Null when daily
 * P&L is unknown (entries are then rejected by DAILY_PNL_UNAVAILABLE). Entry sizing caps worst-case
 * stop-out loss to this so one admitted trade cannot carry the account through the limit (ASCEND-00 F2).
 */
export function dailyLossHeadroomUsd(input: {
  dailyPnlUsd: string | null;
  worstDailyPnlUsd?: string | null;
  startingBalanceUsd: string;
  dayStartEquityUsd?: string | null;
  maxDailyLossPct: string;
}): string | null {
  if (input.dailyPnlUsd === null) return null;
  const limit = dailyLossLimitUsd(input);
  if (input.worstDailyPnlUsd != null && d(input.worstDailyPnlUsd).lte(limit.neg())) return "0.00000000";
  const headroom = limit.plus(d(input.dailyPnlUsd));
  return headroom.lte(0) ? "0.00000000" : headroom.toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8);
}

/**
 * Loss already committed by open positions if each stops out: the fall from the mark to the stop
 * (stopLossPct below average cost, never negative) plus exit costs (fee + maxExitImpactBps) on the
 * marked notional. A position without a mark is valued at cost. Daily headroom is reduced by this, so
 * several entries cannot each use the same headroom (ASCEND-00 F2 review).
 */
export function openStopRiskUsd(input: {
  positions: ReadonlyArray<{ baseQty: string; avgCostUsd: string; markUsd: string | null }>;
  stopLossPct: string;
  feeBps: string;
  maxExitImpactBps: string;
}): string {
  const stopFraction = d(input.stopLossPct).div(100);
  const exitFraction = d(input.feeBps).plus(d(input.maxExitImpactBps)).div(10000);
  let total = new Decimal(0);
  for (const position of input.positions) {
    const qty = d(position.baseQty);
    if (qty.lte(0)) continue;
    const mark = position.markUsd != null && d(position.markUsd).gt(0) ? d(position.markUsd) : d(position.avgCostUsd);
    const stopPrice = d(position.avgCostUsd).mul(new Decimal(1).minus(stopFraction));
    const toStop = Decimal.max(mark.minus(stopPrice), 0).mul(qty);
    total = total.plus(toStop).plus(mark.mul(qty).mul(exitFraction));
  }
  return total.toDecimalPlaces(8, Decimal.ROUND_UP).toFixed(8);
}

/** Independent circuit breaker: trip on daily loss or HWM drawdown breach. */
/** Daily loss limit in USD: maxDailyLossPct of start-of-day equity (startingBalanceUsd only as fallback). */
export function dailyLossLimitUsd(input: {
  startingBalanceUsd: string;
  dayStartEquityUsd?: string | null;
  maxDailyLossPct: string;
}): Decimal {
  const base = input.dayStartEquityUsd != null && d(input.dayStartEquityUsd).gt(0) ? input.dayStartEquityUsd : input.startingBalanceUsd;
  return d(base).mul(d(input.maxDailyLossPct)).div(100);
}

export function evaluateCircuitBreaker(input: {
  dailyPnlUsd: string | null;
  startingBalanceUsd: string;
  dayStartEquityUsd?: string | null;
  worstDailyPnlUsd?: string | null;
  maxDailyLossPct: string;
  equityUsd: string | null;
  highWaterMarkUsd: string | null;
  maxTotalDrawdownPct: string;
}): { open: boolean; reasonCodes: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  const dailyLimit = dailyLossLimitUsd(input);
  const breachedNow = input.dailyPnlUsd !== null && d(input.dailyPnlUsd).lte(dailyLimit.neg());
  const breachedToday = input.worstDailyPnlUsd != null && d(input.worstDailyPnlUsd).lte(dailyLimit.neg());
  if (breachedNow || breachedToday) reasons.push("DAILY_LOSS_LIMIT");
  if (input.equityUsd !== null && input.highWaterMarkUsd !== null && d(input.highWaterMarkUsd).gt(0)) {
    const dd = d(input.highWaterMarkUsd).minus(d(input.equityUsd)).div(d(input.highWaterMarkUsd)).mul(100);
    if (dd.gte(input.maxTotalDrawdownPct)) reasons.push("TOTAL_DRAWDOWN_LIMIT");
  }
  if (reasons.length > 0) {
    return { open: true, reasonCodes: ["CIRCUIT_BREAKER", ...reasons] };
  }
  return { open: false, reasonCodes: [] };
}

function totalDrawdownGate(input: RiskContext): RiskGate | null {
  if (!input.maxTotalDrawdownPct || input.equityUsd === null || input.equityUsd === undefined) return null;
  if (input.highWaterMarkUsd === null || input.highWaterMarkUsd === undefined) return null;
  if (d(input.highWaterMarkUsd).lte(0)) return null;
  const dd = d(input.highWaterMarkUsd).minus(d(input.equityUsd)).div(d(input.highWaterMarkUsd)).mul(100);
  if (dd.gte(input.maxTotalDrawdownPct)) return gate("REJECT", ["TOTAL_DRAWDOWN_LIMIT"], 1);
  return null;
}

function aggregateExposureGate(input: RiskContext): RiskGate | null {
  if (!input.maxAggregateExposurePct || input.equityUsd === null || input.equityUsd === undefined) return null;
  if (input.aggregateExposureUsd === null || input.aggregateExposureUsd === undefined) return null;
  const proposed = input.proposedNotionalUsd ? d(input.proposedNotionalUsd) : d("0");
  const next = d(input.aggregateExposureUsd).plus(proposed);
  const cap = d(input.equityUsd).mul(d(input.maxAggregateExposurePct)).div(100);
  if (next.gt(cap)) return gate("REJECT", ["AGGREGATE_EXPOSURE"], 1);
  return null;
}

function freshnessGate(input: RiskContext): RiskGate | null {
  if (input.freshness === "STALE") return gate("REJECT", ["DATA_STALE"], 1);
  if (input.freshness === "REPLAY") return gate("REJECT", ["DATA_REPLAY"], 1);
  if (input.freshness === "DEMO") {
    const demoEntry = input.side === "BUY" && input.allowDemoPaperEntries === true;
    const demoExit = input.side === "SELL" && (input.allowDemoPaperEntries === true || input.allowDelayedExits);
    if (!demoEntry && !demoExit) return gate("REJECT", ["DATA_DEMO"], 1);
    return null;
  }
  if (input.freshness === "DELAYED" && !(input.side === "SELL" && input.allowDelayedExits)) {
    return gate("REJECT", ["DATA_DELAYED"], 1);
  }
  return null;
}

function gate(decision: "PASS" | "REJECT", reasonCodes: ReasonCode[], confidence: number): RiskGate {
  return { decision, reasonCodes, confidence: confidenceFixed(new Decimal(confidence)) };
}
