import { averageTrueRange, costBpsPerSideAt, isTradeableAt, type MarketResearchConfig, type SessionWindowId } from "./market-config.js";
import type { RegimeState } from "./regime.js";
import { isUsEquitySessionDate, nyLocalParts } from "./sessions.js";
import type { ResearchBar, ResearchStrategy, StrategyContext } from "./simulate.js";
import type { ParamGrid, ParamValue, StrategySpec } from "./strategies.js";

/**
 * OPERATION HORIZON research strategy families. Long/flat only (QUANT cannot short), run by the existing ASCEND
 * simulator and walk-forward validator unchanged. Research only: no spec here is registered with the paper
 * engine, and a verdict never applies or promotes anything.
 *
 * Shared entry rules, applied to every family:
 *  - Thresholds are multiples of ATR (`volatility.atrBars`), never a fixed percentage.
 *  - The fill happens at the open of the next bar, at decision close + one interval. No entry is decided when
 *    that instant is not tradeable (FX/metals weekend, maintenance hour or holiday; ETF outside regular hours).
 *  - Cost gate: abstain unless the forecast move exceeds k × the estimated round-trip cost at that fill time
 *    (session/rollover widening included). The forecast is `forecastAtrMultiple` × ATR, or the distance to the
 *    mean for mean reversion. Exits are never gated: a position can always be closed.
 *
 * Parameter grids are pre-declared and performance-blind (written before any HORIZON result); every grid point
 * in every fold is a recorded trial in the validator.
 */

export const HORIZON_STRATEGIES_VERSION = "horizon-strategies-1.0.0";

export type HorizonStrategyContext = {
  market: MarketResearchConfig;
  instrument: string;
  barMs: number;
  /** Causal regime state by bar open time (from `classifyRegimes` over the same bars). Missing = abstain. */
  regimeAt?: (t: number) => RegimeState | undefined;
};

const LONDON = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function londonMinute(t: number): number {
  const parts = Object.fromEntries(LONDON.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

/**
 * Whether a fill at instant `t` falls in a session window. LONDON_OPEN: 08:00-11:00 London time. NY_OPEN:
 * 08:00-11:00 New York time (US data at 08:30, COMEX gold opens 08:20). RTH_OPEN: 09:30-11:30 New York on a NYSE
 * session. RTH: 09:30-16:00 New York on a NYSE session. Local clocks follow each city's daylight saving time.
 */
export function inSessionWindow(window: SessionWindowId, t: number): boolean {
  if (window === "LONDON_OPEN") {
    const m = londonMinute(t);
    return m >= 480 && m < 660;
  }
  const p = nyLocalParts(t);
  const m = p.hour * 60 + p.minute;
  if (window === "NY_OPEN") return m >= 480 && m < 660;
  if (!isUsEquitySessionDate(p.ymd)) return false;
  return window === "RTH_OPEN" ? m >= 570 && m < 690 : m >= 570 && m < 960;
}

/** Cost gate: true when `forecastFraction` exceeds k × round-trip cost (both sides at the fill instant). */
export function costGatePasses(hctx: HorizonStrategyContext, fillT: number, price: number, forecastFraction: number): boolean {
  const roundTrip = (2 * costBpsPerSideAt(hctx.market, hctx.instrument, fillT, price, hctx.barMs)) / 10_000;
  return forecastFraction > hctx.market.costGate.k * roundTrip;
}

/** The common entry gate: tradeable fill instant, then the cost gate. */
function entryAllowed(hctx: HorizonStrategyContext, last: ResearchBar, forecastFraction: number): boolean {
  const fillT = last.t + hctx.barMs;
  return isTradeableAt(hctx.market, fillT, hctx.barMs) && costGatePasses(hctx, fillT, last.close, forecastFraction);
}

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function make(id: string, lookback: number, decide: (ctx: StrategyContext) => 0 | 1): ResearchStrategy {
  return { id, lookback, decide };
}

const COMMON = {
  executionAssumptions: "Fill at next bar open; flat per-side cost = the market config's validation quantile; entries only at tradeable instants and through the cost gate; long/flat only",
  riskRequirements: "Research verdict only; never registered with the paper engine, never auto-promoted; subordinate to the existing risk engine",
  reference: null,
  supported: true,
  unsupportedReason: null,
};

type Built = (params: Record<string, ParamValue>) => ResearchStrategy;

function spec(input: { id: string; family: StrategySpec["family"]; hypothesis: string; rationale: string; eligibility: string; dataDependencies: string[]; grid: ParamGrid; horizonParams: string[]; build: Built }): StrategySpec {
  return { version: "1.0.0", ...COMMON, ...input };
}

/** ATR breakout entry test shared by the breakout and regime families. */
function atrBreakout(bars: readonly ResearchBar[], channel: number, entryAtr: number, atrBars: number): { fired: boolean; atr: number | null } {
  const last = bars.at(-1)!;
  const prior = bars.slice(-(channel + 1), -1);
  const atr = averageTrueRange(bars.slice(0, -1), atrBars);
  if (atr === null || prior.length < channel) return { fired: false, atr };
  const high = Math.max(...prior.map((b) => b.high));
  return { fired: last.close > high + entryAtr * atr, atr };
}

/** Builds the HORIZON strategy specs for one market, instrument and bar interval. */
export function horizonStrategySpecs(hctx: HorizonStrategyContext): StrategySpec[] {
  const { market, barMs } = hctx;
  const atrBars = market.volatility.atrBars;
  const forecastAtr = market.costGate.forecastAtrMultiple;
  const intraday = barMs < 86_400_000;
  const out: StrategySpec[] = [];

  out.push(
    spec({
      id: "hz_atr_breakout",
      family: "BREAKOUT",
      hypothesis: "A close more than entryAtr × ATR above the prior channel high starts a move larger than the round-trip cost",
      rationale: "Range breaks mark new information; scaling the threshold by ATR makes it comparable across markets",
      eligibility: "Any instrument with ≥ channel + ATR bars",
      dataDependencies: ["high", "low", "close"],
      horizonParams: ["channel", "hold"],
      grid: { channel: [20, 55], entryAtr: [0, 0.5], hold: [12, 48] },
      build: ({ channel, entryAtr, hold }) =>
        make(`hz_atr_breakout_${channel}_${entryAtr}_${hold}`, Math.max(channel!, atrBars) + 2, (ctx) => {
          const last = ctx.bars.at(-1)!;
          if (ctx.position === 1) {
            const exitLow = Math.min(...ctx.bars.slice(-(Math.ceil(channel! / 2) + 1), -1).map((b) => b.low));
            return ctx.barsInPosition >= hold! || last.close < exitLow ? 0 : 1;
          }
          const { fired, atr } = atrBreakout(ctx.bars, channel!, entryAtr!, atrBars);
          return fired && entryAllowed(hctx, last, (forecastAtr * atr!) / last.close) ? 1 : 0;
        }),
    }),
  );

  out.push(
    spec({
      id: "hz_vol_expansion",
      family: "BREAKOUT",
      hypothesis: "A bar whose true range is at least `expansion` × the prior ATR, closing up and near its high, is followed by continuation",
      rationale: "Volatility expansion out of quiet conditions marks a regime change; the close location filters exhaustion bars",
      eligibility: "Any instrument with ≥ ATR + 2 bars",
      dataDependencies: ["open", "high", "low", "close"],
      horizonParams: ["hold"],
      grid: { expansion: [1.5, 2.5], hold: [6, 24] },
      build: ({ expansion, hold }) =>
        make(`hz_vol_expansion_${expansion}_${hold}`, atrBars + 2, (ctx) => {
          if (ctx.position === 1) return ctx.barsInPosition >= hold! ? 0 : 1;
          const last = ctx.bars.at(-1)!;
          const prev = ctx.bars.at(-2)!;
          const atr = averageTrueRange(ctx.bars.slice(0, -1), atrBars);
          if (atr === null || !(atr > 0)) return 0;
          const tr = Math.max(last.high - last.low, Math.abs(last.high - prev.close), Math.abs(last.low - prev.close));
          const range = last.high - last.low;
          const closeLocation = range > 0 ? (last.close - last.low) / range : 0;
          const fired = tr >= expansion! * atr && last.close > last.open && closeLocation >= 0.75;
          return fired && entryAllowed(hctx, last, (forecastAtr * atr) / last.close) ? 1 : 0;
        }),
    }),
  );

  out.push(
    spec({
      id: "hz_mtf_trend",
      family: "TREND",
      hypothesis: "When the higher-timeframe trend is up (close above a rising slow average of every htf-th close), a lower-timeframe break of the last htf bars' high continues",
      rationale: "Multi-timeframe alignment: trade the fast timeframe only in the direction of the slow one",
      eligibility: "Any instrument with ≥ htf × (slow + 1) bars",
      dataDependencies: ["high", "close"],
      horizonParams: ["htf", "slow"],
      grid: { htf: [4, 6], slow: [20, 40] },
      build: ({ htf, slow }) =>
        make(`hz_mtf_trend_${htf}_${slow}`, htf! * (slow! + 1) + 1, (ctx) => {
          const bars = ctx.bars;
          const last = bars.at(-1)!;
          // Higher-timeframe closes: every htf-th close counting back from the decision bar.
          const htfCloses: number[] = [];
          for (let i = bars.length - 1; i >= 0 && htfCloses.length < slow! + 1; i -= htf!) htfCloses.unshift(bars[i]!.close);
          if (htfCloses.length < slow! + 1) return 0;
          const smaNow = avg(htfCloses.slice(1));
          const smaPrev = avg(htfCloses.slice(0, -1));
          const htfUp = last.close > smaNow && smaNow > smaPrev;
          if (ctx.position === 1) return htfUp ? 1 : 0;
          const priorHigh = Math.max(...bars.slice(-(htf! + 1), -1).map((b) => b.high));
          const atr = averageTrueRange(bars.slice(0, -1), atrBars);
          if (atr === null) return 0;
          return htfUp && last.close > priorHigh && entryAllowed(hctx, last, (forecastAtr * atr) / last.close) ? 1 : 0;
        }),
    }),
  );

  out.push(
    spec({
      id: "hz_vol_mean_reversion",
      family: "MEAN_REVERSION",
      hypothesis: "A close more than entryAtr × ATR below its window mean reverts towards the mean by more than the round-trip cost",
      rationale: "Short-horizon over-reaction; measuring the stretch in ATR keeps the rule scale-free",
      eligibility: "Any instrument with ≥ window + ATR bars",
      dataDependencies: ["high", "low", "close"],
      horizonParams: ["window", "maxBars"],
      grid: { window: [20, 50], entryAtr: [1.5, 2.5], maxBars: [12, 36] },
      build: ({ window, entryAtr, maxBars }) =>
        make(`hz_vol_mean_reversion_${window}_${entryAtr}_${maxBars}`, Math.max(window!, atrBars + 1) + 1, (ctx) => {
          const last = ctx.bars.at(-1)!;
          const mean = avg(ctx.bars.slice(-window!).map((b) => b.close));
          if (ctx.position === 1) return last.close >= mean || ctx.barsInPosition >= maxBars! ? 0 : 1;
          const atr = averageTrueRange(ctx.bars, atrBars);
          if (atr === null || !(atr > 0)) return 0;
          const stretch = (last.close - mean) / atr;
          return stretch <= -entryAtr! && entryAllowed(hctx, last, (mean - last.close) / last.close) ? 1 : 0;
        }),
    }),
  );

  out.push(
    spec({
      id: "hz_regime_breakout",
      family: "REGIME_CONDITIONED",
      hypothesis: "ATR breakouts taken only in an up-trending, non-extreme, stable regime beat unconditioned breakouts; otherwise abstain",
      rationale: "Regime-aware abstention: the deterministic regime engine (regime-det) vetoes entries in unknown, down-trending, extreme-volatility or unstable states",
      eligibility: "Any instrument with enough history for the regime engine",
      dataDependencies: ["high", "low", "close", "regime state (causal)"],
      horizonParams: ["channel", "hold"],
      grid: { channel: [20, 55], hold: [12, 48] },
      build: ({ channel, hold }) =>
        make(`hz_regime_breakout_${channel}_${hold}`, Math.max(channel!, atrBars) + 2, (ctx) => {
          const last = ctx.bars.at(-1)!;
          if (ctx.position === 1) {
            const exitLow = Math.min(...ctx.bars.slice(-(Math.ceil(channel! / 2) + 1), -1).map((b) => b.low));
            return ctx.barsInPosition >= hold! || last.close < exitLow ? 0 : 1;
          }
          const r = hctx.regimeAt?.(last.t);
          if (!r || r.insufficient) return 0;
          const trendOk = r.trend.state === "STRONG_UP" || r.trend.state === "WEAK_UP";
          if (!trendOk || r.volatility.level === "EXTREME" || r.volatility.level === "UNKNOWN" || r.behaviour.state === "UNSTABLE") return 0;
          const { fired, atr } = atrBreakout(ctx.bars, channel!, 0, atrBars);
          return fired && entryAllowed(hctx, last, (forecastAtr * atr!) / last.close) ? 1 : 0;
        }),
    }),
  );

  if (intraday && market.sessionWindows.length > 0) {
    const windows = market.sessionWindows;
    out.push(
      spec({
        id: "hz_session_breakout",
        family: "BREAKOUT",
        hypothesis: `A break of the prior range-bar high during ${windows.join(" or ")} continues for the next hold bars`,
        rationale: "Liquidity arrives at session opens (London/New York for FX and gold, the regular session for ETFs); breaks of the pre-session range then carry information",
        eligibility: "Intraday bars of a market with session windows",
        dataDependencies: ["high", "low", "close", "bar time"],
        horizonParams: ["range", "hold"],
        // `window` indexes market.sessionWindows (ParamValue is numeric).
        grid: { window: windows.map((_, i) => i), range: [6], entryAtr: [0, 0.5], hold: [4, 8] },
        build: ({ window, range, entryAtr, hold }) => {
          const w = windows[window!]!;
          return make(`hz_session_breakout_${w}_${range}_${entryAtr}_${hold}`, Math.max(range!, atrBars) + 2, (ctx) => {
            if (ctx.position === 1) return ctx.barsInPosition >= hold! ? 0 : 1;
            const last = ctx.bars.at(-1)!;
            if (!inSessionWindow(w, last.t + barMs)) return 0;
            const { fired, atr } = atrBreakout(ctx.bars, range!, entryAtr!, atrBars);
            return fired && entryAllowed(hctx, last, (forecastAtr * atr!) / last.close) ? 1 : 0;
          });
        },
      }),
    );
  }
  return out;
}

/** Every grid of a spec list, as declared (before any fitting to a dataset's length). */
export function declaredGrids(specs: readonly StrategySpec[]): Array<{ id: string; family: string; grid: ParamGrid; points: number }> {
  return specs.map((s) => ({ id: s.id, family: s.family, grid: s.grid, points: Object.values(s.grid).reduce((n, v) => n * v.length, 1) }));
}
