import { d, usd, worstDataState, type DataState, Decimal } from "@odin/shared";

export type Mark = { priceUsd: string | null; freshness: DataState };

export type PositionInput = {
  pairAddress: string;
  baseSymbol: string;
  baseQty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
};

export type ValuedPosition = PositionInput & {
  markUsd: string | null;
  markState: DataState | "MISSING";
  marketValueUsd: string | null;
  unrealizedPnlUsd: string | null;
};

export type ValuationState = DataState | "INCOMPLETE" | "CASH_ONLY";

export type Valuation = {
  positions: ValuedPosition[];
  cashUsd: string;
  equityUsd: string | null;
  unrealizedPnlUsd: string | null;
  realizedPnlUsd: string;
  valuation: ValuationState;
  marksComplete: boolean;
};

export function valuePortfolio(input: {
  cashUsd: string;
  positions: PositionInput[];
  marks: Record<string, Mark | undefined>;
}): Valuation {
  const realizedPnlUsd = usd(input.positions.reduce((total, position) => total.plus(d(position.realizedPnlUsd)), d("0")));
  const open = input.positions.filter((position) => d(position.baseQty).gt(0));
  if (open.length === 0) {
    return {
      positions: [],
      cashUsd: input.cashUsd,
      equityUsd: input.cashUsd,
      unrealizedPnlUsd: "0.00000000",
      realizedPnlUsd,
      valuation: "CASH_ONLY",
      marksComplete: true,
    };
  }

  let incomplete = false;
  const states: DataState[] = [];
  const positions = open.map((position) => valuePosition(position, input.marks[position.pairAddress], states, () => {
    incomplete = true;
  }));
  if (incomplete) {
    return {
      positions,
      cashUsd: input.cashUsd,
      equityUsd: null,
      unrealizedPnlUsd: null,
      realizedPnlUsd,
      valuation: "INCOMPLETE",
      marksComplete: false,
    };
  }
  const equityUsd = usd(
    positions.reduce((total, position) => total.plus(d(position.marketValueUsd ?? "0")), d(input.cashUsd)),
  );
  const unrealizedPnlUsd = usd(positions.reduce((total, position) => total.plus(d(position.unrealizedPnlUsd ?? "0")), d("0")));
  return {
    positions,
    cashUsd: input.cashUsd,
    equityUsd,
    unrealizedPnlUsd,
    realizedPnlUsd,
    valuation: worstDataState(states) ?? "STALE",
    marksComplete: true,
  };
}

export function performanceReport(input: {
  valuation: Valuation;
  startingBalanceUsd: string;
  feesUsd: string;
  closedTradePnlUsd: string[];
  equitySeries?: string[];
}): {
  valuation: Valuation;
  feesUsd: string;
  wins: number;
  losses: number;
  breakeven: number;
  closedTrades: number;
  winRate: string | null;
  returnPct: string | null;
  avgWinUsd: string | null;
  avgLossUsd: string | null;
  profitFactor: string | null;
  expectancyUsd: string | null;
  maxDrawdownPct: string | null;
  sampleSize: number;
  observed: boolean;
} {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let winSum = new Decimal(0);
  let lossSum = new Decimal(0);
  for (const pnl of input.closedTradePnlUsd) {
    const value = d(pnl);
    if (value.gt(0)) {
      wins += 1;
      winSum = winSum.plus(value);
    } else if (value.lt(0)) {
      losses += 1;
      lossSum = lossSum.plus(value.abs());
    } else breakeven += 1;
  }
  const closedTrades = input.closedTradePnlUsd.length;
  const winRate = closedTrades === 0 ? null : new Decimal(wins).div(closedTrades).toFixed(6);
  const returnPct =
    input.valuation.equityUsd === null
      ? null
      : d(input.valuation.equityUsd)
          .minus(d(input.startingBalanceUsd))
          .div(d(input.startingBalanceUsd))
          .mul(100)
          .toFixed(4);
  const avgWinUsd = wins === 0 ? null : winSum.div(wins).toFixed(8);
  const avgLossUsd = losses === 0 ? null : lossSum.div(losses).toFixed(8);
  const profitFactor = losses === 0 || lossSum.eq(0) ? null : winSum.div(lossSum).toFixed(6);
  const expectancyUsd = closedTrades === 0 ? null : winSum.minus(lossSum).div(closedTrades).toFixed(8);
  const maxDrawdownPct = drawdownPct(input.equitySeries ?? []);
  return {
    valuation: input.valuation,
    feesUsd: input.feesUsd,
    wins,
    losses,
    breakeven,
    closedTrades,
    winRate,
    returnPct,
    avgWinUsd,
    avgLossUsd,
    profitFactor,
    expectancyUsd,
    maxDrawdownPct,
    sampleSize: closedTrades,
    observed: input.valuation.marksComplete,
  };
}

function drawdownPct(series: string[]): string | null {
  if (series.length < 2) return null;
  let peak = d(series[0]!);
  let maxDd = new Decimal(0);
  for (const point of series) {
    const equity = d(point);
    if (equity.gt(peak)) peak = equity;
    if (peak.gt(0)) {
      const dd = peak.minus(equity).div(peak).mul(100);
      if (dd.gt(maxDd)) maxDd = dd;
    }
  }
  return maxDd.toFixed(4);
}

function valuePosition(
  position: PositionInput,
  mark: Mark | undefined,
  states: DataState[],
  markIncomplete: () => void,
): ValuedPosition {
  if (!mark || mark.priceUsd === null || d(mark.priceUsd).lte(0)) {
    markIncomplete();
    return { ...position, markUsd: null, markState: "MISSING", marketValueUsd: null, unrealizedPnlUsd: null };
  }
  states.push(mark.freshness);
  const marketValueUsd = usd(d(position.baseQty).mul(d(mark.priceUsd)));
  const unrealizedPnlUsd = usd(d(marketValueUsd).minus(d(position.baseQty).mul(d(position.avgCostUsd))));
  return {
    ...position,
    markUsd: mark.priceUsd,
    markState: mark.freshness,
    marketValueUsd,
    unrealizedPnlUsd,
  };
}
