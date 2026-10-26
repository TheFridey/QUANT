import { bps, d, price, qty, usd, type OrderSide, type ReasonCode, Decimal } from "@odin/shared";

export type FillQuote = {
  qty: string;
  priceUsd: string;
  notionalUsd: string;
  feeUsd: string;
  slippageBps: string;
  liquidityUsd: string;
  spreadBps: string;
  impactBps: string;
  estimatedCostUsd: string;
};

export function quoteFill(input: {
  side: OrderSide;
  midPriceUsd: string;
  quantity: string;
  liquidityUsd: string;
  feeBps: string;
  maxSlippageBps: string;
  spreadBpsEstimate?: string;
  maxPriceImpactBps?: string;
}): { ok: true; fill: FillQuote } | { ok: false; reason: ReasonCode } {
  const mid = d(input.midPriceUsd);
  const quantity = d(input.quantity);
  const liquidity = d(input.liquidityUsd);
  if (mid.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  if (quantity.lte(0)) return { ok: false, reason: "NON_POSITIVE_QTY" };
  if (liquidity.lte(0)) return { ok: false, reason: "MISSING_LIQUIDITY" };

  const spreadBps = d(input.spreadBpsEstimate ?? "0");
  const impact = quantity.mul(mid).div(liquidity).mul(10000);
  if (impact.gt(d(input.maxSlippageBps))) return { ok: false, reason: "SLIPPAGE_LIMIT" };
  if (input.maxPriceImpactBps && impact.gt(d(input.maxPriceImpactBps))) {
    return { ok: false, reason: "PRICE_IMPACT_LIMIT" };
  }

  const halfSpread = spreadBps.div(10000).div(2);
  const slip = impact.div(10000);
  const rawPrice =
    input.side === "BUY"
      ? mid.mul(new Decimal(1).plus(slip).plus(halfSpread))
      : mid.mul(new Decimal(1).minus(slip).minus(halfSpread));
  if (rawPrice.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  const priceUsd = price(rawPrice);
  const qtyUsd = qty(quantity);
  const notionalUsd = usd(d(qtyUsd).mul(d(priceUsd)));
  const feeUsd = usd(d(notionalUsd).mul(d(input.feeBps).div(10000)));
  const spreadCost = usd(d(notionalUsd).mul(halfSpread));
  const estimatedCostUsd = usd(d(feeUsd).plus(d(spreadCost)));
  return {
    ok: true,
    fill: {
      qty: qtyUsd,
      priceUsd,
      notionalUsd,
      feeUsd,
      slippageBps: bps(impact.plus(spreadBps.div(2))),
      liquidityUsd: usd(liquidity),
      spreadBps: bps(spreadBps),
      impactBps: bps(impact),
      estimatedCostUsd,
    },
  };
}
