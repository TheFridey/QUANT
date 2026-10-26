import { d, qty, usd, Decimal } from "@odin/shared";

export function maxEntryNotional(input: {
  cashUsd: string;
  equityUsd: string;
  liquidityUsd: string;
  maxPositionPctEquity: string;
  maxParticipationPctLiquidity: string;
  feeBps: string;
  maxSlippageBps: string;
}): string {
  const budget = d(input.equityUsd).mul(d(input.maxPositionPctEquity)).div(100);
  const participation = d(input.liquidityUsd).mul(d(input.maxParticipationPctLiquidity)).div(100);
  const multiplier = d("1").plus(d(input.maxSlippageBps).div(10000)).mul(d("1").plus(d(input.feeBps).div(10000)));
  const cashCap = d(input.cashUsd).div(multiplier);
  const cap = Decimal.min(budget, participation, cashCap);
  if (cap.lte(0)) return usd(new Decimal(0));
  return usd(cap);
}

export function qtyForNotional(notionalUsd: string, midPriceUsd: string): string {
  if (d(midPriceUsd).lte(0)) return qty(new Decimal(0));
  return qty(d(notionalUsd).div(d(midPriceUsd)));
}
