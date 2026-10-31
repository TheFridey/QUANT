import { d, isTradableQuote, usd, type StrategyConfig, Decimal } from "@odin/shared";
import {
  evaluateExitRules,
  quoteFill,
  qtyForNotional,
  maxEntryNotional,
} from "@odin/trading-engine";
import { reportDataQuality } from "./quality.js";
import type {
  BacktestEngineParams,
  BacktestObservation,
  BacktestResult,
  EquityPoint,
  SimulatedTrade,
} from "./types.js";

type OpenPosition = {
  pairAddress: string;
  baseSymbol: string;
  qty: string;
  avgCostUsd: string;
  openedAt: string;
  peakMarkUsd: string;
};

type PendingOrder = {
  id: string;
  pairAddress: string;
  baseSymbol: string;
  side: "BUY" | "SELL";
  intent: string;
  qty: string;
  eligibleAt: string;
  reasonCodes: string[];
  submittedAt: string;
};

/**
 * Event-driven historical replay.
 * Observations are processed in time order. Fills only occur from prices available
 * at event time + latency. No look-ahead: pending orders cannot see future marks.
 */
export function runBacktest(observations: BacktestObservation[], params: BacktestEngineParams): BacktestResult {
  const quality = reportDataQuality(observations);
  const windowed = observations
    .filter((obs) => {
      const t = Date.parse(obs.receivedAt);
      return t >= Date.parse(params.startAt) && t <= Date.parse(params.endAt);
    })
    .sort((a, b) => {
      const dt = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
      if (dt !== 0) return dt;
      return obsIdCmp(a.id, b.id);
    });

  const assumptions = [
    ...quality.assumptions,
    `Latency before fill eligibility: ${params.latencyMs} ms.`,
    `Fees: ${params.config.feeBps} bps; max slippage: ${params.config.maxSlippageBps} bps.`,
    `Spread estimate: ${params.config.spreadBpsEstimate} bps half-spread applied.`,
    "Paper venue only — there is no real-money graduation path.",
    params.forceLiquidateAtEnd
      ? "Open positions are force-liquidated at end using the last available mark."
      : "Open positions at end remain marked; equity may be incomplete without marks.",
  ];

  let cash = d(params.initialBalanceUsd);
  let fees = d("0");
  const positions = new Map<string, OpenPosition>();
  const pending: PendingOrder[] = [];
  const trades: SimulatedTrade[] = [];
  const closedTradePnls: string[] = [];
  const equityCurve: EquityPoint[] = [];
  const rejectedOrders: BacktestResult["rejectedOrders"] = [];
  const lastMark = new Map<string, BacktestObservation>();
  let tradeSeq = 0;

  const pushEquity = (at: string) => {
    equityCurve.push(markToMarket(at, cash, positions, lastMark));
  };

  pushEquity(params.startAt);

  for (const obs of windowed) {
    lastMark.set(obs.pairAddress, obs);
    // 1) Attempt fills for orders that became eligible at or before this event.
    const stillPending: PendingOrder[] = [];
    for (const order of pending) {
      if (Date.parse(order.eligibleAt) > Date.parse(obs.receivedAt)) {
        stillPending.push(order);
        continue;
      }
      // Fill only if this observation is for the order's pair — no cross-pair leakage.
      if (order.pairAddress !== obs.pairAddress) {
        stillPending.push(order);
        continue;
      }
      const filled = tryFill(order, obs, params.config, cash, positions);
      if (!filled.ok) {
        rejectedOrders.push({ at: obs.receivedAt, pairAddress: order.pairAddress, reason: filled.reason });
        continue;
      }
      cash = filled.cash;
      fees = fees.plus(d(filled.trade.feeUsd));
      trades.push({ ...filled.trade, id: `bt_${++tradeSeq}` });
      if (filled.closedPnl !== null) closedTradePnls.push(filled.closedPnl);
      if (filled.position) positions.set(order.pairAddress, filled.position);
      else positions.delete(order.pairAddress);
      if (filled.remainderQty && d(filled.remainderQty).gt(0)) {
        stillPending.push({
          ...order,
          id: `${order.id}_rem`,
          qty: filled.remainderQty,
          reasonCodes: [...order.reasonCodes, "EXIT_PARTIAL_REMAINDER"],
        });
      }
    }
    pending.length = 0;
    pending.push(...stillPending);

    // 2) Update trailing peaks for open positions on this pair.
    const held = positions.get(obs.pairAddress);
    if (held && obs.priceUsd && d(obs.priceUsd).gt(0)) {
      if (d(obs.priceUsd).gt(held.peakMarkUsd)) {
        held.peakMarkUsd = obs.priceUsd;
      }
    }

    // 3) Evaluate exits then entries from information available at this timestamp only.
    const exitIntent = evaluateExit(obs, positions.get(obs.pairAddress), params.config);
    if (exitIntent && !hasPending(pending, obs.pairAddress, "SELL")) {
      const pos = positions.get(obs.pairAddress)!;
      pending.push({
        id: `pend_${tradeSeq + pending.length + 1}`,
        pairAddress: obs.pairAddress,
        baseSymbol: pos.baseSymbol,
        side: "SELL",
        intent: exitIntent.intent,
        qty: pos.qty,
        eligibleAt: new Date(Date.parse(obs.receivedAt) + params.latencyMs).toISOString(),
        reasonCodes: exitIntent.reasonCodes,
        submittedAt: obs.receivedAt,
      });
    } else if (!positions.has(obs.pairAddress) && !hasPending(pending, obs.pairAddress, "BUY")) {
      const entry = evaluateEntry(obs, params.config, positions.size);
      if (entry) {
        const equity = markToMarket(obs.receivedAt, cash, positions, lastMark);
        if (equity.equityUsd === null) {
          rejectedOrders.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "MARK_INCOMPLETE" });
        } else {
          const exposure = d(equity.exposureUsd ?? "0");
          const notional = maxEntryNotional({
            cashUsd: usd(cash),
            equityUsd: equity.equityUsd,
            liquidityUsd: obs.liquidityUsd ?? "0",
            maxPositionPctEquity: params.config.maxPositionPctEquity,
            maxParticipationPctLiquidity: params.config.maxParticipationPctLiquidity,
            feeBps: params.config.feeBps,
            maxSlippageBps: params.config.maxSlippageBps,
            maxRiskPerTradePct: params.config.maxRiskPerTradePct,
            stopLossPct: params.config.stopLossPct,
            midPriceUsd: obs.priceUsd ?? "0",
            maxAggregateExposurePct: params.config.maxAggregateExposurePct,
            aggregateExposureUsd: usd(exposure),
            maxPriceImpactBps: params.config.maxPriceImpactBps,
          });
          if (d(notional).lt(params.config.minOrderNotionalUsd) || !obs.priceUsd) {
            rejectedOrders.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "SIZE_ZERO" });
          } else {
            const quantity = qtyForNotional(notional, obs.priceUsd);
            if (d(quantity).lte(0)) {
              rejectedOrders.push({ at: obs.receivedAt, pairAddress: obs.pairAddress, reason: "SIZE_ZERO" });
            } else {
              pending.push({
                id: `pend_${tradeSeq + pending.length + 1}`,
                pairAddress: obs.pairAddress,
                baseSymbol: obs.baseSymbol,
                side: "BUY",
                intent: "ENTRY",
                qty: quantity,
                eligibleAt: new Date(Date.parse(obs.receivedAt) + params.latencyMs).toISOString(),
                reasonCodes: entry.reasonCodes,
                submittedAt: obs.receivedAt,
              });
            }
          }
        }
      }
    }

    pushEquity(obs.receivedAt);
  }

  // Force liquidation at end — only with last available marks; report misses.
  // Eligible at the mark's own timestamp (not endAt) so the latency guard does not
  // reject a fill that uses a historical mark — we are not looking ahead.
  if (params.forceLiquidateAtEnd && positions.size > 0) {
    for (const [pairAddress, pos] of [...positions.entries()]) {
      const mark = lastMark.get(pairAddress);
      if (!mark || !mark.priceUsd || d(mark.priceUsd).lte(0)) {
        rejectedOrders.push({
          at: params.endAt,
          pairAddress,
          reason: "FORCE_LIQUIDATE_NO_MARK",
        });
        continue;
      }
      const order: PendingOrder = {
        id: `pend_flatten_${pairAddress}`,
        pairAddress,
        baseSymbol: pos.baseSymbol,
        side: "SELL",
        intent: "FLATTEN",
        qty: pos.qty,
        eligibleAt: mark.receivedAt,
        reasonCodes: ["FORCE_LIQUIDATE"],
        submittedAt: mark.receivedAt,
      };
      const filled = tryFill(order, mark, params.config, cash, positions);
      if (!filled.ok) {
        rejectedOrders.push({ at: params.endAt, pairAddress, reason: filled.reason });
        continue;
      }
      cash = filled.cash;
      fees = fees.plus(d(filled.trade.feeUsd));
      trades.push({
        ...filled.trade,
        id: `bt_${++tradeSeq}`,
        eventAt: mark.receivedAt,
        reasonCodes: [...filled.trade.reasonCodes, "FORCE_LIQUIDATE_AT_END"],
      });
      if (filled.closedPnl !== null) closedTradePnls.push(filled.closedPnl);
      // A capped liquidation leaves the rest open and marked to market rather than deleting it.
      if (filled.position) positions.set(pairAddress, filled.position);
      else positions.delete(pairAddress);
    }
    pushEquity(params.endAt);
  }

  const final = markToMarket(params.endAt, cash, positions, lastMark);
  return {
    params,
    dataQuality: quality,
    trades,
    equityCurve,
    closedTradePnls,
    feesUsd: usd(fees),
    finalCashUsd: usd(cash),
    finalEquityUsd: final.equityUsd,
    assumptions,
    rejectedOrders,
  };
}

function evaluateEntry(
  obs: BacktestObservation,
  config: StrategyConfig,
  openCount: number,
): { reasonCodes: string[] } | null {
  if (openCount >= config.maxPositions) return null;
  if (obs.priceUsd === null || d(obs.priceUsd).lte(0)) return null;
  if (obs.liquidityUsd === null || d(obs.liquidityUsd).lt(config.minLiquidityUsd)) return null;
  if (obs.volume24hUsd === null || d(obs.volume24hUsd).lt(config.minVolume24hUsd)) return null;
  if (!isTradableQuote(obs.quoteAddress)) return null;
  if (
    obs.priceChangeM5Pct === null ||
    obs.priceChangeH1Pct === null ||
    obs.txnsM5Buys === null ||
    obs.txnsM5Sells === null
  ) {
    return null;
  }
  if (d(obs.priceChangeM5Pct).abs().gt(config.maxEntryM5ChangePct)) return null;
  if (d(obs.priceChangeM5Pct).lt(config.entryM5ChangePct)) return null;
  if (d(obs.priceChangeH1Pct).lt(config.minH1ChangePct)) return null;
  if (obs.txnsM5Buys <= obs.txnsM5Sells) return null;
  if (config.relativeVolumeMin !== null && obs.volume5mUsd !== null && obs.volume24hUsd !== null) {
    // Rough relative volume proxy: 5m volume vs 24h/288 (5m buckets). Insufficient data → skip filter.
    const expected = d(obs.volume24hUsd).div(288);
    if (expected.gt(0)) {
      const rel = d(obs.volume5mUsd).div(expected);
      if (rel.lt(config.relativeVolumeMin)) return null;
    }
  }
  return { reasonCodes: ["ENTRY_MOMENTUM", "BACKTEST_SIGNAL"] };
}

function evaluateExit(
  obs: BacktestObservation,
  position: OpenPosition | undefined,
  config: StrategyConfig,
): { intent: string; reasonCodes: string[] } | null {
  if (!position || !obs.priceUsd || d(obs.priceUsd).lte(0)) return null;
  const hit = evaluateExitRules({
    markUsd: obs.priceUsd,
    markAt: obs.receivedAt,
    position: {
      direction: "LONG",
      avgCostUsd: position.avgCostUsd,
      openedAt: position.openedAt,
      extremeMarkUsd: position.peakMarkUsd,
      qty: position.qty,
    },
    config: {
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      trailingStopPct: config.trailingStopPct,
      maxHoldingMs: config.maxHoldingMs,
      exitM5ChangePct: config.exitM5ChangePct,
      priceChangeM5Pct: obs.priceChangeM5Pct,
    },
  });
  if (!hit) return null;
  // Keep peak in sync when trailing updates extreme.
  if (hit.extremeMarkUsd) position.peakMarkUsd = hit.extremeMarkUsd;
  return { intent: hit.intent, reasonCodes: hit.reasonCodes };
}

function tryFill(
  order: PendingOrder,
  obs: BacktestObservation,
  config: StrategyConfig,
  cash: Decimal,
  positions: Map<string, OpenPosition>,
):
  | {
      ok: true;
      cash: Decimal;
      trade: Omit<SimulatedTrade, "id">;
      closedPnl: string | null;
      position: OpenPosition | null;
      /** Exit quantity left unfilled by the exit policy; retried on the next observation. */
      remainderQty?: string;
    }
  | { ok: false; reason: string } {
  if (obs.priceUsd === null || d(obs.priceUsd).lte(0)) return { ok: false, reason: "MISSING_PRICE" };
  if (obs.liquidityUsd === null || d(obs.liquidityUsd).lte(0)) return { ok: false, reason: "MISSING_LIQUIDITY" };

  // Look-ahead guard: observation time must be >= eligibility; caller enforces, double-check here.
  if (Date.parse(obs.receivedAt) < Date.parse(order.eligibleAt)) {
    return { ok: false, reason: "LATENCY_NOT_ELIGIBLE" };
  }

  const quoted = quoteFill({
    side: order.side,
    midPriceUsd: obs.priceUsd,
    quantity: order.qty,
    liquidityUsd: obs.liquidityUsd,
    feeBps: config.feeBps,
    maxSlippageBps: config.maxSlippageBps,
    spreadBpsEstimate: config.spreadBpsEstimate,
    maxPriceImpactBps: config.maxPriceImpactBps,
  });
  if (!quoted.ok) return { ok: false, reason: quoted.reason };

  const fill = quoted.fill;
  if (order.side === "BUY") {
    const cost = d(fill.notionalUsd).plus(d(fill.feeUsd));
    if (cash.lt(cost)) return { ok: false, reason: "INSUFFICIENT_CASH" };
    const nextCash = cash.minus(cost);
    const position: OpenPosition = {
      pairAddress: order.pairAddress,
      baseSymbol: order.baseSymbol,
      qty: fill.qty,
      avgCostUsd: fill.priceUsd,
      openedAt: obs.receivedAt,
      peakMarkUsd: fill.priceUsd,
    };
    return {
      ok: true,
      cash: nextCash,
      closedPnl: null,
      position,
      trade: {
        pairAddress: order.pairAddress,
        baseSymbol: order.baseSymbol,
        side: "BUY",
        intent: order.intent,
        qty: fill.qty,
        priceUsd: fill.priceUsd,
        feeUsd: fill.feeUsd,
        slippageBps: fill.slippageBps,
        notionalUsd: fill.notionalUsd,
        pnlUsd: null,
        eventAt: obs.receivedAt,
        observationId: obs.id,
        reasonCodes: order.reasonCodes,
      },
    };
  }

  const held = positions.get(order.pairAddress);
  if (!held || d(held.qty).lte(0)) return { ok: false, reason: "NO_POSITION" };
  const sellQty = Decimal.min(d(order.qty), d(held.qty));
  const sellQuote = quoteFill({
    side: "SELL",
    midPriceUsd: obs.priceUsd,
    quantity: sellQty.toString(),
    liquidityUsd: obs.liquidityUsd,
    feeBps: config.feeBps,
    maxSlippageBps: config.maxSlippageBps,
    spreadBpsEstimate: config.spreadBpsEstimate,
    maxPriceImpactBps: config.maxPriceImpactBps,
    // Same exit execution policy as the live engine: never rejected for impact, capped at maxExitImpactBps.
    exitPolicy: { maxExitImpactBps: config.maxExitImpactBps },
  });
  if (!sellQuote.ok) return { ok: false, reason: sellQuote.reason };
  const sell = sellQuote.fill;
  const proceeds = d(sell.notionalUsd).minus(d(sell.feeUsd));
  const costBasis = d(held.avgCostUsd).mul(d(sell.qty));
  const pnl = usd(proceeds.minus(costBasis));
  const remainingQty = d(held.qty).minus(d(sell.qty));
  return {
    ok: true,
    cash: cash.plus(proceeds),
    closedPnl: pnl,
    // Keep whatever was not sold; a partial exit never makes the rest of the position disappear.
    position: remainingQty.gt(0) ? { ...held, qty: remainingQty.toFixed(8) } : null,
    remainderQty: sell.remainderQty,
    trade: {
      pairAddress: order.pairAddress,
      baseSymbol: order.baseSymbol,
      side: "SELL",
      intent: order.intent,
      qty: sell.qty,
      priceUsd: sell.priceUsd,
      feeUsd: sell.feeUsd,
      slippageBps: sell.slippageBps,
      notionalUsd: sell.notionalUsd,
      pnlUsd: pnl,
      eventAt: obs.receivedAt,
      observationId: obs.id,
      reasonCodes: order.reasonCodes,
    },
  };
}

function markToMarket(
  at: string,
  cash: Decimal,
  positions: Map<string, OpenPosition>,
  lastMark: Map<string, BacktestObservation>,
): EquityPoint {
  if (positions.size === 0) {
    return {
      at,
      cashUsd: usd(cash),
      equityUsd: usd(cash),
      exposureUsd: "0.00000000",
      valuation: "CASH_ONLY",
    };
  }
  let exposure = d("0");
  for (const [pair, pos] of positions) {
    const mark = lastMark.get(pair);
    if (!mark?.priceUsd || d(mark.priceUsd).lte(0)) {
      return {
        at,
        cashUsd: usd(cash),
        equityUsd: null,
        exposureUsd: null,
        valuation: "INCOMPLETE",
      };
    }
    exposure = exposure.plus(d(pos.qty).mul(d(mark.priceUsd)));
  }
  return {
    at,
    cashUsd: usd(cash),
    equityUsd: usd(cash.plus(exposure)),
    exposureUsd: usd(exposure),
    valuation: "REPLAY",
  };
}

function hasPending(pending: PendingOrder[], pairAddress: string, side: "BUY" | "SELL"): boolean {
  return pending.some((order) => order.pairAddress === pairAddress && order.side === side);
}

function obsIdCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
