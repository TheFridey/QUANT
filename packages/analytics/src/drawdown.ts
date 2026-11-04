import { d, Decimal } from "@odin/shared";

/**
 * Portfolio drawdown reporting.
 *
 * Historical max drawdown is measured over EVERY EquitySnapshot for the metrics
 * account (running peak, worst peak-to-trough fall), not a capped sample.
 * Current drawdown is measured against the account's persisted high-water mark.
 */

export const HISTORICAL_DRAWDOWN_METHOD = "running_peak_max_peak_to_trough_pct" as const;
export const HISTORICAL_DRAWDOWN_SOURCE = "EquitySnapshot.equityUsd (all rows, non-null equity, metrics account)" as const;

/** Raw single-row result of the all-history drawdown SQL (numerics as text). */
export type HistoricalDrawdownRow = {
  sampleCount: number | bigint | string | null;
  firstAt: Date | string | null;
  lastAt: Date | string | null;
  maxDrawdownPct: string | null;
  peakEquityUsd: string | null;
  troughEquityUsd: string | null;
  peakAt: Date | string | null;
  troughAt: Date | string | null;
};

export type HistoricalDrawdown = {
  range: "ALL";
  source: typeof HISTORICAL_DRAWDOWN_SOURCE;
  method: typeof HISTORICAL_DRAWDOWN_METHOD;
  /** Percent (0..100, positive = fall below the running peak); null with fewer than 2 samples. */
  maxDrawdownPct: string | null;
  peakEquityUsd: string | null;
  troughEquityUsd: string | null;
  peakAt: string | null;
  troughAt: string | null;
  sampleCount: number;
  firstAt: string | null;
  lastAt: string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fixed(value: string | null | undefined, places: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return d(value).toFixed(places);
}

/** Normalise the SQL row (or its absence) into the API shape. */
export function normaliseHistoricalDrawdown(row: HistoricalDrawdownRow | undefined | null): HistoricalDrawdown {
  const sampleCount = row?.sampleCount == null ? 0 : Number(row.sampleCount);
  const measurable = sampleCount >= 2 && row?.maxDrawdownPct != null;
  return {
    range: "ALL",
    source: HISTORICAL_DRAWDOWN_SOURCE,
    method: HISTORICAL_DRAWDOWN_METHOD,
    maxDrawdownPct: measurable ? fixed(row!.maxDrawdownPct, 4) : null,
    peakEquityUsd: measurable ? fixed(row!.peakEquityUsd, 8) : null,
    troughEquityUsd: measurable ? fixed(row!.troughEquityUsd, 8) : null,
    peakAt: measurable ? iso(row!.peakAt) : null,
    troughAt: measurable ? iso(row!.troughAt) : null,
    sampleCount,
    firstAt: iso(row?.firstAt),
    lastAt: iso(row?.lastAt),
  };
}

/**
 * In-memory reference implementation of the SQL (same semantics): points must be
 * in chronological order. Used for unit tests and parity checks.
 */
export function computeHistoricalDrawdown(points: Array<{ equityUsd: string; at: Date }>): HistoricalDrawdown {
  if (points.length === 0) return normaliseHistoricalDrawdown(null);
  let peak = d(points[0]!.equityUsd);
  let peakAt = points[0]!.at;
  let worst: { pct: Decimal; peak: Decimal; peakAt: Date; trough: Decimal; troughAt: Date } | null = null;
  for (const point of points) {
    const equity = d(point.equityUsd);
    if (equity.gte(peak)) {
      peak = equity;
      peakAt = point.at;
    }
    if (!peak.gt(0)) continue;
    const pct = peak.minus(equity).div(peak).mul(100);
    if (worst === null || pct.gt(worst.pct)) worst = { pct, peak, peakAt, trough: equity, troughAt: point.at };
  }
  return normaliseHistoricalDrawdown({
    sampleCount: points.length,
    firstAt: points[0]!.at,
    lastAt: points[points.length - 1]!.at,
    maxDrawdownPct: worst?.pct.toString() ?? null,
    peakEquityUsd: worst?.peak.toString() ?? null,
    troughEquityUsd: worst?.trough.toString() ?? null,
    peakAt: worst?.peakAt ?? null,
    troughAt: worst?.troughAt ?? null,
  });
}

/** Current equity's distance below the account high-water mark, in percent (4 dp). */
export function drawdownBelowHwmPct(equityUsd: string | null, highWaterMarkUsd: string | null): string | null {
  if (equityUsd === null || highWaterMarkUsd === null) return null;
  const hwm = d(highWaterMarkUsd);
  if (hwm.lte(0)) return null;
  return hwm.minus(d(equityUsd)).div(hwm).mul(100).toFixed(4);
}
