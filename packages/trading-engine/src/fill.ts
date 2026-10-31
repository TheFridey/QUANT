import { bps, d, price, qty, usd, type OrderSide, type ReasonCode, Decimal } from "@odin/shared";
import { costModelForInstrument, dexImpactBps, maxSellNotionalWithinImpact } from "./cost-model.js";

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
  /** Quantity left unfilled by the exit policy (risk-reducing SELL above maxExitImpactBps); "0" when fully filled. */
  remainderQty: string;
};

/**
 * Exit execution policy (audit C3). Risk-reducing SELLs (EXIT, FLATTEN, protection closes,
 * reduce-only OPERATOR) are never rejected for impact: they ignore the entry caps
 * (maxSlippageBps / maxPriceImpactBps), fill as much as stays within maxExitImpactBps at the
 * modelled worse price, and report the rest as `remainderQty` for a pending reduce order.
 */
export type ExitPolicy = { maxExitImpactBps: string };

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
  /** Set only for risk-reducing SELLs. BUYs always use the entry caps. */
  exitPolicy?: ExitPolicy | null;
}): { ok: true; fill: FillQuote } | { ok: false; reason: ReasonCode } {
  const mid = d(input.midPriceUsd);
  const requested = d(input.quantity);
  if (mid.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  if (requested.lte(0)) return { ok: false, reason: "NON_POSITIVE_QTY" };

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
  const exitPolicy = input.side === "SELL" ? (input.exitPolicy ?? null) : null;
  let quantity = requested;
  if (exitPolicy && model.applyDexImpact) {
    const cap = d(exitPolicy.maxExitImpactBps);
    if (dexImpactBps("SELL", requested.mul(mid), liquidity).gt(cap)) {
      quantity = Decimal.min(requested, maxSellNotionalWithinImpact(cap, liquidity).div(mid));
      if (d(qty(quantity)).lte(0)) return { ok: false, reason: "PRICE_IMPACT_LIMIT" };
    }
  }
  const impact = model.applyDexImpact ? dexImpactBps(input.side, quantity.mul(mid), liquidity) : d("0");
  if (!exitPolicy) {
    if (impact.gt(d(input.maxSlippageBps))) return { ok: false, reason: "SLIPPAGE_LIMIT" };
    if (input.maxPriceImpactBps && impact.gt(d(input.maxPriceImpactBps))) {
      return { ok: false, reason: "PRICE_IMPACT_LIMIT" };
    }
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
  // Realised slippage from mid, including any adverse gap fill — never below the modelled value.
  const modelled = impact.plus(spreadBps.div(2));
  const realised = d(priceUsd).minus(mid).abs().div(mid).mul(10000);
  return {
    ok: true,
    fill: {
      qty: qtyUsd,
      priceUsd,
      notionalUsd,
      feeUsd,
      slippageBps: bps(Decimal.max(modelled, realised)),
      liquidityUsd: usd(liquidity.gt(0) ? liquidity : d(model.minLiquidityUsd)),
      spreadBps: bps(spreadBps),
      impactBps: bps(impact),
      estimatedCostUsd,
      remainderQty: qty(requested.minus(d(qtyUsd))),
    },
  };
}
