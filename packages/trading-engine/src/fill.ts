import { bps, d, price, qty, usd, type OrderSide, type ReasonCode, Decimal } from "@odin/shared";

export type FillQuote = {
  qty: string;
  priceUsd: string;
  notionalUsd: string;
  feeUsd: string;
  slippageBps: string;
  liquidityUsd: string;
};

export function quoteFill(input: {
  side: OrderSide;
  midPriceUsd: string;
  quantity: string;
  liquidityUsd: string;
  feeBps: string;
  maxSlippageBps: string;
}): { ok: true; fill: FillQuote } | { ok: false; reason: ReasonCode } {
  const mid = d(input.midPriceUsd);
  const quantity = d(input.quantity);
  const liquidity = d(input.liquidityUsd);
  if (mid.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  if (quantity.lte(0)) return { ok: false, reason: "NON_POSITIVE_QTY" };
  if (liquidity.lte(0)) return { ok: false, reason: "MISSING_LIQUIDITY" };
  const slippage = quantity.mul(mid).div(liquidity).mul(10000);
  if (slippage.gt(d(input.maxSlippageBps))) return { ok: false, reason: "SLIPPAGE_LIMIT" };
  const slip = slippage.div(10000);
  const rawPrice = input.side === "BUY" ? mid.mul(new Decimal(1).plus(slip)) : mid.mul(new Decimal(1).minus(slip));
  if (rawPrice.lte(0)) return { ok: false, reason: "NON_POSITIVE_PRICE" };
  const priceUsd = price(rawPrice);
  const qtyUsd = qty(quantity);
  const notionalUsd = usd(d(qtyUsd).mul(d(priceUsd)));
  const feeUsd = usd(d(notionalUsd).mul(d(input.feeBps).div(10000)));
  return {
    ok: true,
    fill: {
      qty: qtyUsd,
      priceUsd,
      notionalUsd,
      feeUsd,
      slippageBps: bps(slippage),
      liquidityUsd: usd(liquidity),
    },
  };
}
