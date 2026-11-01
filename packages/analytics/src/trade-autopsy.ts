import { Decimal, d, usd } from "@odin/shared";

/**
 * Trade autopsy (ASCEND-00): an evidence record for each closed round trip, built only from what the
 * ledger and observations recorded. It splits realised P&L into the mid-to-mid price move, slippage and
 * fees, and reports entry features and excursions. Flags are factual comparisons, never causal claims;
 * anything the system did not record is listed in `notRecorded` rather than estimated.
 */

export type AutopsyFill = {
  id: string;
  side: "BUY" | "SELL";
  qty: string;
  priceUsd: string;
  notionalUsd: string;
  feeUsd: string;
  slippageBps: string;
  createdAt: string;
  /** Mid from the fill's own observation; null when that observation is unavailable. */
  observedMidUsd: string | null;
  ownerScope: string | null;
  reasonCodes: string[];
  strategyInstanceId: string | null;
};

export type AutopsyEntryContext = {
  priceChangeM5Pct: string | null;
  priceChangeH1Pct: string | null;
  liquidityUsd: string | null;
  pairCreatedAt: string | null;
};

export type AutopsyObservation = { receivedAt: string; priceUsd: string };

export type TradeAutopsy = {
  pairAddress: string;
  baseSymbol: string;
  strategyInstanceId: string | null;
  openedAt: string;
  closedAt: string;
  holdSeconds: number;
  entryNotionalUsd: string;
  exitNotionalUsd: string;
  netPnlUsd: string;
  /** netPnlUsd = midMoveUsd − slippageUsd − feesUsd (to rounding). */
  components: { midMoveUsd: string; slippageUsd: string; feesUsd: string };
  midReturnPct: string;
  costPctOfEntry: string;
  exitOwners: string[];
  exitReasons: string[];
  entry: AutopsyEntryContext & { ageHoursAtEntry: string | null };
  /** Max favourable / adverse mid move vs entry mid over observations strictly inside the trade. */
  mfePct: string | null;
  maePct: string | null;
  observationsInTrade: number;
  /** Stop exits only: how far the exit mid fell beyond the configured stop, in percentage points. */
  stopOvershootPct: string | null;
  flags: Array<"LOSS_FROM_COSTS_ONLY" | "EXIT_ON_FIRST_OBSERVATION" | "STOP_OVERSHOOT" | "MID_RECONSTRUCTED" | "ENTRY_CONTEXT_MISSING">;
  notRecorded: string[];
};

const NOT_RECORDED = ["decisionToFillLatencyMs", "quoteAgeAtDecisionMs", "forecastAtEntry", "regimeAtEntry"];

/** Split one pair's fills, oldest first, into closed round trips: from flat, until flat again. */
export function closedRoundTrips(fills: readonly AutopsyFill[]): AutopsyFill[][] {
  const trips: AutopsyFill[][] = [];
  let current: AutopsyFill[] = [];
  let open = new Decimal(0);
  for (const fill of fills) {
    if (current.length === 0 && fill.side === "SELL") continue; // a sell with no recorded entry
    current.push(fill);
    open = fill.side === "BUY" ? open.plus(d(fill.qty)) : open.minus(d(fill.qty));
    if (open.lte(0)) {
      trips.push(current);
      current = [];
      open = new Decimal(0);
    }
  }
  return trips; // a trailing open position is not a closed trip
}

function midOf(fill: AutopsyFill): { mid: Decimal; reconstructed: boolean } {
  if (fill.observedMidUsd && d(fill.observedMidUsd).gt(0)) return { mid: d(fill.observedMidUsd), reconstructed: false };
  const slip = d(fill.slippageBps).div(10000);
  const factor = fill.side === "BUY" ? new Decimal(1).plus(slip) : new Decimal(1).minus(slip);
  return { mid: d(fill.priceUsd).div(factor), reconstructed: true };
}

function pct(value: Decimal): string {
  return value.mul(100).toDecimalPlaces(4).toFixed(4);
}

export function autopsyRoundTrip(input: {
  pairAddress: string;
  baseSymbol: string;
  fills: readonly AutopsyFill[];
  entry: AutopsyEntryContext | null;
  observations: readonly AutopsyObservation[];
  stopLossPct: string;
}): TradeAutopsy {
  const buys = input.fills.filter((fill) => fill.side === "BUY");
  const sells = input.fills.filter((fill) => fill.side === "SELL");
  let reconstructed = false;
  let midIn = new Decimal(0);
  let midOut = new Decimal(0);
  let qtyIn = new Decimal(0);
  let qtyOut = new Decimal(0);
  for (const fill of buys) {
    const { mid, reconstructed: r } = midOf(fill);
    reconstructed ||= r;
    midIn = midIn.plus(mid.mul(d(fill.qty)));
    qtyIn = qtyIn.plus(d(fill.qty));
  }
  for (const fill of sells) {
    const { mid, reconstructed: r } = midOf(fill);
    reconstructed ||= r;
    midOut = midOut.plus(mid.mul(d(fill.qty)));
    qtyOut = qtyOut.plus(d(fill.qty));
  }
  const entryNotional = buys.reduce((sum, fill) => sum.plus(d(fill.notionalUsd)), new Decimal(0));
  const exitNotional = sells.reduce((sum, fill) => sum.plus(d(fill.notionalUsd)), new Decimal(0));
  const fees = input.fills.reduce((sum, fill) => sum.plus(d(fill.feeUsd)), new Decimal(0));
  const net = exitNotional.minus(entryNotional).minus(fees);
  // midIn/midOut hold mid × qty; the mid move is valued on the quantity actually sold.
  const avgMidIn = qtyIn.gt(0) ? midIn.div(qtyIn) : new Decimal(0);
  const avgMidOut = qtyOut.gt(0) ? midOut.div(qtyOut) : new Decimal(0);
  const midMove = midOut.minus(avgMidIn.mul(qtyOut));
  const slippage = midMove.minus(net).minus(fees);
  const midReturn = avgMidIn.gt(0) ? avgMidOut.div(avgMidIn).minus(1) : new Decimal(0);

  const openedAt = buys[0]?.createdAt ?? input.fills[0]!.createdAt;
  const closedAt = sells.at(-1)?.createdAt ?? input.fills.at(-1)!.createdAt;
  const inside = input.observations.filter(
    (observation) => observation.receivedAt > openedAt && observation.receivedAt <= closedAt && d(observation.priceUsd).gt(0),
  );
  let hi: Decimal | null = null;
  let lo: Decimal | null = null;
  for (const observation of inside) {
    const price = d(observation.priceUsd);
    hi = hi === null || price.gt(hi) ? price : hi;
    lo = lo === null || price.lt(lo) ? price : lo;
  }

  const exitReasons = [...new Set(sells.flatMap((fill) => fill.reasonCodes).filter((code) => code === "STOP_LOSS" || code === "TAKE_PROFIT" || code.startsWith("EXIT_")))];
  const stopExit = exitReasons.includes("STOP_LOSS");
  const overshoot = stopExit ? midReturn.mul(100).neg().minus(d(input.stopLossPct)) : null;

  const flags: TradeAutopsy["flags"] = [];
  if (net.lt(0) && midMove.gte(0)) flags.push("LOSS_FROM_COSTS_ONLY");
  if (inside.length <= 1) flags.push("EXIT_ON_FIRST_OBSERVATION");
  if (overshoot !== null && overshoot.gt(0)) flags.push("STOP_OVERSHOOT");
  if (reconstructed) flags.push("MID_RECONSTRUCTED");
  if (!input.entry) flags.push("ENTRY_CONTEXT_MISSING");

  const ageHours =
    input.entry?.pairCreatedAt != null
      ? new Decimal(Date.parse(openedAt) - Date.parse(input.entry.pairCreatedAt)).div(3_600_000).toDecimalPlaces(2).toFixed(2)
      : null;

  return {
    pairAddress: input.pairAddress,
    baseSymbol: input.baseSymbol,
    strategyInstanceId: buys[0]?.strategyInstanceId ?? null,
    openedAt,
    closedAt,
    holdSeconds: Math.round((Date.parse(closedAt) - Date.parse(openedAt)) / 1000),
    entryNotionalUsd: usd(entryNotional),
    exitNotionalUsd: usd(exitNotional),
    netPnlUsd: usd(net),
    components: { midMoveUsd: usd(midMove), slippageUsd: usd(slippage), feesUsd: usd(fees) },
    midReturnPct: pct(midReturn),
    costPctOfEntry: entryNotional.gt(0) ? pct(slippage.plus(fees).div(entryNotional)) : "0.0000",
    exitOwners: [...new Set(sells.map((fill) => fill.ownerScope ?? "UNKNOWN"))],
    exitReasons,
    entry: {
      priceChangeM5Pct: input.entry?.priceChangeM5Pct ?? null,
      priceChangeH1Pct: input.entry?.priceChangeH1Pct ?? null,
      liquidityUsd: input.entry?.liquidityUsd ?? null,
      pairCreatedAt: input.entry?.pairCreatedAt ?? null,
      ageHoursAtEntry: ageHours,
    },
    mfePct: hi !== null && avgMidIn.gt(0) ? pct(hi.div(avgMidIn).minus(1)) : null,
    maePct: lo !== null && avgMidIn.gt(0) ? pct(lo.div(avgMidIn).minus(1)) : null,
    observationsInTrade: inside.length,
    stopOvershootPct: overshoot === null ? null : overshoot.toDecimalPlaces(4).toFixed(4),
    flags,
    notRecorded: NOT_RECORDED,
  };
}

/** Totals across autopsies: the same decomposition as the per-trade components. */
export function summariseAutopsies(trades: readonly TradeAutopsy[]) {
  const sum = (pick: (trade: TradeAutopsy) => string) => usd(trades.reduce((total, trade) => total.plus(d(pick(trade))), new Decimal(0)));
  return {
    trades: trades.length,
    wins: trades.filter((trade) => d(trade.netPnlUsd).gt(0)).length,
    netPnlUsd: sum((trade) => trade.netPnlUsd),
    midMoveUsd: sum((trade) => trade.components.midMoveUsd),
    slippageUsd: sum((trade) => trade.components.slippageUsd),
    feesUsd: sum((trade) => trade.components.feesUsd),
  };
}
