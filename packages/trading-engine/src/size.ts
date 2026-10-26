import { d, qty, usd, Decimal } from "@odin/shared";

export function maxEntryNotional(input: {
  cashUsd: string;
  equityUsd: string;
  liquidityUsd: string;
  maxPositionPctEquity: string;
  maxParticipationPctLiquidity: string;
  feeBps: string;
  maxSlippageBps: string;
  maxRiskPerTradePct?: string;
  stopLossPct?: string;
  midPriceUsd?: string;
  maxAggregateExposurePct?: string;
  aggregateExposureUsd?: string;
  maxPriceImpactBps?: string;
}): string {
  const budget = d(input.equityUsd).mul(d(input.maxPositionPctEquity)).div(100);
  const participation = d(input.liquidityUsd).mul(d(input.maxParticipationPctLiquidity)).div(100);
  const multiplier = d("1").plus(d(input.maxSlippageBps).div(10000)).mul(d("1").plus(d(input.feeBps).div(10000)));
  const cashCap = d(input.cashUsd).div(multiplier);
  let cap = Decimal.min(budget, participation, cashCap);

  if (input.maxRiskPerTradePct && input.stopLossPct && input.midPriceUsd && d(input.midPriceUsd).gt(0) && d(input.stopLossPct).gt(0)) {
    const riskBudget = d(input.equityUsd).mul(d(input.maxRiskPerTradePct)).div(100);
    const stopDistance = d(input.midPriceUsd).mul(d(input.stopLossPct)).div(100);
    if (stopDistance.gt(0)) {
      const qtyFromRisk = riskBudget.div(stopDistance);
      const notionalFromRisk = qtyFromRisk.mul(d(input.midPriceUsd));
      cap = Decimal.min(cap, notionalFromRisk);
    }
  }

  if (input.maxAggregateExposurePct && input.aggregateExposureUsd !== undefined) {
    const exposureCap = d(input.equityUsd).mul(d(input.maxAggregateExposurePct)).div(100).minus(d(input.aggregateExposureUsd));
    if (exposureCap.lte(0)) return usd(new Decimal(0));
    cap = Decimal.min(cap, exposureCap);
  }

  if (input.maxPriceImpactBps && d(input.liquidityUsd).gt(0)) {
    const impactCap = d(input.liquidityUsd).mul(d(input.maxPriceImpactBps)).div(10000);
    cap = Decimal.min(cap, impactCap);
  }

  if (cap.lte(0)) return usd(new Decimal(0));
  return usd(cap);
}

export function qtyForNotional(notionalUsd: string, midPriceUsd: string): string {
  if (d(midPriceUsd).lte(0)) return qty(new Decimal(0));
  return qty(d(notionalUsd).div(d(midPriceUsd)));
}

/** Size from stop distance with explicit cost haircut. Returns null qty when unsafe. */
export function sizeFromStopDistance(input: {
  equityUsd: string;
  cashUsd: string;
  midPriceUsd: string;
  liquidityUsd: string;
  stopLossPct: string;
  maxRiskPerTradePct: string;
  maxPositionPctEquity: string;
  maxParticipationPctLiquidity: string;
  maxAggregateExposurePct: string;
  aggregateExposureUsd: string;
  feeBps: string;
  maxSlippageBps: string;
  maxPriceImpactBps: string;
  spreadBpsEstimate: string;
}): { ok: true; qty: string; notionalUsd: string; reasons: string[] } | { ok: false; reason: string } {
  if (d(input.midPriceUsd).lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  if (d(input.stopLossPct).lte(0)) return { ok: false, reason: "CONFIG_INVALID" };
  const notional = maxEntryNotional({
    cashUsd: input.cashUsd,
    equityUsd: input.equityUsd,
    liquidityUsd: input.liquidityUsd,
    maxPositionPctEquity: input.maxPositionPctEquity,
    maxParticipationPctLiquidity: input.maxParticipationPctLiquidity,
    feeBps: input.feeBps,
    maxSlippageBps: input.maxSlippageBps,
    maxRiskPerTradePct: input.maxRiskPerTradePct,
    stopLossPct: input.stopLossPct,
    midPriceUsd: input.midPriceUsd,
    maxAggregateExposurePct: input.maxAggregateExposurePct,
    aggregateExposureUsd: input.aggregateExposureUsd,
    maxPriceImpactBps: input.maxPriceImpactBps,
  });
  if (d(notional).lte(0)) return { ok: false, reason: "SIZE_ZERO" };
  const costHaircut = d("1").plus(d(input.spreadBpsEstimate).div(10000)).plus(d(input.feeBps).div(10000));
  const adjusted = usd(d(notional).div(costHaircut));
  const quantity = qtyForNotional(adjusted, input.midPriceUsd);
  if (d(quantity).lte(0)) return { ok: false, reason: "SIZE_ZERO" };
  return {
    ok: true,
    qty: quantity,
    notionalUsd: adjusted,
    reasons: ["STOP_DISTANCE_SIZE", "SIZE_COMPUTED", "COST_ESTIMATED"],
  };
}
