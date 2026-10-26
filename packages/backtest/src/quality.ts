import type { BacktestObservation, DataQualityReport } from "./types.js";

const DEFAULT_GAP_MS = 15 * 60 * 1000;

/**
 * Report data quality without silently excluding failed/inactive tokens.
 * Incomplete histories and disappearing pairs are listed explicitly.
 */
export function reportDataQuality(
  observations: BacktestObservation[],
  options?: { gapThresholdMs?: number },
): DataQualityReport {
  const gapThresholdMs = options?.gapThresholdMs ?? DEFAULT_GAP_MS;
  const assumptions = [
    "Observations are processed strictly in receivedAt order.",
    "Fills use only prices available at event time plus configured latency.",
    "Missing price or liquidity prevents a fill; it does not invent a mark.",
    "Pairs that disappear mid-window remain in the universe report.",
    "Survivorship bias is not corrected; delisted/inactive pairs are disclosed.",
  ];

  if (observations.length === 0) {
    return {
      observationCount: 0,
      pairCount: 0,
      spanMs: null,
      startAt: null,
      endAt: null,
      missingPriceCount: 0,
      missingLiquidityCount: 0,
      disappearedPairs: [],
      inactivePairs: [],
      gaps: [],
      assumptions,
    };
  }

  const ordered = [...observations].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const startAt = ordered[0]!.receivedAt;
  const endAt = ordered[ordered.length - 1]!.receivedAt;
  const spanMs = Date.parse(endAt) - Date.parse(startAt);

  let missingPriceCount = 0;
  let missingLiquidityCount = 0;
  const byPair = new Map<string, BacktestObservation[]>();
  for (const obs of ordered) {
    if (obs.priceUsd === null) missingPriceCount += 1;
    if (obs.liquidityUsd === null) missingLiquidityCount += 1;
    const list = byPair.get(obs.pairAddress) ?? [];
    list.push(obs);
    byPair.set(obs.pairAddress, list);
  }

  const disappearedPairs: DataQualityReport["disappearedPairs"] = [];
  const inactivePairs: DataQualityReport["inactivePairs"] = [];
  const gaps: DataQualityReport["gaps"] = [];
  const windowEnd = Date.parse(endAt);

  for (const [pairAddress, rows] of byPair) {
    const baseSymbol = rows[0]?.baseSymbol ?? pairAddress.slice(0, 8);
    const priced = rows.filter((row) => row.priceUsd !== null && Number(row.priceUsd) > 0);
    if (priced.length === 0) {
      inactivePairs.push({
        pairAddress,
        baseSymbol,
        observationCount: rows.length,
        reason: "NO_POSITIVE_PRICE",
      });
    }

    const last = rows[rows.length - 1]!;
    const lastMs = Date.parse(last.receivedAt);
    if (windowEnd - lastMs > gapThresholdMs) {
      disappearedPairs.push({
        pairAddress,
        baseSymbol,
        lastSeenAt: last.receivedAt,
        observationCount: rows.length,
      });
    }

    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]!;
      const curr = rows[i]!;
      const gapMs = Date.parse(curr.receivedAt) - Date.parse(prev.receivedAt);
      if (gapMs > gapThresholdMs) {
        gaps.push({ pairAddress, from: prev.receivedAt, to: curr.receivedAt, gapMs });
      }
    }
  }

  return {
    observationCount: ordered.length,
    pairCount: byPair.size,
    spanMs,
    startAt,
    endAt,
    missingPriceCount,
    missingLiquidityCount,
    disappearedPairs,
    inactivePairs,
    gaps,
    assumptions,
  };
}
