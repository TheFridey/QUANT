import { d, usd, type StrategyConfig, Decimal } from "@odin/shared";
import type { BacktestObservation } from "@odin/backtest";
import { evaluateRisk } from "@odin/risk-engine";
import { quoteFill, sizeFromStopDistance } from "@odin/trading-engine";
import { assessObservationIntegrity } from "./data-integrity.js";

export type ResearchFill = {
  observationId: string;
  pairAddress: string;
  side: "BUY" | "SELL";
  qty: string;
  priceUsd: string;
  feeUsd: string;
  slippageBps: string;
  notionalUsd: string;
  pnlUsd: string | null;
  filledAt: string;
};

export type ResearchSimulation = {
  blocked: boolean;
  blockReason: string | null;
  fills: ResearchFill[];
  rejected: Array<{ at: string; pairAddress: string; reason: string }>;
  closedPnls: string[];
  feesUsd: string;
  endingEquityUsd: string | null;
  returnPct: string | null;
  equitySeries: string[];
  exposureSeries: string[];
  observationSpanMs: number | null;
};

type Position = { qty: string; avgCostUsd: string; pairAddress: string };
type Pending = {
  observationId: string;
  pairAddress: string;
  side: "BUY" | "SELL";
  qty: string;
  eligibleAtMs: number;
};

/**
 * Chronological paper simulation. Signals do not set prices, balances, or risk limits.
 * Fills use a later observation after the latency window. Missing prices produce no fill.
 */
export function simulateResearchPath(input: {
  observations: BacktestObservation[];
  signals: Array<{ observationId: string; intent: "ENTER_LONG" | "EXIT_LONG" | "HOLD" | "RESEARCH_NOTE" }>;
  config: StrategyConfig;
  initialCashUsd: string;
  latencyMs: number;
}): ResearchSimulation {
  const integrity = assessObservationIntegrity(input.observations);
  if (integrity.blocking) {
    return emptySimulation(integrity.issues.find((issue) => issue.severity === "block")?.detail ?? "Blocking data integrity issue");
  }
  const observations = [...integrity.usable].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  if (observations.length === 0) return emptySimulation("No usable observations");

  const byId = new Map(input.signals.map((signal) => [signal.observationId, signal.intent]));
  let cash = d(input.initialCashUsd);
  let fees = d("0");
  let realized = d("0");
  const positions = new Map<string, Position>();
  const pending: Pending[] = [];
  const fills: ResearchFill[] = [];
  const rejected: ResearchSimulation["rejected"] = [];
  const closedPnls: string[] = [];
  const equitySeries: string[] = [];
  const exposureSeries: string[] = [];
  const seenPrice = new Map<string, string>();

  const markEquity = () => {
    let exposure = d("0");
    for (const position of positions.values()) {
      const mark = seenPrice.get(position.pairAddress);
      if (!mark) return;
      exposure = exposure.plus(d(position.qty).mul(d(mark)));
    }
    equitySeries.push(usd(cash.plus(exposure)));
    exposureSeries.push(usd(exposure));
  };

  for (const obs of observations) {
    if (obs.priceUsd) seenPrice.set(obs.pairAddress, obs.priceUsd);
    const now = Date.parse(obs.receivedAt);
    const still: Pending[] = [];
    for (const order of pending) {
      if (order.pairAddress !== obs.pairAddress || now < order.eligibleAtMs) {
        still.push(order);
        continue;
      }
      if (!obs.priceUsd || !obs.liquidityUsd) {
        rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "MISSING_PRICE_OR_LIQUIDITY" });
        continue;
      }
      const quoted = quoteFill({
        side: order.side,
        midPriceUsd: obs.priceUsd,
        quantity: order.qty,
        liquidityUsd: obs.liquidityUsd,
        feeBps: input.config.feeBps,
        maxSlippageBps: input.config.maxSlippageBps,
        spreadBpsEstimate: input.config.spreadBpsEstimate,
        maxPriceImpactBps: input.config.maxPriceImpactBps,
        // Exits follow the engine's exit execution policy (audit C3).
        exitPolicy: order.side === "SELL" ? { maxExitImpactBps: input.config.maxExitImpactBps } : null,
      });
      if (!quoted.ok) {
        rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: quoted.reason });
        continue;
      }
      const fee = d(quoted.fill.feeUsd);
      if (order.side === "BUY") {
        const spend = d(quoted.fill.notionalUsd).plus(fee);
        if (spend.gt(cash)) {
          rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "INSUFFICIENT_CASH" });
          continue;
        }
        cash = cash.minus(spend);
        fees = fees.plus(fee);
        positions.set(obs.pairAddress, {
          pairAddress: obs.pairAddress,
          qty: quoted.fill.qty,
          avgCostUsd: quoted.fill.priceUsd,
        });
        fills.push(toFill(order, quoted.fill, obs, null));
      } else {
        const position = positions.get(obs.pairAddress);
        if (!position) {
          rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "NO_POSITION" });
          continue;
        }
        const soldQty = d(quoted.fill.qty);
        const proceeds = d(quoted.fill.notionalUsd).minus(fee);
        const pnl = proceeds.minus(soldQty.mul(d(position.avgCostUsd)));
        cash = cash.plus(proceeds);
        fees = fees.plus(fee);
        realized = realized.plus(pnl);
        const pnlUsd = usd(pnl);
        closedPnls.push(pnlUsd);
        const remainingQty = d(position.qty).minus(soldQty);
        if (remainingQty.gt(0)) positions.set(obs.pairAddress, { ...position, qty: remainingQty.toFixed(8) });
        else positions.delete(obs.pairAddress);
        if (d(quoted.fill.remainderQty).gt(0)) still.push({ ...order, qty: quoted.fill.remainderQty, eligibleAtMs: now });
        fills.push(toFill(order, quoted.fill, obs, pnlUsd));
      }
    }
    pending.length = 0;
    pending.push(...still);

    const intent = byId.get(obs.id) ?? "HOLD";
    if (intent === "HOLD" || intent === "RESEARCH_NOTE") {
      markEquity();
      continue;
    }
    if (!obs.priceUsd || !obs.liquidityUsd) {
      rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "SIGNAL_WITHOUT_PRICE" });
      markEquity();
      continue;
    }
    if (intent === "ENTER_LONG" && !positions.has(obs.pairAddress)) {
      const exposure = exposureNotional(positions, seenPrice);
      const gate = evaluateRisk({
        engineStatus: "RUNNING",
        side: "BUY",
        intent: "ENTRY",
        freshness: obs.freshness,
        allowDelayedExits: input.config.allowDelayedExits,
        openPositions: positions.size,
        maxPositions: input.config.maxPositions,
        dailyPnlUsd: usd(realized),
        startingBalanceUsd: input.initialCashUsd,
        maxDailyLossPct: input.config.maxDailyLossPct,
        valuation: "LIVE",
        equityUsd: usd(cash),
        highWaterMarkUsd: input.initialCashUsd,
        maxTotalDrawdownPct: input.config.maxTotalDrawdownPct,
        aggregateExposureUsd: usd(exposure),
        proposedNotionalUsd: input.config.minOrderNotionalUsd,
        maxAggregateExposurePct: input.config.maxAggregateExposurePct,
      });
      if (gate.decision !== "PASS") {
        rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: gate.reasonCodes.join(",") });
        markEquity();
        continue;
      }
      const sized = sizeFromStopDistance({
        equityUsd: usd(cash),
        cashUsd: usd(cash),
        midPriceUsd: obs.priceUsd,
        liquidityUsd: obs.liquidityUsd,
        stopLossPct: input.config.stopLossPct,
        maxRiskPerTradePct: input.config.maxRiskPerTradePct,
        maxPositionPctEquity: input.config.maxPositionPctEquity,
        maxParticipationPctLiquidity: input.config.maxParticipationPctLiquidity,
        maxAggregateExposurePct: input.config.maxAggregateExposurePct,
        aggregateExposureUsd: usd(exposure),
        feeBps: input.config.feeBps,
        maxSlippageBps: input.config.maxSlippageBps,
        maxPriceImpactBps: input.config.maxPriceImpactBps,
        spreadBpsEstimate: input.config.spreadBpsEstimate,
      });
      if (!sized.ok || d(sized.qty).lte(0)) {
        rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: sized.ok ? "SIZE_ZERO" : sized.reason });
      } else if (!pending.some((order) => order.pairAddress === obs.pairAddress)) {
        pending.push({
          observationId: obs.id,
          pairAddress: obs.pairAddress,
          side: "BUY",
          qty: sized.qty,
          eligibleAtMs: now + input.latencyMs,
        });
      }
    }
    if (intent === "EXIT_LONG" && positions.has(obs.pairAddress)) {
      const position = positions.get(obs.pairAddress)!;
      const gate = evaluateRisk({
        engineStatus: "RUNNING",
        side: "SELL",
        intent: "EXIT",
        freshness: obs.freshness,
        allowDelayedExits: true,
        openPositions: positions.size,
        maxPositions: input.config.maxPositions,
        dailyPnlUsd: usd(realized),
        startingBalanceUsd: input.initialCashUsd,
        maxDailyLossPct: input.config.maxDailyLossPct,
        valuation: "LIVE",
      });
      if (gate.decision !== "PASS") {
        rejected.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: gate.reasonCodes.join(",") });
      } else if (!pending.some((order) => order.pairAddress === obs.pairAddress && order.side === "SELL")) {
        pending.push({
          observationId: obs.id,
          pairAddress: obs.pairAddress,
          side: "SELL",
          qty: position.qty,
          eligibleAtMs: now + input.latencyMs,
        });
      }
    }
    markEquity();
  }

  const span =
    observations.length < 2 ? 0 : Date.parse(observations.at(-1)!.receivedAt) - Date.parse(observations[0]!.receivedAt);
  const ending = equitySeries.at(-1) ?? null;
  const returnPct =
    ending === null ? null : d(ending).minus(d(input.initialCashUsd)).div(d(input.initialCashUsd)).mul(100).toFixed(6);
  return {
    blocked: false,
    blockReason: null,
    fills,
    rejected,
    closedPnls,
    feesUsd: usd(fees),
    endingEquityUsd: ending,
    returnPct: closedPnls.length === 0 ? null : returnPct,
    equitySeries,
    exposureSeries,
    observationSpanMs: span,
  };
}

export function scoreWindow(simulation: ResearchSimulation, startMs: number, endMs: number): {
  returnPct: string | null;
  sampleSize: number;
  closedPnls: string[];
} {
  const closed = simulation.fills.filter(
    (fill) => fill.side === "SELL" && Date.parse(fill.filledAt) >= startMs && Date.parse(fill.filledAt) <= endMs && fill.pnlUsd !== null,
  );
  if (closed.length === 0) return { returnPct: null, sampleSize: 0, closedPnls: [] };
  const pnl = closed.reduce((total, fill) => total.plus(d(fill.pnlUsd!)), d("0"));
  return {
    returnPct: pnl.toFixed(6),
    sampleSize: closed.length,
    closedPnls: closed.map((fill) => fill.pnlUsd!),
  };
}

function emptySimulation(reason: string): ResearchSimulation {
  return {
    blocked: true,
    blockReason: reason,
    fills: [],
    rejected: [],
    closedPnls: [],
    feesUsd: "0.00000000",
    endingEquityUsd: null,
    returnPct: null,
    equitySeries: [],
    exposureSeries: [],
    observationSpanMs: null,
  };
}

function exposureNotional(positions: Map<string, Position>, seenPrice: Map<string, string>): Decimal {
  let total = d("0");
  for (const position of positions.values()) {
    const mark = seenPrice.get(position.pairAddress);
    if (mark) total = total.plus(d(position.qty).mul(d(mark)));
  }
  return total;
}

function toFill(
  order: Pending,
  fill: { qty: string; priceUsd: string; feeUsd: string; slippageBps: string; notionalUsd: string },
  obs: BacktestObservation,
  pnlUsd: string | null,
): ResearchFill {
  return {
    observationId: order.observationId,
    pairAddress: order.pairAddress,
    side: order.side,
    qty: fill.qty,
    priceUsd: fill.priceUsd,
    feeUsd: fill.feeUsd,
    slippageBps: fill.slippageBps,
    notionalUsd: fill.notionalUsd,
    pnlUsd,
    filledAt: obs.receivedAt,
  };
}
