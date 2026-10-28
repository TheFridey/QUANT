import { bps, d, price, qty, usd, type OrderSide, type ReasonCode, Decimal } from "@odin/shared";
import { costModelForInstrument } from "./cost-model.js";

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
  /** Pair / instrument id — selects FX/ETF vs DEX cost model. */
  instrumentId?: string | null;
  /** Adverse gap fill: use this absolute price instead of mid±slip (stops through gaps). */
  adverseFillPriceUsd?: string | null;
}): { ok: true; fill: FillQuote } | { ok: false; reason: ReasonCode } {
  const mid = d(input.midPriceUsd);
  const quantity = d(input.quantity);
  if (mid.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  if (quantity.lte(0)) return { ok: false, reason: "NON_POSITIVE_QTY" };

  const model = costModelForInstrument(input.instrumentId ?? "", {
    feeBps: input.feeBps,
    spreadBpsEstimate: input.spreadBpsEstimate ?? "0",
    minLiquidityUsd: "1",
  });
  const liquidityRaw = d(input.liquidityUsd);
  const liquidity =
    !model.applyDexImpact
      ? d(model.minLiquidityUsd)
      : liquidityRaw.gt(0)
        ? liquidityRaw
        : d("0");
  if (model.applyDexImpact && liquidity.lte(0)) return { ok: false, reason: "MISSING_LIQUIDITY" };

  const spreadBps = d(model.spreadBpsEstimate);
  const impact = model.applyDexImpact
    ? quantity.mul(mid).div(liquidity).mul(10000)
    : d("0");
  if (impact.gt(d(input.maxSlippageBps))) return { ok: false, reason: "SLIPPAGE_LIMIT" };
  if (input.maxPriceImpactBps && impact.gt(d(input.maxPriceImpactBps))) {
    return { ok: false, reason: "PRICE_IMPACT_LIMIT" };
  }

  const halfSpread = spreadBps.div(10000).div(2);
  const slip = impact.div(10000);
  let rawPrice =
    input.side === "BUY"
      ? mid.mul(new Decimal(1).plus(slip).plus(halfSpread))
      : mid.mul(new Decimal(1).minus(slip).minus(halfSpread));
  // Gap-through stops: adverse fill at the mark (worse than trigger), not mid invent.
  if (input.adverseFillPriceUsd) {
    const adverse = d(input.adverseFillPriceUsd);
    if (adverse.gt(0)) {
      rawPrice =
        input.side === "SELL"
          ? Decimal.min(rawPrice, adverse)
          : Decimal.max(rawPrice, adverse);
    }
  }
  if (rawPrice.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  const priceUsd = price(rawPrice);
  const qtyUsd = qty(quantity);
  const notionalUsd = usd(d(qtyUsd).mul(d(priceUsd)));
  const feeUsd = usd(d(notionalUsd).mul(d(model.feeBps).div(10000)));
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
      liquidityUsd: usd(liquidity.gt(0) ? liquidity : d(model.minLiquidityUsd)),
      spreadBps: bps(spreadBps),
      impactBps: bps(impact),
      estimatedCostUsd,
    },
  };
}
