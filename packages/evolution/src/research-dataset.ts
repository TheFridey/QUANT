import { createHash } from "node:crypto";
import {
  DEFAULT_VALIDATION,
  performanceStats,
  predictRoundTripCost,
  simulate,
  walkForwardFolds,
  type MarketCalendar,
  type ResearchBar,
  type ResearchStrategy,
} from "@odin/backtest";
import { DEFAULT_STRATEGY } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";

/**
 * GENESIS Phase 8: instrument-scoped, versioned, point-in-time TEST input for the research loop, read from the
 * ASCEND-01 warehouse (`HistoricalDataset` / `HistoricalBar`). Research data only; never read by the trading loop.
 *
 * Contract:
 * - HYPOTHESISE pins one dataset (`pinResearchDataset`): id, versionHash, instrument, interval and an as-of time.
 * - TEST loads it through `loadPointInTimeDataset`, which returns only bars whose `availableAt` (bar close) is at or
 *   before the pinned as-of time, and refuses with a typed code when the dataset is gone, unversioned, changed since
 *   the pin (stale versionHash), for another instrument than the hypothesis names, or too short.
 * - Costs come from the same model the research CLIs use (`predictRoundTripCost`, conservative case, per side), but
 *   point-in-time: DEX liquidity is the latest observation at or before the as-of time, never a later one, and never
 *   fetched from the network. No cost basis means a refusal, never an assumed cost.
 */

export const RESEARCH_DATASET_ADAPTER_VERSION = "genesis-pit-1";
/** Same floor the ASCEND-03 validator uses before it attempts validation at all. */
export const RESEARCH_LOOP_MIN_BARS = DEFAULT_VALIDATION.minBars;
/** Most recent bars (at or before the as-of time) one TEST run executes in the sandbox. */
export const RESEARCH_LOOP_MAX_BARS = 5_000;
export const RESEARCH_LOOP_FOLDS = DEFAULT_VALIDATION.folds;
export const RESEARCH_LOOP_HOLDOUT_FRACTION = DEFAULT_VALIDATION.holdoutFraction;
/** Notional the cost model prices a fill at (same as the research CLIs). */
export const RESEARCH_COST_NOTIONAL_USD = 500;

export type DatasetRefusalCode =
  | "DATASET_UNAVAILABLE"
  | "DATASET_NOT_FOUND"
  | "DATASET_UNVERSIONED"
  | "DATASET_VERSION_STALE"
  | "INSTRUMENT_MISMATCH"
  | "INSUFFICIENT_BARS"
  | "INTERVAL_UNSUPPORTED"
  | "POINT_IN_TIME_VIOLATION"
  | "COST_UNAVAILABLE";

export type DatasetRefusal = { ok: false; code: DatasetRefusalCode; detail: string; evidence: Record<string, unknown> };

export type PinnedDataset = {
  datasetId: string;
  versionHash: string;
  sourceId: string;
  instrumentKey: string;
  instrumentKind: string;
  interval: string;
  barCount: number;
  /** Decisions may only use bars available at or before this time. Set when HYPOTHESISE pins the dataset. */
  asOf: string;
  adapter: string;
};

export type HistoricalPoint = {
  openTime: number;
  availableAt: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The stored close in plain decimal notation (what the sandbox receives as priceUsd). */
  closeText: string;
  volume: number | null;
  hash: string;
};

/** Plain decimal text for a Prisma Decimal (never exponent notation) or a number. */
function decimalText(value: unknown): string {
  if (typeof value === "number") return value.toString();
  if (value && typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") return (value as { toFixed(): string }).toFixed();
  return String(value);
}

export type DatasetEvidence = {
  adapter: string;
  datasetId: string;
  versionHash: string;
  sourceId: string;
  instrumentKey: string;
  instrumentKind: string;
  interval: string;
  asOf: string;
  window: { firstOpenTime: string; lastOpenTime: string; firstAvailableAt: string; lastAvailableAt: string };
  barCount: number;
  /** Latest availableAt among the bars returned; never after `asOf`. */
  maxAvailableAt: string;
  /** Bars the warehouse holds for this dataset that became available after `asOf` (excluded). */
  excludedAfterAsOf: number;
  /** Rows a reader returned past `asOf` that the adapter dropped (0 for the database reader). */
  filteredAfterAsOf: number;
  truncated: boolean;
  /** SHA-256 over openTime:hash of every bar returned, in order: identifies the exact window. */
  windowHash: string;
  calendar: MarketCalendar;
  expectedBars: number;
  coverage: number;
};

/** Minimal reader so the adapter works with a PrismaClient, a transaction client, or a test double. */
export type HistoricalReader = Pick<PrismaClient, "historicalDataset" | "historicalBar">;
export type CostReader = Pick<PrismaClient, "marketObservation">;

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** Periods per year for annualisation (crypto trades continuously; US ETFs 252 sessions). Mirrors the CLIs. */
const PERIODS: Record<string, { crypto: number; equity: number }> = {
  "5m": { crypto: 12 * 24 * 365, equity: 78 * 252 },
  "1h": { crypto: 24 * 365, equity: 7 * 252 },
  "1d": { crypto: 365, equity: 252 },
};

export function marketCalendarFor(instrumentKind: string): MarketCalendar {
  return instrumentKind === "EQUITY_ETF" ? "WEEKDAYS" : "CONTINUOUS";
}

export function periodsPerYearFor(interval: string, instrumentKind: string): number | null {
  const periods = PERIODS[interval];
  if (!periods) return null;
  return instrumentKind === "EQUITY_ETF" ? periods.equity : periods.crypto;
}

/** Bars a calendar expects between two bar opens, inclusive. Daily WEEKDAYS bars skip Saturday and Sunday. */
export function expectedBarCount(fromMs: number, toMs: number, barMs: number, calendar: MarketCalendar): number {
  if (toMs < fromMs) return 0;
  if (calendar === "CONTINUOUS" || barMs < 86_400_000) return Math.floor((toMs - fromMs) / barMs) + 1;
  let count = 0;
  for (let t = fromMs; t <= toMs; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function refusal(code: DatasetRefusalCode, detail: string, evidence: Record<string, unknown> = {}): DatasetRefusal {
  return { ok: false, code, detail, evidence: { code, ...evidence } };
}

/**
 * Deterministic dataset choice for a hypothesis: a versioned, non-empty dataset whose instrumentKey is one of the
 * hypothesis instruments; the one with most bars wins, then the lowest id.
 */
export async function pinResearchDataset(
  reader: HistoricalReader,
  input: { instrumentIds: readonly string[]; asOf: Date },
): Promise<{ ok: true; pinned: PinnedDataset } | DatasetRefusal> {
  if (input.instrumentIds.length === 0) return refusal("DATASET_UNAVAILABLE", "Hypothesis names no instrument");
  const rows = await reader.historicalDataset.findMany({
    where: { instrumentKey: { in: [...input.instrumentIds] }, versionHash: { not: null }, barCount: { gt: 0 } },
    orderBy: [{ barCount: "desc" }, { id: "asc" }],
    take: 1,
  });
  const row = rows[0];
  if (!row || !row.versionHash) {
    return refusal("DATASET_UNAVAILABLE", `No versioned warehouse dataset for ${input.instrumentIds.join(", ")}`, { instrumentIds: [...input.instrumentIds] });
  }
  return {
    ok: true,
    pinned: {
      datasetId: row.id,
      versionHash: row.versionHash,
      sourceId: row.sourceId,
      instrumentKey: row.instrumentKey,
      instrumentKind: row.instrumentKind,
      interval: row.interval,
      barCount: row.barCount,
      asOf: input.asOf.toISOString(),
      adapter: RESEARCH_DATASET_ADAPTER_VERSION,
    },
  };
}

export function parsePinnedDataset(value: unknown): PinnedDataset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const strings = ["datasetId", "versionHash", "sourceId", "instrumentKey", "instrumentKind", "interval", "asOf"] as const;
  for (const key of strings) if (typeof v[key] !== "string" || (v[key] as string).length === 0) return null;
  if (!Number.isFinite(Date.parse(v.asOf as string))) return null;
  return {
    datasetId: v.datasetId as string,
    versionHash: v.versionHash as string,
    sourceId: v.sourceId as string,
    instrumentKey: v.instrumentKey as string,
    instrumentKind: v.instrumentKind as string,
    interval: v.interval as string,
    barCount: typeof v.barCount === "number" ? v.barCount : 0,
    asOf: v.asOf as string,
    adapter: typeof v.adapter === "string" ? v.adapter : RESEARCH_DATASET_ADAPTER_VERSION,
  };
}

/**
 * Point-in-time load of a pinned dataset. Only bars with `availableAt <= pinned.asOf` are returned (the query filters,
 * and any row a reader returns past the as-of time is dropped and counted). Refusals are typed and carry evidence.
 */
export async function loadPointInTimeDataset(
  reader: HistoricalReader,
  input: { pinned: PinnedDataset; hypothesisInstrumentIds: readonly string[]; minBars?: number; maxBars?: number },
): Promise<{ ok: true; bars: HistoricalPoint[]; evidence: DatasetEvidence } | DatasetRefusal> {
  const { pinned } = input;
  const minBars = input.minBars ?? RESEARCH_LOOP_MIN_BARS;
  const maxBars = input.maxBars ?? RESEARCH_LOOP_MAX_BARS;
  const asOfMs = Date.parse(pinned.asOf);
  const base = { datasetId: pinned.datasetId, pinnedVersionHash: pinned.versionHash, asOf: pinned.asOf };
  const row = await reader.historicalDataset.findUnique({ where: { id: pinned.datasetId } });
  if (!row) return refusal("DATASET_NOT_FOUND", `Dataset ${pinned.datasetId} no longer exists`, base);
  if (!row.versionHash) return refusal("DATASET_UNVERSIONED", `Dataset ${row.id} has no versionHash`, base);
  if (row.versionHash !== pinned.versionHash) {
    return refusal("DATASET_VERSION_STALE", `Dataset ${row.id} changed since HYPOTHESISE pinned it (${pinned.versionHash.slice(0, 12)} -> ${row.versionHash.slice(0, 12)})`, {
      ...base,
      currentVersionHash: row.versionHash,
    });
  }
  if (row.instrumentKey !== pinned.instrumentKey || !input.hypothesisInstrumentIds.includes(row.instrumentKey)) {
    return refusal("INSTRUMENT_MISMATCH", `Dataset instrument ${row.instrumentKey} is not the hypothesis instrument (${input.hypothesisInstrumentIds.join(", ")})`, {
      ...base,
      datasetInstrumentKey: row.instrumentKey,
      pinnedInstrumentKey: pinned.instrumentKey,
      hypothesisInstrumentIds: [...input.hypothesisInstrumentIds],
    });
  }
  const barMs = INTERVAL_MS[row.interval];
  if (!barMs || periodsPerYearFor(row.interval, row.instrumentKind) === null) {
    return refusal("INTERVAL_UNSUPPORTED", `No bar length or annualisation for interval ${row.interval}`, base);
  }
  const asOf = new Date(asOfMs);
  const [rows, excludedAfterAsOf] = await Promise.all([
    reader.historicalBar.findMany({
      where: { datasetId: row.id, availableAt: { lte: asOf } },
      orderBy: { openTime: "desc" },
      take: maxBars + 1,
    }),
    reader.historicalBar.count({ where: { datasetId: row.id, availableAt: { gt: asOf } } }),
  ]);
  const inTime = rows.filter((bar) => bar.availableAt.getTime() <= asOfMs);
  const filteredAfterAsOf = rows.length - inTime.length;
  const truncated = inTime.length > maxBars;
  const chosen = inTime.slice(0, maxBars).reverse();
  const bars: HistoricalPoint[] = chosen.map((bar) => ({
    openTime: bar.openTime.getTime(),
    availableAt: bar.availableAt.getTime(),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    closeText: decimalText(bar.close),
    volume: bar.volume === null ? null : Number(bar.volume),
    hash: bar.hash,
  }));
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    // A bar cannot be usable before it opened, and openTime must strictly increase.
    if (bar.availableAt < bar.openTime || (index > 0 && bar.openTime <= bars[index - 1]!.openTime)) {
      return refusal("POINT_IN_TIME_VIOLATION", `Bar ${new Date(bar.openTime).toISOString()} is out of order or available before it opened`, base);
    }
    if (![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) {
      return refusal("POINT_IN_TIME_VIOLATION", `Bar ${new Date(bar.openTime).toISOString()} has a non-positive price`, base);
    }
  }
  if (bars.length < minBars) {
    return refusal("INSUFFICIENT_BARS", `${bars.length} bars available at or before ${pinned.asOf}; need ${minBars}`, { ...base, barCount: bars.length, minBars, excludedAfterAsOf });
  }
  const first = bars[0]!;
  const last = bars.at(-1)!;
  const calendar = marketCalendarFor(row.instrumentKind);
  const expectedBars = expectedBarCount(first.openTime, last.openTime, barMs, calendar);
  const windowHash = createHash("sha256").update(bars.map((bar) => `${bar.openTime}:${bar.hash}`).join("|")).digest("hex");
  return {
    ok: true,
    bars,
    evidence: {
      adapter: RESEARCH_DATASET_ADAPTER_VERSION,
      datasetId: row.id,
      versionHash: row.versionHash,
      sourceId: row.sourceId,
      instrumentKey: row.instrumentKey,
      instrumentKind: row.instrumentKind,
      interval: row.interval,
      asOf: pinned.asOf,
      window: {
        firstOpenTime: new Date(first.openTime).toISOString(),
        lastOpenTime: new Date(last.openTime).toISOString(),
        firstAvailableAt: new Date(first.availableAt).toISOString(),
        lastAvailableAt: new Date(last.availableAt).toISOString(),
      },
      barCount: bars.length,
      maxAvailableAt: new Date(Math.max(...bars.map((bar) => bar.availableAt))).toISOString(),
      excludedAfterAsOf,
      filteredAfterAsOf,
      truncated,
      windowHash,
      calendar,
      expectedBars,
      coverage: expectedBars > 0 ? Number((bars.length / expectedBars).toFixed(6)) : 0,
    },
  };
}

export type ResearchCost = { bpsPerSide: number; roundTripBps: number; basis: string; isProxy: boolean; model: string };

/**
 * The research CLIs' cost basis (ASCEND-06 `predictRoundTripCost`, conservative case, halved per side), made
 * point-in-time: DEX liquidity is the latest QUANT observation received at or before `asOf`. ETFs use the quoted
 * spread + fee model. No network fallback and no assumed cost: without a basis the TEST stage refuses.
 */
export async function researchCostPerSide(
  reader: CostReader,
  dataset: { instrumentKind: string; instrumentKey: string },
  asOf: Date,
): Promise<{ ok: true; cost: ResearchCost } | DatasetRefusal> {
  const feeBps = Number(DEFAULT_STRATEGY.feeBps);
  const spreadBpsEstimate = Number(DEFAULT_STRATEGY.spreadBpsEstimate);
  if (dataset.instrumentKind === "EQUITY_ETF") {
    const p = predictRoundTripCost({ instrumentId: `etf:${dataset.instrumentKey}`, notionalUsd: RESEARCH_COST_NOTIONAL_USD, liquidityUsd: null, feeBps, spreadBpsEstimate, stepVolatilityBps: null, latencySteps: 0 });
    if (!p.supported || !(p.conservativeBps > 0)) return refusal("COST_UNAVAILABLE", `ETF cost model unsupported: ${p.unsupportedReason ?? "no estimate"}`);
    return { ok: true, cost: { bpsPerSide: p.conservativeBps / 2, roundTripBps: p.conservativeBps, basis: `ETF quoted spread + fee (conservative ${p.conservativeBps.toFixed(1)} bps round trip)`, isProxy: true, model: p.model } };
  }
  const obs = await reader.marketObservation.findFirst({
    where: { pairAddress: dataset.instrumentKey, liquidityUsd: { not: null }, receivedAt: { lte: asOf } },
    orderBy: { receivedAt: "desc" },
    select: { liquidityUsd: true, receivedAt: true },
  });
  if (!obs?.liquidityUsd) {
    return refusal("COST_UNAVAILABLE", `No observed liquidity for ${dataset.instrumentKey} at or before ${asOf.toISOString()}; refusing to assume a cost`, { instrumentKey: dataset.instrumentKey });
  }
  const liquidity = Number(obs.liquidityUsd);
  const p = predictRoundTripCost({ instrumentId: dataset.instrumentKey, notionalUsd: RESEARCH_COST_NOTIONAL_USD, liquidityUsd: liquidity, feeBps, spreadBpsEstimate, stepVolatilityBps: null, latencySteps: 0 });
  if (!p.supported || !(p.conservativeBps > 0)) return refusal("COST_UNAVAILABLE", `DEX cost model unsupported: ${p.unsupportedReason ?? "no estimate"}`);
  return {
    ok: true,
    cost: {
      bpsPerSide: p.conservativeBps / 2,
      roundTripBps: p.conservativeBps,
      basis: `DEX $${RESEARCH_COST_NOTIONAL_USD} at liquidity $${Math.round(liquidity)} (QUANT observation ${obs.receivedAt.toISOString()}, at or before as-of), conservative ${p.conservativeBps.toFixed(1)} bps round trip; one liquidity reading stands in for the whole window`,
      isProxy: true,
      model: p.model,
    },
  };
}

export type SignalIntent = "ENTER_LONG" | "EXIT_LONG" | "HOLD" | string;

export type WindowMeasure = { startAt: string | null; endAt: string | null; bars: number; trades: number; netReturn: number; maxDrawdown: number; sharpe: number | null };

export type HistoricalMeasurement = {
  full: WindowMeasure;
  holdout: WindowMeasure;
  folds: Array<WindowMeasure & { fold: number }>;
  /** Full-window net return with every cost doubled (proxy cost basis must survive this). */
  fullNetReturnDoubleCost: number;
  holdoutStartIndex: number;
  costBpsPerSide: number;
  periodsPerYear: number;
};

/**
 * Measures sandbox signals on historical bars with the ASCEND-02 simulator: the signal for bar i (decided by the
 * forged code from bars 0..i only, inside the sandbox) sets the target position, which fills at the OPEN of bar
 * i + 1 and pays `costBpsPerSide` on every change. Long/flat only. The final `holdoutFraction` of bars is the
 * untouched holdout; walk-forward folds cover the span before it.
 */
export function measureSignalsOnBars(input: {
  bars: readonly HistoricalPoint[];
  intents: readonly SignalIntent[];
  costBpsPerSide: number;
  periodsPerYear: number;
  folds?: number;
  holdoutFraction?: number;
}): HistoricalMeasurement {
  if (input.intents.length !== input.bars.length) throw new Error("one signal per bar is required");
  const bars: ResearchBar[] = input.bars.map((bar) => ({ t: bar.openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
  const targets = new Map<number, 0 | 1>();
  let position: 0 | 1 = 0;
  input.intents.forEach((intent, index) => {
    if (intent === "ENTER_LONG") position = 1;
    else if (intent === "EXIT_LONG") position = 0;
    targets.set(bars[index]!.t, position);
  });
  const replay: ResearchStrategy = {
    id: "forged_sandbox_replay",
    lookback: 1,
    decide: (ctx) => targets.get(ctx.bars.at(-1)!.t) ?? 0,
  };
  const folds = input.folds ?? RESEARCH_LOOP_FOLDS;
  const holdoutFraction = input.holdoutFraction ?? RESEARCH_LOOP_HOLDOUT_FRACTION;
  const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
  const measure = (start: number, end: number, cost = input.costBpsPerSide): WindowMeasure => {
    const sim = simulate({ strategy: replay, bars, startIndex: start, endIndex: end, costBpsPerSide: cost });
    const stats = performanceStats(sim, input.periodsPerYear);
    return { startAt: iso(sim.barTimes[0]), endAt: iso(sim.barTimes.at(-1)), bars: stats.bars, trades: stats.trades, netReturn: stats.totalReturn, maxDrawdown: stats.maxDrawdown, sharpe: stats.sharpe };
  };
  const plan = walkForwardFolds(bars.length, { folds, holdoutFraction, embargoBars: 0 });
  return {
    full: measure(0, bars.length),
    holdout: measure(plan.holdoutStart, bars.length),
    folds: plan.folds.map((fold) => ({ fold: fold.fold, ...measure(fold.testStart, fold.testEnd) })),
    fullNetReturnDoubleCost: measure(0, bars.length, input.costBpsPerSide * 2).netReturn,
    holdoutStartIndex: plan.holdoutStart,
    costBpsPerSide: input.costBpsPerSide,
    periodsPerYear: input.periodsPerYear,
  };
}

/** Percent string (6 dp) for a fractional return; null when no trade closed (nothing is invented). */
export function returnPctOrNull(window: Pick<WindowMeasure, "trades" | "netReturn">): string | null {
  if (window.trades === 0 || !Number.isFinite(window.netReturn)) return null;
  return (window.netReturn * 100).toFixed(6);
}
