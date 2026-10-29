import { SEED_INSTRUMENTS, canPaperExecute, type Instrument } from "@odin/shared";
import type { NormalizedPair } from "@odin/shared";

/**
 * Realistic FIXTURE sequences — only for tradingEnvironment=FIXTURE.
 * Never inject into MARKET_DATA_PAPER / EXTERNAL_DEMO accounts or metrics.
 *
 * Sequences include: changing bid/ask, warmup, no-signal, wins/losses, gaps,
 * session boundaries, partials, failures. FX/ETF do NOT fabricate DEX tx counts.
 */

export type FixtureTick = {
  instrumentId: string;
  mid: string;
  bid: string;
  ask: string;
  /** M5 change used by pulse — varies across sequence (incl. no-signal). */
  priceChangeM5Pct: string;
  priceChangeH1Pct: string;
  eventAtOffsetMs: number;
  note: string;
};

/** Base mid levels for sequence generation (not constant forever). */
export const FIXTURE_BASE_MIDS: Record<string, string> = {
  "fx:EURUSD": "1.08500000",
  "fx:GBPUSD": "1.26500000",
  "etf:SPY": "520.25000000",
  "etf:QQQ": "445.75000000",
  "commodity:XAUUSD": "2650.50000000",
  "commodity:WTI": "78.25000000",
};

/** @deprecated Use FIXTURE_BASE_MIDS + buildFixtureSequence — fixed levels are not market-driven. */
export const PAPER_FIXTURE_LEVELS = FIXTURE_BASE_MIDS;

const SEQUENCE_STEPS: Array<{
  midMult: number;
  m5: string;
  h1: string;
  spreadBps: number;
  note: string;
  gapMs: number;
}> = [
  { midMult: 1.0, m5: "0.100000", h1: "0.200000", spreadBps: 2, note: "warmup", gapMs: 0 },
  { midMult: 1.0, m5: "0.050000", h1: "0.100000", spreadBps: 2, note: "no-signal", gapMs: 60_000 },
  { midMult: 1.012, m5: "2.800000", h1: "1.200000", spreadBps: 3, note: "entry-signal", gapMs: 120_000 },
  { midMult: 1.018, m5: "1.500000", h1: "1.400000", spreadBps: 2, note: "winner-mark", gapMs: 180_000 },
  { midMult: 0.992, m5: "-2.200000", h1: "0.500000", spreadBps: 4, note: "loser-drawdown", gapMs: 240_000 },
  { midMult: 0.97, m5: "-4.500000", h1: "-1.000000", spreadBps: 8, note: "gap-through-stop", gapMs: 300_000 },
  { midMult: 1.005, m5: "0.800000", h1: "0.300000", spreadBps: 2, note: "session-resume", gapMs: 360_000 },
  { midMult: 1.01, m5: "1.100000", h1: "0.900000", spreadBps: 3, note: "partial-fill-window", gapMs: 420_000 },
  { midMult: 1.01, m5: "0.000000", h1: "0.500000", spreadBps: 50, note: "wide-spread-failure", gapMs: 480_000 },
];

export function buildFixtureSequence(input?: {
  instruments?: Instrument[];
  baseMids?: Record<string, string>;
}): FixtureTick[] {
  const levels = input?.baseMids ?? FIXTURE_BASE_MIDS;
  const instruments = (input?.instruments ?? SEED_INSTRUMENTS).filter(
    (item) =>
      canPaperExecute(item) &&
      (item.assetClass === "FX_SPOT" ||
        item.assetClass === "EQUITY_ETF_PROXY" ||
        item.assetClass === "COMMODITY_PROXY") &&
      item.enabledByDefault,
  );
  const ticks: FixtureTick[] = [];
  for (const instrument of instruments) {
    const base = Number(levels[instrument.id] ?? "100");
    for (const step of SEQUENCE_STEPS) {
      const mid = base * step.midMult;
      const half = mid * (step.spreadBps / 10_000) * 0.5;
      ticks.push({
        instrumentId: instrument.id,
        mid: mid.toFixed(8),
        bid: (mid - half).toFixed(8),
        ask: (mid + half).toFixed(8),
        priceChangeM5Pct: step.m5,
        priceChangeH1Pct: step.h1,
        eventAtOffsetMs: step.gapMs,
        note: step.note,
      });
    }
  }
  return ticks;
}

/**
 * Build NormalizedPair rows for a single fixture step index.
 * Provenance is always FIXTURE — never LIVE / DEMO market-data.
 * FX and ETF: no fabricated DEX buy/sell txn counts.
 */
export function buildFixturePairsAtStep(input: {
  stepIndex: number;
  instruments?: Instrument[];
  baseMids?: Record<string, string>;
  now?: Date;
}): NormalizedPair[] {
  const now = input.now ?? new Date();
  const sequence = buildFixtureSequence({
    instruments: input.instruments,
    baseMids: input.baseMids,
  });
  const byInstrument = new Map<string, FixtureTick[]>();
  for (const tick of sequence) {
    const list = byInstrument.get(tick.instrumentId) ?? [];
    list.push(tick);
    byInstrument.set(tick.instrumentId, list);
  }
  const pairs: NormalizedPair[] = [];
  for (const [instrumentId, ticks] of byInstrument) {
    const tick = ticks[Math.min(input.stepIndex, ticks.length - 1)]!;
    const instrument = (input.instruments ?? SEED_INSTRUMENTS).find((i) => i.id === instrumentId)!;
    const isFx = instrument.assetClass === "FX_SPOT";
    const isCommodity = instrument.assetClass === "COMMODITY_PROXY";
    pairs.push({
      source: isFx
        ? ("fx_stub" as const)
        : isCommodity
          ? ("commodity_stub" as const)
          : ("etf_stub" as const),
      chainId: isFx ? ("fx" as const) : isCommodity ? ("commodity" as const) : ("equity" as const),
      pairAddress: instrument.id,
      dexId: isFx ? "fx-fixture" : isCommodity ? "commodity-fixture" : "etf-fixture",
      url: null,
      baseAddress: instrument.base,
      baseSymbol: instrument.symbol,
      baseName: instrument.displayName,
      quoteAddress: instrument.quote,
      quoteSymbol: instrument.quote,
      priceUsd: tick.mid,
      // FX/ETF: liquidity optional; never invent DEX-style volume floors as "real".
      liquidityUsd: isFx ? null : "50000000.00000000",
      volume24hUsd: isFx ? null : "10000000.00000000",
      volume5mUsd: isFx ? null : null,
      priceChangeM5Pct: tick.priceChangeM5Pct,
      priceChangeH1Pct: tick.priceChangeH1Pct,
      priceChangeH24Pct: "0.500000",
      // No fake DEX txn counts for FX/ETFs/commodities.
      txnsM5Buys: null,
      txnsM5Sells: null,
      pairCreatedAt: null,
      fdvUsd: null,
      marketCapUsd: null,
      raw: {
        provenance: "FIXTURE_SEQUENCE",
        dataState: "DEMO",
        dataOrigin: "FIXTURE_SEQUENCE",
        tradingEnvironment: "FIXTURE",
        instrumentId: instrument.id,
        bid: tick.bid,
        ask: tick.ask,
        mid: tick.mid,
        stepNote: tick.note,
        stepIndex: input.stepIndex,
        eventAtOffsetMs: tick.eventAtOffsetMs,
        receivedAt: now.toISOString(),
        note: "FIXTURE sequence — isolated account only; not market-driven paper",
      },
    });
  }
  return pairs;
}

/**
 * @deprecated Fixed-level DEMO inject into primary paper — forbidden in normal defaults.
 * Retained for explicit FIXTURE launch compatibility; prefer buildFixturePairsAtStep.
 */
export function buildPaperMultiMarketPairs(input: {
  instruments?: Instrument[];
  levels?: Record<string, string>;
  now?: Date;
  /** Must be true to acknowledge fixture isolation. */
  explicitFixtureLaunch?: boolean;
}): NormalizedPair[] {
  if (!input.explicitFixtureLaunch) {
    return [];
  }
  return buildFixturePairsAtStep({
    stepIndex: 2, // entry-signal step
    instruments: input.instruments,
    baseMids: input.levels,
    now: input.now,
  });
}
