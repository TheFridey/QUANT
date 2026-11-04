import { createHash } from "node:crypto";
import { stdev } from "../stats.js";
import { computeFeatures, FEATURE_DEFINITIONS, horizonsFor, type FeatureDefinition, type FeatureRow } from "./features.js";
import { classifyRegimes, inferBarMs, type MarketCalendar } from "./regime.js";
import { sessionAlignmentIssue, type SessionCalendar } from "./sessions.js";
import type { ResearchBar } from "./simulate.js";

/**
 * GENESIS Phase 4 feature-set versioning and causal checks.
 *
 * A feature set is an explicit, hashed spec: name, version, ordered feature list, null policy and coverage
 * floor. The hash covers the spec and the definition of every feature in it, so a changed definition is a new
 * feature set. Every row carries the time each value became available; the pipeline refuses any value whose
 * availability is after the decision time (the close of the decision bar). Because availability metadata can
 * itself be wrong, `auditPrefixInvariance` also recomputes features on truncated histories: a feature that
 * changes when later bars are removed reads the future, whatever its metadata says.
 */

export const EXTRA_FEATURES_VERSION = "features-extra-1.0.0";

const XV = EXTRA_FEATURES_VERSION;
export const EXTRA_FEATURE_DEFINITIONS: FeatureDefinition[] = [
  { name: "absret_autocorr_m", version: XV, definition: "lag-1 autocorrelation of |1-bar log return| over m bars (volatility clustering)", inputs: ["close"], lookback: "m", missingPolicy: "null before m+1 bars or zero variance" },
  { name: "volume_z_m", version: XV, definition: "(ln volume_i - mean ln volume over the previous m bars) / sd of the same", inputs: ["volume"], lookback: "m", missingPolicy: "null when any volume in the window is missing or ≤ 0, or sd is 0" },
  { name: "efficiency_ratio_m", version: XV, definition: "|close_i - close_{i-m}| / Σ|Δclose| over m bars (trend strength, Kaufman)", inputs: ["close"], lookback: "m", missingPolicy: "null before m bars or zero path length" },
  { name: "breakout_persist_s", version: XV, definition: "share of the last s bars whose close exceeded the max high of the m bars before it", inputs: ["high", "close"], lookback: "m", missingPolicy: "null before m+s bars" },
  { name: "dd_from_high_m", version: XV, definition: "close_i / max(high over the last m bars) - 1", inputs: ["high", "close"], lookback: "m", missingPolicy: "null before m bars" },
];

export const EXTRA_FEATURE_NAMES = EXTRA_FEATURE_DEFINITIONS.map((f) => f.name);

/** A row whose individual values may become available later than the row itself (e.g. a delayed source). */
export type CausalFeatureRow = FeatureRow & { featureAvailableAt?: Record<string, number> };

export type NullPolicy = "DROP_ROW" | "IMPUTE_TRAIN_MEDIAN";

export type FeatureSetSpec = {
  name: string;
  version: string;
  /** Ordered: the column order of every model artefact. */
  features: string[];
  nullPolicy: NullPolicy;
  /** A feature missing on more than this share of post-warm-up labelled rows fails coverage. */
  maxMissingShare: number;
};

const ALL_DEFINITIONS = new Map<string, FeatureDefinition>([...FEATURE_DEFINITIONS, ...EXTRA_FEATURE_DEFINITIONS].map((d) => [d.name, d]));

/** Default spec: every base and extra feature that applies to the interval (hour features are dropped for daily bars). */
export function defaultFeatureSetSpec(barMs: number): FeatureSetSpec {
  const daily = barMs >= 86_400_000;
  return {
    name: daily ? "genesis-ohlcv-daily" : "genesis-ohlcv-intraday",
    version: "2.0.0",
    features: [...FEATURE_DEFINITIONS.map((d) => d.name).filter((n) => !(daily && n.startsWith("hour_"))), ...EXTRA_FEATURE_NAMES],
    nullPolicy: "DROP_ROW",
    maxMissingShare: 0.05,
  };
}

/** sha256 (hex) of the spec plus the definitions of its features (unknown features hash by name only). */
export function featureSetSpecHash(spec: FeatureSetSpec): string {
  const definitions = spec.features.map((name) => ALL_DEFINITIONS.get(name) ?? { name, definition: "caller-supplied (no registered definition)" });
  return createHash("sha256").update(JSON.stringify({ spec, definitions })).digest("hex");
}

/** Extra OHLCV features. Row i reads bars[0..i] only. */
export function computeExtraFeatures(bars: readonly ResearchBar[], options: { barMs?: number } = {}): Array<Record<string, number | null>> {
  const barMs = options.barMs ?? inferBarMs(bars);
  const { s, m } = horizonsFor(barMs);
  const logRet = bars.map((b, i) => (i === 0 || !(bars[i - 1]!.close > 0) || !(b.close > 0) ? 0 : Math.log(b.close / bars[i - 1]!.close)));
  const rollingMaxHigh = (from: number, to: number) => {
    let mx = Number.NEGATIVE_INFINITY;
    for (let k = from; k <= to; k += 1) mx = Math.max(mx, bars[k]!.high);
    return mx;
  };
  return bars.map((bar, i) => {
    const v: Record<string, number | null> = { absret_autocorr_m: null, volume_z_m: null, efficiency_ratio_m: null, breakout_persist_s: null, dd_from_high_m: null };
    if (i >= m + 1) {
      const a = logRet.slice(i + 1 - m, i + 1).map(Math.abs);
      const x = a.slice(0, -1);
      const y = a.slice(1);
      const mx = x.reduce((p, q) => p + q, 0) / x.length;
      const my = y.reduce((p, q) => p + q, 0) / y.length;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let k = 0; k < x.length; k += 1) {
        sxy += (x[k]! - mx) * (y[k]! - my);
        sxx += (x[k]! - mx) ** 2;
        syy += (y[k]! - my) ** 2;
      }
      v.absret_autocorr_m = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    }
    if (i >= m) {
      const prev = bars.slice(i - m, i).map((b) => b.volume);
      if (bar.volume !== null && bar.volume > 0 && prev.every((x) => x !== null && x > 0)) {
        const lv = prev.map((x) => Math.log(x as number));
        const mu = lv.reduce((p, q) => p + q, 0) / lv.length;
        const sd = stdev(lv);
        v.volume_z_m = sd && sd > 0 ? (Math.log(bar.volume) - mu) / sd : null;
      }
      let path = 0;
      for (let k = i - m + 1; k <= i; k += 1) path += Math.abs(bars[k]!.close - bars[k - 1]!.close);
      v.efficiency_ratio_m = path > 0 ? Math.abs(bar.close - bars[i - m]!.close) / path : null;
      v.dd_from_high_m = bar.close / rollingMaxHigh(i - m + 1, i) - 1;
    }
    if (i >= m + s) {
      let hits = 0;
      for (let k = i - s + 1; k <= i; k += 1) if (bars[k]!.close > rollingMaxHigh(k - m, k - 1)) hits += 1;
      v.breakout_persist_s = hits / s;
    }
    return v;
  });
}

/** Base point-in-time features (ASCEND-05) merged with the extra OHLCV features; every value available at the bar close. */
export function buildDefaultFeatureRows(bars: readonly ResearchBar[], options: { barMs?: number; calendar?: MarketCalendar } = {}): CausalFeatureRow[] {
  const barMs = options.barMs ?? inferBarMs(bars);
  const base = computeFeatures(bars, classifyRegimes(bars, { barMs, calendar: options.calendar }), { barMs });
  const extra = computeExtraFeatures(bars, { barMs });
  return base.map((row, i) => ({ ...row, values: { ...row.values, ...extra[i]! } }));
}

export type BarIssue = { index: number; code: "NON_FINITE_TIME" | "DUPLICATE_TIMESTAMP" | "UNORDERED" | "MISALIGNED" | "BAD_PRICE" | "INCONSISTENT_OHLC" | "BAD_VOLUME" | "NOT_YET_CLOSED" | "OFF_SESSION" | "BAD_AVAILABILITY"; detail: string };

/**
 * Integrity checks on raw bars. The ML pipeline refuses data with any issue rather than repairing it. Alignment
 * and session membership follow `calendar` (default CRYPTO_24_7: one fixed UTC grid from the first bar; US_EQUITY:
 * NYSE sessions in New York time). When `availableAt` is given (aligned with bars) each must be finite and no
 * earlier than the bar's close (open + interval).
 */
export function validateResearchBars(bars: readonly ResearchBar[], options: { barMs?: number; asOf?: number; calendar?: SessionCalendar; availableAt?: ReadonlyArray<number | null> } = {}): BarIssue[] {
  const issues: BarIssue[] = [];
  if (!bars.length) return issues;
  const barMs = options.barMs ?? inferBarMs(bars);
  const t0 = bars[0]!.t;
  const calendar = options.calendar ?? "CRYPTO_24_7";
  bars.forEach((b, i) => {
    if (!Number.isFinite(b.t)) {
      issues.push({ index: i, code: "NON_FINITE_TIME", detail: `t=${String(b.t)}` });
      return;
    }
    if (i > 0) {
      const prev = bars[i - 1]!.t;
      if (b.t === prev) issues.push({ index: i, code: "DUPLICATE_TIMESTAMP", detail: new Date(b.t).toISOString() });
      else if (b.t < prev) issues.push({ index: i, code: "UNORDERED", detail: `${new Date(b.t).toISOString()} after ${new Date(prev).toISOString()}` });
    }
    const align = sessionAlignmentIssue(b.t, barMs, calendar, t0);
    if (align) issues.push({ index: i, ...align });
    const av = options.availableAt?.[i];
    if (av !== undefined && av !== null && !(Number.isFinite(av) && av >= b.t + barMs)) issues.push({ index: i, code: "BAD_AVAILABILITY", detail: `available_at ${Number.isFinite(av) ? new Date(av).toISOString() : String(av)} is before the bar closes` });
    const prices = [b.open, b.high, b.low, b.close];
    if (prices.some((p) => !Number.isFinite(p) || !(p > 0))) issues.push({ index: i, code: "BAD_PRICE", detail: prices.join(",") });
    else if (b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close)) issues.push({ index: i, code: "INCONSISTENT_OHLC", detail: prices.join(",") });
    if (b.volume !== null && !(Number.isFinite(b.volume) && b.volume >= 0)) issues.push({ index: i, code: "BAD_VOLUME", detail: String(b.volume) });
    if (options.asOf !== undefined && b.t + barMs > options.asOf) issues.push({ index: i, code: "NOT_YET_CLOSED", detail: `closes ${new Date(b.t + barMs).toISOString()} after asOf` });
  });
  return issues;
}

export type CausalViolation = { index: number; feature: string; availableAt: number; decisionTime: number };

/** Every (row, feature) whose availability is after the decision time (close of the decision bar). */
export function causalViolations(rows: readonly CausalFeatureRow[], features: readonly string[], decisionTime: (row: CausalFeatureRow) => number): CausalViolation[] {
  const out: CausalViolation[] = [];
  for (const row of rows) {
    const d = decisionTime(row);
    for (const f of features) {
      const at = row.featureAvailableAt?.[f] ?? row.availableAt;
      if (!(at <= d)) out.push({ index: row.index, feature: f, availableAt: at, decisionTime: d });
    }
  }
  return out;
}

export type PrefixAuditResult = { probes: number[]; violations: Array<{ index: number; feature: string; full: number | null; prefix: number | null }> };

/**
 * Recomputes features on bars[0..p] for each probe p and compares row p with the full-history computation.
 * Any difference means the feature read bars after p (look-ahead), regardless of its availability metadata.
 */
export function auditPrefixInvariance(bars: readonly ResearchBar[], builder: (bars: readonly ResearchBar[]) => readonly CausalFeatureRow[], features: readonly string[], probes: number[], fullRows?: readonly CausalFeatureRow[]): PrefixAuditResult {
  const full = fullRows ?? builder(bars);
  const violations: PrefixAuditResult["violations"] = [];
  const same = (a: number | null | undefined, b: number | null | undefined) => {
    const x = a ?? null;
    const y = b ?? null;
    if (x === null || y === null) return x === y;
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y);
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  };
  for (const p of probes) {
    if (p < 0 || p >= bars.length) continue;
    const prefixRows = builder(bars.slice(0, p + 1));
    const a = full.find((r) => r.index === p);
    const b = prefixRows.find((r) => r.index === p);
    for (const f of features) {
      const fa = a?.values[f];
      const fb = b?.values[f];
      if (!same(fa, fb)) violations.push({ index: p, feature: f, full: fa ?? null, prefix: fb ?? null });
    }
  }
  return { probes, violations };
}
