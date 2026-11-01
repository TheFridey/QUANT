/**
 * ASCEND-02/03 bar research simulator. Long/flat only: QUANT cannot short, so no strategy here may.
 *
 * Point-in-time contract: at bar i the strategy receives a frozen copy of bars[0..i] (all closed) and
 * returns a target position. The order fills at the OPEN of bar i+1, never at the close it was decided on,
 * and pays `costBpsPerSide` on every change of position. Marks use closes. Nothing after bar i is reachable
 * from the strategy, so look-ahead is structurally impossible rather than merely discouraged.
 */

export type ResearchBar = {
  /** Bar open, epoch ms. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type StrategyContext = {
  /** The last `lookback` closed bars, ending with the decision bar. Frozen. */
  bars: readonly ResearchBar[];
  /** Current position: 0 flat, 1 long. */
  position: 0 | 1;
  /** Bars since the current position was opened (0 when flat). */
  barsInPosition: number;
  /** Entry fill price of the current position, null when flat. */
  entryPrice: number | null;
  /** Seeded RNG for randomised controls only. */
  random: () => number;
};

export type ResearchStrategy = {
  id: string;
  /** Warm-up bars before the first decision. */
  lookback: number;
  decide(ctx: StrategyContext): 0 | 1;
};

export type SimTrade = {
  entryT: number;
  exitT: number;
  entryPrice: number;
  exitPrice: number;
  bars: number;
  grossReturn: number;
  netReturn: number;
};

export type SimResult = {
  /** Net log-free simple return of each bar from `startIndex` on (0 when flat and not trading). */
  barReturns: number[];
  /** Gross (cost-free) bar returns, same indexing. */
  grossBarReturns: number[];
  barTimes: number[];
  trades: SimTrade[];
  exposure: number;
  turnover: number;
  costBpsPerSide: number;
};

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate over bars[startIndex..endIndex) (decisions) using earlier bars as history. Any position still open
 * at the end is closed at the last bar's close with cost, so every trade is accounted for.
 */
export function simulate(input: {
  strategy: ResearchStrategy;
  bars: readonly ResearchBar[];
  startIndex: number;
  endIndex: number;
  costBpsPerSide: number;
  seed?: number;
}): SimResult {
  const { strategy, bars, costBpsPerSide } = input;
  if (!(costBpsPerSide >= 0)) throw new Error("costBpsPerSide must be >= 0");
  for (let i = 1; i < bars.length; i += 1) if (!(bars[i]!.t > bars[i - 1]!.t)) throw new Error("bars must be strictly increasing in time");
  const cost = costBpsPerSide / 10_000;
  const start = Math.max(input.startIndex, strategy.lookback);
  const end = Math.min(input.endIndex, bars.length);
  const random = mulberry(input.seed ?? 1);
  const barReturns: number[] = [];
  const grossBarReturns: number[] = [];
  const barTimes: number[] = [];
  const trades: SimTrade[] = [];
  let position: 0 | 1 = 0;
  let barsInPosition = 0;
  let entryPrice: number | null = null;
  let entryT = 0;
  let exposed = 0;
  let sides = 0;

  for (let i = start; i < end - 1; i += 1) {
    // Only the strategy's own look-back window, ending at the decision bar: O(n·L), never a future bar.
    const view = Object.freeze(bars.slice(Math.max(0, i + 1 - strategy.lookback), i + 1));
    const target = strategy.decide({ bars: view, position, barsInPosition, entryPrice, random });
    if (target !== 0 && target !== 1) throw new Error(`${strategy.id} returned an invalid position`);
    const next = bars[i + 1]!;
    const cur = bars[i]!;
    let gross = 0;
    let net = 0;
    if (position === 1 && target === 1) {
      gross = next.close / cur.close - 1;
      net = gross;
    } else if (position === 0 && target === 1) {
      // Buy at next open, mark to next close.
      gross = next.close / next.open - 1;
      net = (next.close / (next.open * (1 + cost))) - 1;
      entryPrice = next.open;
      entryT = next.t;
      barsInPosition = 0;
      sides += 1;
    } else if (position === 1 && target === 0) {
      // Sell at next open; the overnight/inter-bar move up to the open still accrues.
      gross = next.open / cur.close - 1;
      net = (next.open * (1 - cost)) / cur.close - 1;
      const g = next.open / (entryPrice as number) - 1;
      trades.push({ entryT, exitT: next.t, entryPrice: entryPrice as number, exitPrice: next.open, bars: barsInPosition + 1, grossReturn: g, netReturn: ((next.open * (1 - cost)) / ((entryPrice as number) * (1 + cost))) - 1 });
      entryPrice = null;
      sides += 1;
    }
    position = target;
    if (position === 1) {
      barsInPosition += 1;
      exposed += 1;
    } else {
      barsInPosition = 0;
    }
    barReturns.push(net);
    grossBarReturns.push(gross);
    barTimes.push(next.t);
  }

  if (position === 1 && entryPrice !== null && barReturns.length > 0) {
    const last = bars[end - 1]!;
    barReturns[barReturns.length - 1] = (1 + barReturns[barReturns.length - 1]!) * (1 - cost) - 1;
    trades.push({ entryT, exitT: last.t, entryPrice, exitPrice: last.close, bars: barsInPosition, grossReturn: last.close / entryPrice - 1, netReturn: (last.close * (1 - cost)) / (entryPrice * (1 + cost)) - 1 });
    sides += 1;
  }
  const n = Math.max(1, barReturns.length);
  return { barReturns, grossBarReturns, barTimes, trades, exposure: exposed / n, turnover: sides / n, costBpsPerSide };
}
