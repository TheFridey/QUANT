import { barHash, datasetVersionHash, type BarAlignment, type HistoricalBar } from "./integrity.js";
import { calendarForInstrumentKind, expectedSlots, ExpectedSlotLimitExceeded, sessionOverlaps, type CalendarId } from "./calendar.js";
import { INTERVAL_MS, type HistoryInterval } from "./sources.js";

/**
 * GENESIS Phase 3 dataset quality report for one ASCEND-01 warehouse dataset. Pure: the caller loads the
 * stored bars, the revision count and the rejections; nothing here reads a database or a provider.
 *
 * Gaps are measured against the asset-class calendar, then classified by what the source can tell us:
 * a source that omits empty intervals (GeckoTerminal `include_empty_intervals=false`) produces gaps that are
 * normally genuine no-trade intervals, whereas a missing session on a complete-session source (Alpaca daily)
 * is missing data. A dense series with a hole is suspicious even on an omitting source.
 */

export const DATASET_QUALITY_SCHEMA = "genesis.dataset-quality.v1";

export type GapSemantics = "EMPTY_INTERVALS_OMITTED" | "COMPLETE_SESSIONS" | "UNKNOWN";
export type GapClass = "NO_TRADE_LIKELY" | "MISSING_DATA" | "MISSING_DATA_SUSPECTED" | "UNCLASSIFIED";
export type OhlcViolationKind = "NON_FINITE" | "NON_POSITIVE" | "HIGH_BELOW_BODY" | "LOW_ABOVE_BODY" | "NEGATIVE_VOLUME" | "AVAILABLE_AT_MISMATCH";
export type SurvivorshipStatus = "INACTIVE_COHORT" | "POSSIBLY_INACTIVE" | "ACTIVE_AT_LAST_BAR" | "NO_BARS";

export type QualityFlag =
  | "NO_BARS"
  | "CALENDAR_UNKNOWN"
  | "CALENDAR_INCOMPLETE"
  | "EXPECTED_SLOTS_LIMIT"
  | "GAPS_MISSING_DATA"
  | "GAPS_MISSING_DATA_SUSPECTED"
  | "GAPS_NO_TRADE"
  | "GAPS_UNCLASSIFIED"
  | "OFF_CALENDAR_BARS"
  | "MISALIGNED_BARS"
  | "DUPLICATE_BARS"
  | "DUPLICATE_CONFLICTS"
  | "OHLC_VIOLATIONS"
  | "STALE_RUNS"
  | "ZERO_VOLUME_RUNS"
  | "REVISIONS_PRESENT"
  | "REJECTIONS_PRESENT"
  | "VERSION_HASH_MISMATCH"
  | "VERSION_HASH_MISSING"
  | "INACTIVE_CANDIDATE";

export type QualityDataset = {
  id: string;
  sourceId: string;
  instrumentKey: string;
  instrumentKind: string;
  cohort: string;
  interval: string;
  /** HistoricalDataset.versionHash as stored (null before the first import). */
  versionHash: string | null;
  /** HistoricalDataset.lastOpenTime (epoch ms). Survivorship uses it when the bars are a window. */
  lastOpenTime?: number | null;
};

export type QualityBar = Pick<HistoricalBar, "openTime" | "availableAt" | "open" | "high" | "low" | "close" | "volume">;

export type DatasetQualityInput = {
  dataset: QualityDataset;
  bars: QualityBar[];
  revisions: number;
  rejectionsByReason: Record<string, number>;
  /** Report time, epoch ms. Used only for the survivorship age check. */
  asOf: number;
  options?: {
    /** Bound on every listed array (gaps, duplicates, violations, runs). Counts stay exact. */
    maxListed?: number;
    /** Shortest stale / zero-volume run reported. */
    minRunBars?: number;
    /** Measure coverage over this window instead of first..last bar. Epoch ms, inclusive opens. */
    window?: { fromOpenTime: number; toOpenTime: number };
    /** Override the calendar picked from instrumentKind. */
    calendar?: CalendarId;
    /** A dataset whose last bar is older than this (vs asOf) is an inactive candidate. Default max(7 d, 24 bars). */
    inactiveAfterMs?: number;
    /** Completeness at or above which an omitting source's gaps are suspected missing data. Default 0.95. */
    denseCompleteness?: number;
  };
};

export type QualityGap = { fromOpenTime: string; toOpenTime: string; missingBars: number; class: GapClass };
export type QualityRun = { fromOpenTime: string; toOpenTime: string; bars: number };

export type DatasetQualityReport = {
  schema: typeof DATASET_QUALITY_SCHEMA;
  dataset: QualityDataset;
  asOf: string;
  calendar: { id: CalendarId; alignment: BarAlignment; complete: boolean; unknownYears: number[] };
  coverage: {
    firstOpenTime: string | null;
    lastOpenTime: string | null;
    windowFrom: string | null;
    windowTo: string | null;
    actualBars: number;
    expectedBars: number | null;
    missingBars: number | null;
    completeness: number | null;
    offCalendarBars: number;
    misalignedBars: number;
  };
  gaps: { semantics: GapSemantics; count: number; missingBars: number; byClass: Record<GapClass, { count: number; missingBars: number }>; listed: QualityGap[]; truncated: boolean };
  duplicates: { count: number; conflicting: number; listed: string[]; truncated: boolean };
  revisions: number;
  rejections: { total: number; byReason: Record<string, number> };
  staleRuns: { count: number; longest: number; listed: QualityRun[]; truncated: boolean };
  zeroVolumeRuns: { count: number; longest: number; listed: QualityRun[]; truncated: boolean };
  nullVolumeBars: number;
  ohlcViolations: { count: number; byKind: Partial<Record<OhlcViolationKind, number>>; listed: Array<{ openTime: string; kind: OhlcViolationKind }>; truncated: boolean };
  /**
   * Deterministic hash over (openTime, o, h, l, c, v); equals HistoricalDataset.versionHash for the same bars.
   * With a window it covers the window's bars only, and versionHashMatches is null.
   */
  contentHash: string | null;
  storedVersionHash: string | null;
  versionHashMatches: boolean | null;
  survivorship: { cohort: string; status: SurvivorshipStatus; lastBarAgeMs: number | null; inactiveAfterMs: number };
  flags: QualityFlag[];
  verdict: "PASS" | "WARN" | "FAIL";
};

/** How a known source represents intervals without trades. */
export function gapSemanticsFor(sourceId: string, interval: string): GapSemantics {
  if (sourceId === "geckoterminal") return "EMPTY_INTERVALS_OMITTED";
  // Alpaca daily bars cover every session; intraday IEX bars are one venue and can have no prints.
  if (sourceId === "alpaca_iex") return interval === "1d" ? "COMPLETE_SESSIONS" : "EMPTY_INTERVALS_OMITTED";
  return "UNKNOWN";
}

/** Bar-open convention per source (mirrors HistoricalBarSource.barAlignment). */
export function alignmentFor(sourceId: string, interval: string): BarAlignment {
  return sourceId === "alpaca_iex" && interval === "1d" ? "NEW_YORK_DAY" : "UTC_GRID";
}

const iso = (ms: number) => new Date(ms).toISOString();

function finite(text: string | null): number | null {
  if (text === null || text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function ohlcViolation(bar: QualityBar, intervalMs: number): OhlcViolationKind | null {
  const o = finite(bar.open);
  const h = finite(bar.high);
  const l = finite(bar.low);
  const c = finite(bar.close);
  const v = bar.volume === null ? null : finite(bar.volume);
  if (o === null || h === null || l === null || c === null || (bar.volume !== null && v === null)) return "NON_FINITE";
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return "NON_POSITIVE";
  if (v !== null && v < 0) return "NEGATIVE_VOLUME";
  if (h < Math.max(o, c) || h < l) return "HIGH_BELOW_BODY";
  if (l > Math.min(o, c)) return "LOW_ABOVE_BODY";
  // ASCEND-01 stamps availableAt = open + interval for every source (daily NY bars included).
  if (bar.availableAt !== bar.openTime + intervalMs) return "AVAILABLE_AT_MISMATCH";
  return null;
}

function isAligned(openTime: number, intervalMs: number, alignment: BarAlignment): boolean {
  if (alignment === "UTC_GRID") return openTime % intervalMs === 0;
  // NEW_YORK_DAY: midnight New York is 04:00Z or 05:00Z.
  const hour = (openTime % 86_400_000) / 3_600_000;
  return intervalMs === 86_400_000 && (hour === 4 || hour === 5);
}

function collectRuns(bars: QualityBar[], test: (bar: QualityBar, prev: QualityBar | undefined) => boolean, minRun: number): QualityRun[] {
  const runs: QualityRun[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start + 1 >= minRun) runs.push({ fromOpenTime: iso(bars[start]!.openTime), toOpenTime: iso(bars[end]!.openTime), bars: end - start + 1 });
    start = -1;
  };
  for (let i = 0; i < bars.length; i += 1) {
    if (test(bars[i]!, bars[i - 1])) {
      if (start < 0) start = i;
    } else {
      close(i - 1);
    }
  }
  close(bars.length - 1);
  return runs;
}

const bounded = <T>(items: T[], max: number) => ({ listed: items.slice(0, max), truncated: items.length > max });

export function datasetQualityReport(input: DatasetQualityInput): DatasetQualityReport {
  const { dataset, asOf } = input;
  const opts = input.options ?? {};
  const maxListed = Math.max(0, opts.maxListed ?? 50);
  const minRun = Math.max(2, opts.minRunBars ?? 3);
  const intervalMs = INTERVAL_MS[dataset.interval as HistoryInterval];
  if (!intervalMs) throw new Error(`unsupported interval ${dataset.interval}`);
  const calendarId = opts.calendar ?? calendarForInstrumentKind(dataset.instrumentKind);
  const alignment = alignmentFor(dataset.sourceId, dataset.interval);
  const semantics = gapSemanticsFor(dataset.sourceId, dataset.interval);
  const flags = new Set<QualityFlag>();

  // Duplicates: identical rows are harmless repeats; differing rows for one open are conflicts.
  const sortedAll = [...input.bars].sort((a, b) => a.openTime - b.openTime || barHash(a).localeCompare(barHash(b)));
  const unique: QualityBar[] = [];
  const duplicateTimes: number[] = [];
  let conflicting = 0;
  for (const bar of sortedAll) {
    const prev = unique.at(-1);
    if (prev && prev.openTime === bar.openTime) {
      duplicateTimes.push(bar.openTime);
      if (barHash(prev) !== barHash(bar)) conflicting += 1;
      continue;
    }
    unique.push(bar);
  }

  const violations: Array<{ openTime: string; kind: OhlcViolationKind }> = [];
  const byKind: Partial<Record<OhlcViolationKind, number>> = {};
  let misaligned = 0;
  let nullVolume = 0;
  for (const bar of unique) {
    const kind = ohlcViolation(bar, intervalMs);
    if (kind) {
      violations.push({ openTime: iso(bar.openTime), kind });
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    if (!isAligned(bar.openTime, intervalMs, alignment)) misaligned += 1;
    if (bar.volume === null) nullVolume += 1;
  }

  const first = unique[0]?.openTime ?? null;
  const last = unique.at(-1)?.openTime ?? null;
  const windowFrom = opts.window?.fromOpenTime ?? first;
  const windowTo = opts.window?.toOpenTime ?? last;
  const inWindow = windowFrom === null || windowTo === null ? [] : unique.filter((b) => b.openTime >= windowFrom && b.openTime <= windowTo);

  // Expected slots and calendar-aware gaps.
  let expectedBars: number | null = null;
  let calendarComplete = calendarId !== "UNKNOWN";
  let unknownYears: number[] = [];
  let offCalendar = 0;
  let presentExpected = inWindow.length;
  const gaps: QualityGap[] = [];
  const rawGaps: Array<{ from: number; to: number; missing: number }> = [];
  if (calendarId === "UNKNOWN") flags.add("CALENDAR_UNKNOWN");
  if (windowFrom !== null && windowTo !== null && calendarId !== "UNKNOWN") {
    try {
      const slots = expectedSlots({ calendar: calendarId, intervalMs, alignment, fromOpenTime: windowFrom, toOpenTime: windowTo });
      expectedBars = slots.openTimes.length;
      calendarComplete = slots.calendarComplete;
      unknownYears = slots.unknownYears;
      const present = new Set(inWindow.map((b) => b.openTime));
      const expectedSet = new Set(slots.openTimes);
      presentExpected = inWindow.filter((b) => expectedSet.has(b.openTime)).length;
      offCalendar = inWindow.filter((b) => !expectedSet.has(b.openTime) && !sessionOverlaps(calendarId, b.openTime, b.openTime + intervalMs)).length;
      let runStart = -1;
      for (let i = 0; i <= slots.openTimes.length; i += 1) {
        const missing = i < slots.openTimes.length && !present.has(slots.openTimes[i]!);
        if (missing && runStart < 0) runStart = i;
        if (!missing && runStart >= 0) {
          rawGaps.push({ from: slots.openTimes[runStart]!, to: slots.openTimes[i - 1]!, missing: i - runStart });
          runStart = -1;
        }
      }
    } catch (error) {
      if (!(error instanceof ExpectedSlotLimitExceeded)) throw error;
      flags.add("EXPECTED_SLOTS_LIMIT");
      expectedBars = null;
    }
  }
  if (expectedBars === null && inWindow.length > 1) {
    // No calendar expectation: fall back to plain grid steps between consecutive bars (unclassified).
    for (let i = 1; i < inWindow.length; i += 1) {
      const missing = Math.round((inWindow[i]!.openTime - inWindow[i - 1]!.openTime) / intervalMs) - 1;
      if (missing >= 1) rawGaps.push({ from: inWindow[i - 1]!.openTime + intervalMs, to: inWindow[i]!.openTime - intervalMs, missing });
    }
  }
  const missingBars = expectedBars === null ? null : expectedBars - presentExpected;
  const completeness = expectedBars ? presentExpected / expectedBars : null;
  const dense = completeness !== null && completeness >= (opts.denseCompleteness ?? 0.95);
  const classify = (): GapClass => {
    if (expectedBars === null || semantics === "UNKNOWN") return "UNCLASSIFIED";
    if (semantics === "COMPLETE_SESSIONS") return "MISSING_DATA";
    return dense ? "MISSING_DATA_SUSPECTED" : "NO_TRADE_LIKELY";
  };
  const byClass: Record<GapClass, { count: number; missingBars: number }> = {
    NO_TRADE_LIKELY: { count: 0, missingBars: 0 },
    MISSING_DATA: { count: 0, missingBars: 0 },
    MISSING_DATA_SUSPECTED: { count: 0, missingBars: 0 },
    UNCLASSIFIED: { count: 0, missingBars: 0 },
  };
  for (const gap of rawGaps) {
    const cls = classify();
    byClass[cls].count += 1;
    byClass[cls].missingBars += gap.missing;
    gaps.push({ fromOpenTime: iso(gap.from), toOpenTime: iso(gap.to), missingBars: gap.missing, class: cls });
  }
  // Largest gaps first, then chronological, so a bounded list keeps the ones that matter.
  gaps.sort((a, b) => b.missingBars - a.missingBars || a.fromOpenTime.localeCompare(b.fromOpenTime));

  const staleRuns = collectRuns(
    unique,
    (bar, prev) => Boolean(prev) && bar.open === bar.high && bar.high === bar.low && bar.low === bar.close && Number(bar.close) === Number(prev!.close),
    minRun,
  );
  const zeroRuns = collectRuns(unique, (bar) => bar.volume !== null && Number(bar.volume) === 0, minRun);

  // With a window the bars may be a subset, so their hash identifies the window, not the dataset version.
  const windowed = opts.window !== undefined;
  const contentHash = unique.length ? datasetVersionHash(unique) : null;
  const versionHashMatches = windowed || dataset.versionHash === null || contentHash === null ? null : dataset.versionHash === contentHash;

  const inactiveAfterMs = opts.inactiveAfterMs ?? Math.max(7 * 86_400_000, 24 * intervalMs);
  const lastForAge = dataset.lastOpenTime ?? last;
  const lastBarAgeMs = lastForAge === null ? null : Math.max(0, asOf - (lastForAge + intervalMs));
  const survivorshipStatus: SurvivorshipStatus =
    dataset.cohort === "INACTIVE" ? "INACTIVE_COHORT" : lastBarAgeMs === null ? "NO_BARS" : lastBarAgeMs > inactiveAfterMs ? "POSSIBLY_INACTIVE" : "ACTIVE_AT_LAST_BAR";

  const rejectionTotal = Object.values(input.rejectionsByReason).reduce((s, n) => s + n, 0);

  if (unique.length === 0) flags.add("NO_BARS");
  if (calendarId !== "UNKNOWN" && !calendarComplete) flags.add("CALENDAR_INCOMPLETE");
  if (byClass.MISSING_DATA.count) flags.add("GAPS_MISSING_DATA");
  if (byClass.MISSING_DATA_SUSPECTED.count) flags.add("GAPS_MISSING_DATA_SUSPECTED");
  if (byClass.NO_TRADE_LIKELY.count) flags.add("GAPS_NO_TRADE");
  if (byClass.UNCLASSIFIED.count) flags.add("GAPS_UNCLASSIFIED");
  if (offCalendar) flags.add("OFF_CALENDAR_BARS");
  if (misaligned) flags.add("MISALIGNED_BARS");
  if (duplicateTimes.length) flags.add("DUPLICATE_BARS");
  if (conflicting) flags.add("DUPLICATE_CONFLICTS");
  if (violations.length) flags.add("OHLC_VIOLATIONS");
  if (staleRuns.length) flags.add("STALE_RUNS");
  if (zeroRuns.length) flags.add("ZERO_VOLUME_RUNS");
  if (input.revisions > 0) flags.add("REVISIONS_PRESENT");
  if (rejectionTotal > 0) flags.add("REJECTIONS_PRESENT");
  if (versionHashMatches === false) flags.add("VERSION_HASH_MISMATCH");
  if (!windowed && dataset.versionHash === null && unique.length > 0) flags.add("VERSION_HASH_MISSING");
  if (survivorshipStatus === "POSSIBLY_INACTIVE") flags.add("INACTIVE_CANDIDATE");

  const failing: QualityFlag[] = ["NO_BARS", "GAPS_MISSING_DATA", "DUPLICATE_CONFLICTS", "OHLC_VIOLATIONS", "VERSION_HASH_MISMATCH", "MISALIGNED_BARS", "OFF_CALENDAR_BARS"];
  const informational: QualityFlag[] = ["GAPS_NO_TRADE", "INACTIVE_CANDIDATE"];
  const verdict = failing.some((f) => flags.has(f)) ? "FAIL" : [...flags].some((f) => !informational.includes(f)) ? "WARN" : "PASS";

  return {
    schema: DATASET_QUALITY_SCHEMA,
    dataset,
    asOf: iso(asOf),
    calendar: { id: calendarId, alignment, complete: calendarId !== "UNKNOWN" && calendarComplete, unknownYears },
    coverage: {
      firstOpenTime: first === null ? null : iso(first),
      lastOpenTime: last === null ? null : iso(last),
      windowFrom: windowFrom === null ? null : iso(windowFrom),
      windowTo: windowTo === null ? null : iso(windowTo),
      actualBars: inWindow.length,
      expectedBars,
      missingBars,
      completeness: completeness === null ? null : Number(completeness.toFixed(6)),
      offCalendarBars: offCalendar,
      misalignedBars: misaligned,
    },
    gaps: { semantics, count: gaps.length, missingBars: rawGaps.reduce((s, g) => s + g.missing, 0), byClass, ...bounded(gaps, maxListed) },
    duplicates: { count: duplicateTimes.length, conflicting, ...bounded(duplicateTimes.map(iso), maxListed) },
    revisions: input.revisions,
    rejections: { total: rejectionTotal, byReason: { ...input.rejectionsByReason } },
    staleRuns: { count: staleRuns.length, longest: staleRuns.reduce((m, r) => Math.max(m, r.bars), 0), ...bounded(staleRuns, maxListed) },
    zeroVolumeRuns: { count: zeroRuns.length, longest: zeroRuns.reduce((m, r) => Math.max(m, r.bars), 0), ...bounded(zeroRuns, maxListed) },
    nullVolumeBars: nullVolume,
    ohlcViolations: { count: violations.length, byKind, ...bounded(violations, maxListed) },
    contentHash,
    storedVersionHash: dataset.versionHash,
    versionHashMatches,
    survivorship: { cohort: dataset.cohort, status: survivorshipStatus, lastBarAgeMs, inactiveAfterMs },
    flags: [...flags].sort(),
    verdict,
  };
}

export type SurvivorshipSummary = {
  datasets: number;
  byCohort: Record<string, number>;
  inactiveCohort: number;
  possiblyInactive: number;
  /** SURVIVORS_ONLY: no INACTIVE cohort, so any study over this universe carries uncorrected survivorship bias. */
  status: "SURVIVORS_ONLY" | "INACTIVE_COHORT_PRESENT" | "EMPTY";
};

/** Universe-level survivorship disclosure from dataset metadata (no bars needed). */
export function survivorshipSummary(datasets: Array<{ cohort: string; interval: string; lastOpenTime: number | null }>, asOf: number, inactiveAfterMs?: number): SurvivorshipSummary {
  const byCohort: Record<string, number> = {};
  let possiblyInactive = 0;
  for (const d of datasets) {
    byCohort[d.cohort] = (byCohort[d.cohort] ?? 0) + 1;
    const intervalMs = INTERVAL_MS[d.interval as HistoryInterval] ?? 86_400_000;
    const threshold = inactiveAfterMs ?? Math.max(7 * 86_400_000, 24 * intervalMs);
    if (d.cohort !== "INACTIVE" && d.lastOpenTime !== null && asOf - (d.lastOpenTime + intervalMs) > threshold) possiblyInactive += 1;
  }
  const inactiveCohort = byCohort.INACTIVE ?? 0;
  return {
    datasets: datasets.length,
    byCohort,
    inactiveCohort,
    possiblyInactive,
    status: datasets.length === 0 ? "EMPTY" : inactiveCohort > 0 ? "INACTIVE_COHORT_PRESENT" : "SURVIVORS_ONLY",
  };
}
