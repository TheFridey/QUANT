import type { ResearchBar, ResearchStrategy, StrategyContext } from "./simulate.js";

/**
 * ASCEND-02 research strategy library. Long/flat, single-instrument, transparent rules. Each entry is a
 * hypothesis to be tested, not a claim. Families that need data QUANT does not hold (order flow, a second
 * cointegrated leg, a broad cross-section) or execution it cannot do (shorting) are catalogued with
 * `supported: false` and the reason, instead of being approximated.
 */

export type StrategyFamily =
  | "TREND"
  | "CROSS_SECTIONAL_MOMENTUM"
  | "MEAN_REVERSION"
  | "BREAKOUT"
  | "MICROSTRUCTURE"
  | "STATISTICAL_RELATIONSHIP"
  | "REGIME_CONDITIONED"
  | "CRYPTO_SPECIFIC"
  | "CONTROL";

export type ParamValue = number;
export type ParamGrid = Record<string, ParamValue[]>;

export type StrategySpec = {
  id: string;
  version: string;
  family: StrategyFamily;
  hypothesis: string;
  rationale: string;
  reference: string | null;
  eligibility: string;
  dataDependencies: string[];
  executionAssumptions: string;
  riskRequirements: string;
  /** Parameter grid explored on training data only. Every point is a recorded trial. */
  grid: ParamGrid;
  supported: boolean;
  unsupportedReason: string | null;
  build: ((params: Record<string, ParamValue>) => ResearchStrategy) | null;
};

const closes = (bars: readonly ResearchBar[], n: number) => bars.slice(-n).map((b) => b.close);
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = avg(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const logRets = (xs: number[]) => xs.slice(1).map((x, i) => Math.log(x / xs[i]!));

function make(id: string, lookback: number, decide: (ctx: StrategyContext) => 0 | 1): ResearchStrategy {
  return { id, lookback, decide };
}

const COMMON = {
  executionAssumptions: "Fill at next bar open; cost per side from the ASCEND-06 model; long/flat only",
  riskRequirements: "Subordinate to the existing risk engine; research verdict only, never auto-promoted",
};

export const STRATEGY_LIBRARY: StrategySpec[] = [
  {
    id: "tsmom",
    version: "1.0.0",
    family: "TREND",
    hypothesis: "An asset's own trailing return over L bars predicts the sign of its next-bar return",
    rationale: "Under-reaction and slow information diffusion create return persistence",
    reference: "Moskowitz, Ooi & Pedersen (2012), Time Series Momentum (queued; not yet read)",
    eligibility: "Any instrument with ≥ 2L bars",
    dataDependencies: ["close"],
    ...COMMON,
    grid: { lookback: [24, 72, 168, 336] },
    supported: true,
    unsupportedReason: null,
    build: ({ lookback }) => make(`tsmom_L${lookback}`, lookback! + 1, (ctx) => {
      const c = closes(ctx.bars, lookback! + 1);
      return c.at(-1)! > c[0]! ? 1 : 0;
    }),
  },
  {
    id: "ma_trend",
    version: "1.0.0",
    family: "TREND",
    hypothesis: "Price above its slow moving average, with the fast average above the slow, marks a persistent uptrend",
    rationale: "Moving-average filters reduce whipsaw relative to raw momentum",
    reference: null,
    eligibility: "Any instrument with ≥ slow bars",
    dataDependencies: ["close"],
    ...COMMON,
    grid: { fast: [12, 24, 48], slow: [96, 168, 336] },
    supported: true,
    unsupportedReason: null,
    build: ({ fast, slow }) => make(`ma_trend_${fast}_${slow}`, slow!, (ctx) => {
      const c = closes(ctx.bars, slow!);
      const f = avg(c.slice(-fast!));
      const s = avg(c);
      return f > s && c.at(-1)! > s ? 1 : 0;
    }),
  },
  {
    id: "donchian_breakout",
    version: "1.0.0",
    family: "BREAKOUT",
    hypothesis: "A close above the prior N-bar high starts a move that continues until the prior M-bar low is broken",
    rationale: "Breakouts from ranges mark new information; the exit channel bounds the loss of a false breakout",
    reference: null,
    eligibility: "Any instrument with ≥ N bars",
    dataDependencies: ["high", "low", "close"],
    ...COMMON,
    grid: { entry: [24, 72, 168], exit: [12, 48] },
    supported: true,
    unsupportedReason: null,
    build: ({ entry, exit }) => make(`donchian_${entry}_${exit}`, Math.max(entry!, exit!) + 1, (ctx) => {
      const prior = ctx.bars.slice(-(Math.max(entry!, exit!) + 1), -1);
      const last = ctx.bars.at(-1)!;
      const high = Math.max(...prior.slice(-entry!).map((b) => b.high));
      const low = Math.min(...prior.slice(-exit!).map((b) => b.low));
      if (ctx.position === 0) return last.close > high ? 1 : 0;
      return last.close < low ? 0 : 1;
    }),
  },
  {
    id: "vol_normalised_trend",
    version: "1.0.0",
    family: "TREND",
    hypothesis: "Trailing return scaled by its own volatility (a t-statistic) above a threshold predicts continuation",
    rationale: "Normalising by volatility makes the signal comparable across calm and turbulent periods",
    reference: "Hurst, Ooi & Pedersen, A Century of Evidence on Trend-Following Investing (queued; not yet read)",
    eligibility: "Any instrument with ≥ L bars",
    dataDependencies: ["close"],
    ...COMMON,
    grid: { lookback: [72, 168, 336], threshold: [0.5, 1, 2] },
    supported: true,
    unsupportedReason: null,
    build: ({ lookback, threshold }) => make(`voltrend_${lookback}_${threshold}`, lookback! + 1, (ctx) => {
      const r = logRets(closes(ctx.bars, lookback! + 1));
      const s = sd(r);
      if (s === 0) return 0;
      const t = (avg(r) / s) * Math.sqrt(r.length);
      return t > threshold! ? 1 : 0;
    }),
  },
  {
    id: "zscore_reversion",
    version: "1.0.0",
    family: "MEAN_REVERSION",
    hypothesis: "A close more than k standard deviations below its N-bar mean reverts towards the mean",
    rationale: "Short-term over-reaction and liquidity-provision premia",
    reference: null,
    eligibility: "Ranging or liquid instruments with ≥ N bars",
    dataDependencies: ["close"],
    ...COMMON,
    grid: { window: [24, 72, 168], entryZ: [1.5, 2, 2.5], maxBars: [12, 48] },
    supported: true,
    unsupportedReason: null,
    build: ({ window, entryZ, maxBars }) => make(`zrev_${window}_${entryZ}_${maxBars}`, window!, (ctx) => {
      const c = closes(ctx.bars, window!);
      const s = sd(c);
      if (s === 0) return 0;
      const z = (c.at(-1)! - avg(c)) / s;
      if (ctx.position === 0) return z < -entryZ! ? 1 : 0;
      // Exit at the mean or after a time stop: a reversion that has not happened is a failed hypothesis.
      return z >= 0 || ctx.barsInPosition >= maxBars! ? 0 : 1;
    }),
  },
  {
    id: "bollinger_reversion",
    version: "1.0.0",
    family: "MEAN_REVERSION",
    hypothesis: "Closes below the lower Bollinger band inside a non-trending window revert to the middle band",
    rationale: "Range-conditioned reversion: only fade moves when the slow trend is flat",
    reference: null,
    eligibility: "Instruments with ≥ 4N bars",
    dataDependencies: ["close"],
    ...COMMON,
    grid: { window: [24, 72], k: [2, 2.5], trendWindow: [168] },
    supported: true,
    unsupportedReason: null,
    build: ({ window, k, trendWindow }) => make(`boll_${window}_${k}`, trendWindow! + 1, (ctx) => {
      const c = closes(ctx.bars, window!);
      const m = avg(c);
      const s = sd(c);
      const slow = closes(ctx.bars, trendWindow! + 1);
      const trend = Math.abs(slow.at(-1)! / slow[0]! - 1);
      const ranging = trend < 2 * (sd(logRets(slow)) * Math.sqrt(slow.length - 1));
      if (ctx.position === 0) return ranging && c.at(-1)! < m - k! * s ? 1 : 0;
      return c.at(-1)! >= m ? 0 : 1;
    }),
  },
  {
    id: "vol_compression_breakout",
    version: "1.0.0",
    family: "BREAKOUT",
    hypothesis: "After realised volatility falls to a low percentile of its history, an upside range break continues",
    rationale: "Volatility clusters; compression precedes expansion",
    reference: null,
    eligibility: "Instruments with ≥ history bars",
    dataDependencies: ["high", "low", "close"],
    ...COMMON,
    grid: { volWindow: [24, 48], history: [336], pct: [0.2, 0.3], hold: [24, 72] },
    supported: true,
    unsupportedReason: null,
    build: ({ volWindow, history, pct, hold }) => make(`vcb_${volWindow}_${pct}_${hold}`, history! + volWindow! + 1, (ctx) => {
      if (ctx.position === 1) return ctx.barsInPosition >= hold! ? 0 : 1;
      const c = closes(ctx.bars, history! + volWindow! + 1);
      const r = logRets(c);
      const vols: number[] = [];
      for (let i = volWindow!; i <= r.length; i += volWindow!) vols.push(sd(r.slice(i - volWindow!, i)));
      const current = sd(r.slice(-volWindow!));
      const below = vols.filter((v) => v <= current).length / vols.length;
      const prior = ctx.bars.slice(-volWindow! - 1, -1);
      const rangeHigh = Math.max(...prior.map((b) => b.high));
      return below <= pct! && ctx.bars.at(-1)!.close > rangeHigh ? 1 : 0;
    }),
  },
  {
    id: "regime_trend_or_cash",
    version: "1.0.0",
    family: "REGIME_CONDITIONED",
    hypothesis: "Holding only when a slow trend is up and realised volatility is below its median improves risk-adjusted returns versus always holding",
    rationale: "Defensive cash in high-volatility downtrends avoids the worst drawdowns",
    reference: null,
    eligibility: "Instruments with ≥ 2 × slow bars",
    dataDependencies: ["close"],
    ...COMMON,
    grid: { slow: [168, 336], volWindow: [72] },
    supported: true,
    unsupportedReason: null,
    build: ({ slow, volWindow }) => make(`regime_${slow}_${volWindow}`, 2 * slow!, (ctx) => {
      const c = closes(ctx.bars, 2 * slow!);
      const r = logRets(c);
      const trendUp = c.at(-1)! > avg(c.slice(-slow!));
      const recent = sd(r.slice(-volWindow!));
      const windows: number[] = [];
      for (let i = volWindow!; i <= r.length; i += volWindow!) windows.push(sd(r.slice(i - volWindow!, i)));
      const sorted = [...windows].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      return trendUp && recent <= median ? 1 : 0;
    }),
  },
  // Controls (required benchmarks).
  {
    id: "control_cash",
    version: "1.0.0",
    family: "CONTROL",
    hypothesis: "No trade",
    rationale: "A strategy must beat doing nothing after costs",
    reference: null,
    eligibility: "All",
    dataDependencies: [],
    ...COMMON,
    grid: {},
    supported: true,
    unsupportedReason: null,
    build: () => make("control_cash", 1, () => 0),
  },
  {
    id: "control_buy_and_hold",
    version: "1.0.0",
    family: "CONTROL",
    hypothesis: "Hold the instrument for the whole window",
    rationale: "Timing must add value over passive exposure",
    reference: null,
    eligibility: "All",
    dataDependencies: ["close"],
    ...COMMON,
    grid: {},
    supported: true,
    unsupportedReason: null,
    build: () => make("control_buy_and_hold", 1, () => 1),
  },
  {
    id: "control_random",
    version: "1.0.0",
    family: "CONTROL",
    hypothesis: "Random entries and exits with a matched holding probability",
    rationale: "Turnover-matched randomised control: separates signal from exposure and cost drag",
    reference: null,
    eligibility: "All",
    dataDependencies: [],
    ...COMMON,
    grid: { pEnter: [0.02, 0.1], pExit: [0.05, 0.2] },
    supported: true,
    unsupportedReason: null,
    build: ({ pEnter, pExit }) => make(`control_random_${pEnter}_${pExit}`, 1, (ctx) => {
      if (ctx.position === 0) return ctx.random() < pEnter! ? 1 : 0;
      return ctx.random() < pExit! ? 0 : 1;
    }),
  },
  // Catalogued, not implemented: the data or execution they need does not exist in QUANT today.
  {
    id: "cross_sectional_momentum",
    version: "0.0.0",
    family: "CROSS_SECTIONAL_MOMENTUM",
    hypothesis: "Recent relative winners outperform recent relative losers",
    rationale: "Jegadeesh & Titman (1993) (queued; not yet read)",
    reference: "Jegadeesh & Titman (1993), doi:10.1111/j.1540-6261.1993.tb04702.x",
    eligibility: "A cross-section of ≥ 10 comparable instruments on a common calendar",
    dataDependencies: ["close for a cross-section"],
    ...COMMON,
    grid: {},
    supported: false,
    unsupportedReason: "The warehouse holds 2 instruments with > 1 month of history; a ranking needs a broad cross-section",
    build: null,
  },
  {
    id: "flow_imbalance",
    version: "0.0.0",
    family: "MICROSTRUCTURE",
    hypothesis: "Persistent buy/sell imbalance and volume acceleration precede short-horizon moves",
    rationale: "Order-flow information is incorporated gradually",
    reference: null,
    eligibility: "Pools with transaction-level history",
    dataDependencies: ["buy/sell counts", "trade sizes"],
    ...COMMON,
    grid: {},
    supported: false,
    unsupportedReason: "Historical bars carry no buy/sell split; live MarketObservation txn counts exist only since 30 Oct 2026",
    build: null,
  },
  {
    id: "pairs_cointegration",
    version: "0.0.0",
    family: "STATISTICAL_RELATIONSHIP",
    hypothesis: "Spreads of cointegrated pairs revert",
    rationale: "Relative-value arbitrage",
    reference: null,
    eligibility: "Two cointegrated instruments",
    dataDependencies: ["two aligned close series"],
    ...COMMON,
    grid: {},
    supported: false,
    unsupportedReason: "Requires shorting one leg, which QUANT cannot do; no long-only version is a pairs trade",
    build: null,
  },
  {
    id: "token_age_exhaustion",
    version: "0.0.0",
    family: "CRYPTO_SPECIFIC",
    hypothesis: "Freshly launched tokens with extreme early momentum mean-revert (momentum exhaustion)",
    rationale: "ASCEND-00 forensics: the 31 Oct losses bought tokens under 1 h old mid-pump",
    reference: "docs/ascend/ascend-00-safety-autopsy.md",
    eligibility: "Speculative Solana pools with launch-to-death history",
    dataDependencies: ["5m bars from launch", "pool creation time"],
    ...COMMON,
    grid: {},
    supported: false,
    unsupportedReason: "4 speculative pools with 21–515 bars each: far below any usable sample; needs a larger launch cohort",
    build: null,
  },
];

export function expandGrid(grid: ParamGrid): Array<Record<string, ParamValue>> {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];
  return keys.reduce<Array<Record<string, ParamValue>>>(
    (acc, key) => acc.flatMap((p) => grid[key]!.map((v) => ({ ...p, [key]: v }))),
    [{}],
  );
}
