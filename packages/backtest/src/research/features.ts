import { createHash } from "node:crypto";
import { stdev } from "../stats.js";
import { inferBarMs, type RegimeState } from "./regime.js";
import type { ResearchBar } from "./simulate.js";

/**
 * ASCEND-05 point-in-time feature store (versioned, deterministic, computed on demand from warehouse bars).
 *
 * A feature row for decision bar i reads bars[0..i] and the filtered regime state at i, nothing later. It is
 * available at the close of bar i (`availableAt`). Labels (below) start at the next bar's open, so a model
 * trained on (features_i, label_i) never sees a price it could not have had when deciding.
 *
 * Horizons are in bars, scaled by interval (short/medium/long ≈ 6h/1d/3d intraday; 5/20/60 days daily).
 */

export const FEATURE_SET_VERSION = "features-1.0.0";

export type FeatureDefinition = {
  name: string;
  version: string;
  definition: string;
  inputs: string[];
  /** Bars of history needed, in units of the horizon names s/m/l. */
  lookback: "s" | "m" | "l" | "regime" | "0";
  missingPolicy: string;
};

const V = FEATURE_SET_VERSION;
export const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  { name: "ret_s", version: V, definition: "ln(close_i / close_{i-s})", inputs: ["close"], lookback: "s", missingPolicy: "null before s bars" },
  { name: "ret_m", version: V, definition: "ln(close_i / close_{i-m})", inputs: ["close"], lookback: "m", missingPolicy: "null before m bars" },
  { name: "ret_l", version: V, definition: "ln(close_i / close_{i-l})", inputs: ["close"], lookback: "l", missingPolicy: "null before l bars" },
  { name: "vol_m", version: V, definition: "sample sd of 1-bar log returns over m bars", inputs: ["close"], lookback: "m", missingPolicy: "null before m bars" },
  { name: "downside_vol_m", version: V, definition: "sqrt(mean(min(r,0)^2)) of 1-bar log returns over m bars", inputs: ["close"], lookback: "m", missingPolicy: "null before m bars" },
  { name: "atr_rel_m", version: V, definition: "mean true range over m bars / close_i", inputs: ["high", "low", "close"], lookback: "m", missingPolicy: "null before m bars" },
  { name: "ma_gap_m", version: V, definition: "close_i / SMA_m(close) - 1", inputs: ["close"], lookback: "m", missingPolicy: "null before m bars" },
  { name: "up_frac_m", version: V, definition: "share of the last m bars with close > previous close", inputs: ["close"], lookback: "m", missingPolicy: "null before m bars" },
  { name: "range_pos_m", version: V, definition: "(close_i - min low_m) / (max high_m - min low_m)", inputs: ["high", "low", "close"], lookback: "m", missingPolicy: "null before m bars or zero range" },
  { name: "drawdown_l", version: V, definition: "close_i / max(close over l bars) - 1", inputs: ["close"], lookback: "l", missingPolicy: "null before l bars" },
  { name: "rel_volume_m", version: V, definition: "volume_i / median volume over m bars", inputs: ["volume"], lookback: "m", missingPolicy: "null when volume is missing or the median is 0" },
  { name: "regime_trend_t", version: V, definition: "filtered drift t-statistic of returns (regime-det-1.0.0)", inputs: ["regime"], lookback: "regime", missingPolicy: "null while the regime is insufficient" },
  { name: "regime_vol_pct", version: V, definition: "filtered realised-volatility percentile (regime-det-1.0.0)", inputs: ["regime"], lookback: "regime", missingPolicy: "null while the regime is insufficient" },
  { name: "regime_vr", version: V, definition: "filtered variance ratio (regime-det-1.0.0)", inputs: ["regime"], lookback: "regime", missingPolicy: "null while the regime is insufficient" },
  { name: "hour_sin", version: V, definition: "sin(2π·UTC hour of bar close / 24); null for daily bars", inputs: ["t"], lookback: "0", missingPolicy: "null for daily bars" },
  { name: "hour_cos", version: V, definition: "cos(2π·UTC hour of bar close / 24); null for daily bars", inputs: ["t"], lookback: "0", missingPolicy: "null for daily bars" },
];

export const FEATURE_NAMES = FEATURE_DEFINITIONS.map((f) => f.name);

export function featureSetHash(): string {
  return createHash("sha256").update(JSON.stringify(FEATURE_DEFINITIONS)).digest("hex").slice(0, 24);
}

export type Horizons = { s: number; m: number; l: number };

export function horizonsFor(barMs: number): Horizons {
  if (barMs >= 86_400_000) return { s: 5, m: 20, l: 60 };
  return { s: Math.max(2, Math.round(21_600_000 / barMs)), m: Math.max(4, Math.round(86_400_000 / barMs)), l: Math.max(8, Math.round(259_200_000 / barMs)) };
}

export type FeatureRow = { index: number; t: number; availableAt: number; values: Record<string, number | null> };

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Features for every bar. Row i uses bars[0..i] and states[i] only. */
export function computeFeatures(bars: readonly ResearchBar[], states: readonly RegimeState[], options: { barMs?: number } = {}): FeatureRow[] {
  if (states.length !== bars.length) throw new Error("regime states must align with bars");
  const barMs = options.barMs ?? inferBarMs(bars);
  const h = horizonsFor(barMs);
  const daily = barMs >= 86_400_000;
  const logRet = bars.map((b, i) => (i === 0 || !(bars[i - 1]!.close > 0) || !(b.close > 0) ? 0 : Math.log(b.close / bars[i - 1]!.close)));
  return bars.map((bar, i) => {
    const has = (n: number) => i >= n;
    const window = (n: number) => bars.slice(i + 1 - n, i + 1);
    const rets = (n: number) => logRet.slice(i + 1 - n, i + 1);
    const values: Record<string, number | null> = {};
    values.ret_s = has(h.s) ? Math.log(bar.close / bars[i - h.s]!.close) : null;
    values.ret_m = has(h.m) ? Math.log(bar.close / bars[i - h.m]!.close) : null;
    values.ret_l = has(h.l) ? Math.log(bar.close / bars[i - h.l]!.close) : null;
    values.vol_m = has(h.m) ? stdev(rets(h.m)) : null;
    values.downside_vol_m = has(h.m) ? Math.sqrt(rets(h.m).reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / h.m) : null;
    if (has(h.m)) {
      const w = window(h.m);
      const tr = w.map((b, k) => {
        const prevClose = bars[i + 1 - h.m + k - 1]?.close ?? b.open;
        return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
      });
      values.atr_rel_m = tr.reduce((s, x) => s + x, 0) / h.m / bar.close;
      values.ma_gap_m = bar.close / (w.reduce((s, b) => s + b.close, 0) / h.m) - 1;
      values.up_frac_m = rets(h.m).filter((r) => r > 0).length / h.m;
      const hi = Math.max(...w.map((b) => b.high));
      const lo = Math.min(...w.map((b) => b.low));
      values.range_pos_m = hi > lo ? (bar.close - lo) / (hi - lo) : null;
      const vols = w.map((b) => b.volume).filter((v): v is number => v !== null);
      const med = vols.length === h.m ? median(vols) : null;
      values.rel_volume_m = med && bar.volume !== null ? bar.volume / med : null;
    } else {
      values.atr_rel_m = values.ma_gap_m = values.up_frac_m = values.range_pos_m = values.rel_volume_m = null;
    }
    values.drawdown_l = has(h.l) ? bar.close / Math.max(...window(h.l + 1).map((b) => b.close)) - 1 : null;
    const st = states[i]!;
    values.regime_trend_t = st.insufficient ? null : st.trend.tStat;
    values.regime_vol_pct = st.insufficient ? null : st.volatility.percentile;
    values.regime_vr = st.insufficient ? null : st.behaviour.varianceRatio;
    const hour = new Date(bar.t + barMs).getUTCHours();
    values.hour_sin = daily ? null : Math.sin((2 * Math.PI * hour) / 24);
    values.hour_cos = daily ? null : Math.cos((2 * Math.PI * hour) / 24);
    return { index: i, t: bar.t, availableAt: bar.t + barMs, values };
  });
}

/**
 * Executable net label: enter at open_{i+1}, exit at open_{i+1+horizon}, paying `costBpsPerSide` each side.
 * `endIndex` is the last bar the label reads; training samples whose `endIndex` reaches into a test window must
 * be purged.
 */
export type Label = { index: number; endIndex: number; netReturn: number; positive: 0 | 1 };

export function netForwardLabels(bars: readonly ResearchBar[], horizon: number, costBpsPerSide: number): Array<Label | null> {
  const c = costBpsPerSide / 10_000;
  return bars.map((_, i) => {
    const end = i + 1 + horizon;
    if (end >= bars.length) return null;
    const entry = bars[i + 1]!.open;
    const exit = bars[end]!.open;
    const net = (exit * (1 - c)) / (entry * (1 + c)) - 1;
    return { index: i, endIndex: end, netReturn: net, positive: net > 0 ? 1 : 0 };
  });
}

/**
 * Barrier label: from open_{i+1}, does price reach +up·σ before −down·σ within `horizon` bars? σ is the
 * decision-time vol (`vol_m`), scaled by √horizon. When both barriers fall inside one bar, the stop is assumed
 * first (conservative). Timeouts are labelled 0.
 */
export function barrierLabels(bars: readonly ResearchBar[], features: readonly FeatureRow[], horizon: number, up = 1, down = 1): Array<(Label & { outcome: "TARGET" | "STOP" | "TIMEOUT" }) | null> {
  return bars.map((_, i) => {
    const sigma = features[i]?.values.vol_m;
    const end = i + horizon;
    if (sigma === null || sigma === undefined || !(sigma > 0) || end >= bars.length) return null;
    const entry = bars[i + 1]!.open;
    const target = entry * Math.exp(up * sigma * Math.sqrt(horizon));
    const stop = entry * Math.exp(-down * sigma * Math.sqrt(horizon));
    for (let k = i + 1; k <= end; k += 1) {
      const b = bars[k]!;
      if (b.low <= stop) return { index: i, endIndex: k, netReturn: stop / entry - 1, positive: 0, outcome: "STOP" as const };
      if (b.high >= target) return { index: i, endIndex: k, netReturn: target / entry - 1, positive: 1, outcome: "TARGET" as const };
    }
    return { index: i, endIndex: end, netReturn: bars[end]!.close / entry - 1, positive: 0, outcome: "TIMEOUT" as const };
  });
}
