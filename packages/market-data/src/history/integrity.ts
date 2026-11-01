import { createHash } from "node:crypto";

/**
 * ASCEND-01 historical bars: normalisation and point-in-time integrity. A bar is known only once it has
 * closed, so `availableAt` = open + interval, and a bar still in progress at collection time is dropped
 * rather than stored as if final. Gaps are reported, never filled; nothing here fabricates an observation.
 */

export type HistoricalBar = {
  /** Bar open, epoch ms (UTC). */
  openTime: number;
  /** Earliest time a decision could have used this bar: its close, epoch ms. */
  availableAt: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Null when the provider does not report volume. Never zero-filled. */
  volume: string | null;
  /** Provider-specific extras kept verbatim (e.g. trade count, VWAP). */
  extra?: Record<string, string | number | null>;
};

export type RawBar = {
  openTime: number;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string | null;
  extra?: Record<string, string | number | null>;
};

export type BarRejection = { openTime: number; reason: "NON_FINITE" | "NON_POSITIVE" | "OHLC_INCONSISTENT" | "IN_PROGRESS" | "MISALIGNED" | "DUPLICATE_CONFLICT" };

export type BarGap = { fromOpenTime: number; toOpenTime: number; missingBars: number };

export type NormaliseResult = {
  bars: HistoricalBar[];
  rejected: BarRejection[];
  duplicatesDropped: number;
  gaps: BarGap[];
};

/**
 * How a source stamps bar opens. UTC_GRID: multiples of the interval in UTC (DEX candles, intraday bars).
 * NEW_YORK_DAY: daily equity bars open at 00:00 America/New_York, which is 04:00Z or 05:00Z by DST.
 */
export type BarAlignment = "UTC_GRID" | "NEW_YORK_DAY";

const NEW_YORK_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function isAligned(openTime: number, intervalMs: number, alignment: BarAlignment): boolean {
  if (!Number.isInteger(openTime)) return false;
  if (alignment === "UTC_GRID") return openTime % intervalMs === 0;
  return intervalMs === 86_400_000 && NEW_YORK_TIME.format(new Date(openTime)) === "00:00:00";
}

function num(v: number | string | null): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(n: number): string {
  // Fixed decimal text; avoids exponent notation for micro-priced tokens.
  return n.toFixed(12).replace(/\.?0+$/, "") || "0";
}

export function normaliseBars(raw: RawBar[], options: { intervalMs: number; collectedAt: number; alignment?: BarAlignment }): NormaliseResult {
  const { intervalMs, collectedAt } = options;
  const alignment = options.alignment ?? "UTC_GRID";
  const rejected: BarRejection[] = [];
  const byOpen = new Map<number, HistoricalBar>();
  let duplicatesDropped = 0;
  for (const r of raw) {
    if (!isAligned(r.openTime, intervalMs, alignment)) {
      // Bars must align to the source's declared grid; a misaligned bar signals a timezone or unit error.
      rejected.push({ openTime: r.openTime, reason: "MISALIGNED" });
      continue;
    }
    const o = num(r.open);
    const h = num(r.high);
    const l = num(r.low);
    const c = num(r.close);
    const v = r.volume === null ? null : num(r.volume);
    if (o === null || h === null || l === null || c === null || (r.volume !== null && v === null)) {
      rejected.push({ openTime: r.openTime, reason: "NON_FINITE" });
      continue;
    }
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || (v !== null && v < 0)) {
      rejected.push({ openTime: r.openTime, reason: "NON_POSITIVE" });
      continue;
    }
    if (h < Math.max(o, c) || l > Math.min(o, c) || l > h) {
      rejected.push({ openTime: r.openTime, reason: "OHLC_INCONSISTENT" });
      continue;
    }
    const availableAt = r.openTime + intervalMs;
    if (availableAt > collectedAt) {
      rejected.push({ openTime: r.openTime, reason: "IN_PROGRESS" });
      continue;
    }
    const bar: HistoricalBar = { openTime: r.openTime, availableAt, open: str(o), high: str(h), low: str(l), close: str(c), volume: v === null ? null : str(v), ...(r.extra ? { extra: r.extra } : {}) };
    const existing = byOpen.get(r.openTime);
    if (existing) {
      if (barHash(existing) !== barHash(bar)) {
        // Two different values for one bar: keep neither silently; the caller must resolve the revision.
        byOpen.delete(r.openTime);
        rejected.push({ openTime: r.openTime, reason: "DUPLICATE_CONFLICT" });
      } else {
        duplicatesDropped += 1;
      }
      continue;
    }
    byOpen.set(r.openTime, bar);
  }
  const bars = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  return { bars, rejected, duplicatesDropped, gaps: findGaps(bars, intervalMs) };
}

export function findGaps(bars: HistoricalBar[], intervalMs: number): BarGap[] {
  const gaps: BarGap[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const step = bars[i]!.openTime - bars[i - 1]!.openTime;
    // Rounded, so a 23 h or 25 h DST step between New York days is not a gap.
    const missingBars = Math.round(step / intervalMs) - 1;
    if (missingBars >= 1) {
      gaps.push({ fromOpenTime: bars[i - 1]!.openTime + intervalMs, toOpenTime: bars[i]!.openTime - intervalMs, missingBars });
    }
  }
  return gaps;
}

/** Content hash of a bar's economic values: detects provider revisions on re-import. */
export function barHash(bar: Pick<HistoricalBar, "openTime" | "open" | "high" | "low" | "close" | "volume">): string {
  return createHash("sha256").update(`${bar.openTime}|${bar.open}|${bar.high}|${bar.low}|${bar.close}|${bar.volume ?? ""}`).digest("hex").slice(0, 32);
}

/** Order-independent dataset version: hash of the sorted bar hashes. Same bars ⇒ same version. */
export function datasetVersionHash(bars: HistoricalBar[]): string {
  const h = createHash("sha256");
  for (const bar of [...bars].sort((a, b) => a.openTime - b.openTime)) h.update(barHash(bar));
  return h.digest("hex").slice(0, 32);
}

/**
 * Point-in-time read: the bars a decision at `decisionAt` could have seen. A bar is visible only when it had
 * closed by then (availableAt ≤ decisionAt). This is the only accessor research code should use.
 */
export function barsVisibleAt(bars: HistoricalBar[], decisionAt: number): HistoricalBar[] {
  return bars.filter((b) => b.availableAt <= decisionAt);
}

export type CoverageStats = {
  bars: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  expectedBars: number;
  completeness: number | null;
  gaps: number;
  missingBars: number;
};

export function coverageStats(bars: HistoricalBar[], intervalMs: number): CoverageStats {
  if (bars.length === 0) return { bars: 0, firstOpenTime: null, lastOpenTime: null, expectedBars: 0, completeness: null, gaps: 0, missingBars: 0 };
  const sorted = [...bars].sort((a, b) => a.openTime - b.openTime);
  const first = sorted[0]!.openTime;
  const last = sorted[sorted.length - 1]!.openTime;
  const expected = Math.round((last - first) / intervalMs) + 1;
  const gaps = findGaps(sorted, intervalMs);
  return {
    bars: sorted.length,
    firstOpenTime: first,
    lastOpenTime: last,
    expectedBars: expected,
    completeness: sorted.length / expected,
    gaps: gaps.length,
    missingBars: gaps.reduce((s, g) => s + g.missingBars, 0),
  };
}
