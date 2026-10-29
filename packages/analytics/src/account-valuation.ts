import { d } from "@odin/shared";

/**
 * Product-aware account valuation snapshot (§17).
 * Separates cash / equity / buying power / gross / net / reserved / stop-risk /
 * unprotected / realised & unrealised PnL. Stop risk uses actual stop distances
 * when provided — never invents a single global %.
 */
export type PositionValuationInput = {
  instrumentId: string;
  qty: string;
  avgCostUsd: string;
  markUsd: string | null;
  /** Remaining stop distance in USD notional (absolute). */
  stopRiskUsd?: string | null;
  protected: boolean;
  /** Product family label for accounting honesty. */
  productFamily?: "spot_crypto" | "fx" | "etf" | "commodity" | "index_ref" | "unknown";
};

export type AccountValuationSnapshot = {
  cashUsd: string;
  equityUsd: string | null;
  buyingPowerUsd: string | null;
  grossExposureUsd: string;
  netExposureUsd: string;
  reservedUsd: string;
  stopRiskUsd: string;
  unprotectedQtyNotionalUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string | null;
  valuationComplete: boolean;
  limitations: string[];
};

export function computeAccountValuation(input: {
  cashUsd: string;
  reservedUsd?: string;
  realizedPnlUsd?: string;
  positions: PositionValuationInput[];
  /** Optional buying-power override from venue; otherwise cash − reserved. */
  buyingPowerUsd?: string | null;
}): AccountValuationSnapshot {
  const limitations: string[] = [];
  let gross = d("0");
  let net = d("0");
  let stopRisk = d("0");
  let unprotected = d("0");
  let unrealized = d("0");
  let marksComplete = true;

  for (const position of input.positions) {
    if (position.productFamily === "index_ref") {
      limitations.push(`${position.instrumentId}: index reference is not executable product accounting`);
    }
    const qty = d(position.qty);
    if (qty.eq(0)) continue;
    if (position.markUsd === null || !d(position.markUsd).gt(0)) {
      marksComplete = false;
      limitations.push(`${position.instrumentId}: mark unavailable`);
      continue;
    }
    const notional = qty.abs().mul(d(position.markUsd));
    gross = gross.plus(notional);
    net = net.plus(qty.mul(d(position.markUsd)));
    const cost = qty.mul(d(position.avgCostUsd));
    unrealized = unrealized.plus(qty.mul(d(position.markUsd)).minus(cost));
    if (position.stopRiskUsd != null && d(position.stopRiskUsd).gte(0)) {
      stopRisk = stopRisk.plus(d(position.stopRiskUsd));
    } else if (!position.protected) {
      limitations.push(`${position.instrumentId}: stop distance unknown — not inventing global %`);
    }
    if (!position.protected) {
      unprotected = unprotected.plus(notional);
    }
  }

  const reserved = d(input.reservedUsd ?? "0");
  const cash = d(input.cashUsd);
  const equity = marksComplete ? cash.plus(net) : null;
  const buyingPower =
    input.buyingPowerUsd != null
      ? input.buyingPowerUsd
      : cash.minus(reserved).toFixed(8);

  return {
    cashUsd: cash.toFixed(8),
    equityUsd: equity ? equity.toFixed(8) : null,
    buyingPowerUsd: buyingPower,
    grossExposureUsd: gross.toFixed(8),
    netExposureUsd: net.toFixed(8),
    reservedUsd: reserved.toFixed(8),
    stopRiskUsd: stopRisk.toFixed(8),
    unprotectedQtyNotionalUsd: unprotected.toFixed(8),
    realizedPnlUsd: d(input.realizedPnlUsd ?? "0").toFixed(8),
    unrealizedPnlUsd: marksComplete ? unrealized.toFixed(8) : null,
    valuationComplete: marksComplete,
    limitations,
  };
}
