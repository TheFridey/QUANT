/**
 * Pre-trade estimates for the paper ticket and close dialogs. Display only: the engine re-quotes
 * every order from its own observation, so these are labelled "est." in the UI.
 *
 * Impact follows the engine's DEX model (audit B2): constant product on the per-side reserve
 * (liquidity / 2), never below the older linear notional / liquidity estimate.
 */
export function estimateImpactBps(side: "BUY" | "SELL", notionalUsd: number, liquidityUsd: number | null): number | null {
  if (!liquidityUsd || liquidityUsd <= 0 || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  const reserve = liquidityUsd / 2;
  const constantProduct = side === "BUY" ? notionalUsd / reserve : notionalUsd / (reserve + notionalUsd);
  return Math.max(constantProduct, notionalUsd / liquidityUsd) * 10_000;
}

export type TicketEstimate = {
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  impactBps: number | null;
  impactUsd: number | null;
  /** BUY: loss if the strategy stop is hit. SELL: null. */
  stopRiskUsd: number | null;
  /** SELL: proceeds after fee and impact. BUY: null. */
  proceedsUsd: number | null;
  postTradeExposureUsd: number | null;
};

export function estimateTicket(input: {
  side: "BUY" | "SELL";
  priceUsd: number;
  qty: number;
  liquidityUsd: number | null;
  feeBps: number;
  spreadBps: number;
  stopLossPct: number;
  exposureUsd: number | null;
}): TicketEstimate {
  const notionalUsd = input.qty * input.priceUsd;
  const impactBps = estimateImpactBps(input.side, notionalUsd, input.liquidityUsd);
  const costBps = (impactBps ?? 0) + input.spreadBps / 2;
  const impactUsd = impactBps === null ? null : (notionalUsd * costBps) / 10_000;
  const feeUsd = (notionalUsd * input.feeBps) / 10_000;
  const buying = input.side === "BUY";
  return {
    qty: input.qty,
    notionalUsd,
    feeUsd,
    impactBps,
    impactUsd,
    stopRiskUsd: buying ? (notionalUsd * input.stopLossPct) / 100 + feeUsd + (impactUsd ?? 0) : null,
    proceedsUsd: buying ? null : notionalUsd - feeUsd - (impactUsd ?? 0),
    postTradeExposureUsd:
      input.exposureUsd === null ? null : Math.max(0, input.exposureUsd + (buying ? notionalUsd : -notionalUsd)),
  };
}
