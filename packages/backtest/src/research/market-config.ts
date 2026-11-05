import { createHash } from "node:crypto";
import { fxSessionState, isUsEquitySessionDate, nyLocalParts, type SessionCalendar } from "./sessions.js";
import type { ResearchBar } from "./simulate.js";

/**
 * OPERATION HORIZON: versioned per-market research configurations. Research only: nothing here is read by
 * admission, sizing, risk, execution or promotion, and nothing changes DEFAULT_STRATEGY (whose global
 * `entryM5ChangePct` of 2% stays as it is for the paper engine). Research thresholds are expressed in ATR
 * multiples instead, so one figure means the same thing on EUR/USD, SPY, gold and SOL.
 *
 * Every number here is a pre-declared ASSUMPTION, chosen before any HORIZON result existed, and recorded in the
 * config hash. Costs are typical retail figures, not measured fills: spreads and slippage are quoted in the
 * market's own unit (pips for FX and metals, cents for ETFs, bps for crypto) and converted at the bar's price, so
 * a USD/JPY pip (0.01) and a EUR/USD pip (0.0001) are both handled correctly.
 */

export const MARKET_CONFIG_VERSION = "horizon-market-1.0.0";

export type MarketId = "CRYPTO" | "GOLD" | "FX" | "ETF";

export type SessionWindowId = "LONDON_OPEN" | "NY_OPEN" | "RTH_OPEN" | "RTH";

export type QuoteUnit = "BPS" | "PIPS";

export type CostModel = {
  /** Commission / exchange or pool fee, bps of notional per side. */
  feeBpsPerSide: number;
  /** Full quoted bid/ask spread in `unit`; each side pays half. */
  spreadFull: number;
  /** Additional slippage per side in `unit`. */
  slippagePerSide: number;
  unit: QuoteUnit;
  /** Multipliers on the half-spread (assumptions). A window not listed for the market is ×1. */
  widening: { sessionOpen: number; sessionClose: number; rollover: number; maintenanceOrHoliday: number; outsideRegularHours: number };
  /** Validation charges one flat per-side cost: this quantile of the per-bar cost over tradeable bars. */
  validationQuantile: number;
  assumptions: string[];
};

export type MarketResearchConfig = {
  id: MarketId;
  version: string;
  description: string;
  calendar: SessionCalendar;
  /** Examples the configuration was written for; any instrument of the market may use it. */
  instruments: string[];
  cost: CostModel;
  /** Trading hours per calendar day (converts horizons to daily bars) and per year (annualisation). */
  tradingHoursPerDay: number;
  tradingDaysPerYear: number;
  /** Label / holding horizons in trading hours. The first is the primary horizon used by ML 2.0 by default. */
  horizonsTradingHours: number[];
  volatility: {
    method: "ATR";
    /** True-range average window in bars. */
    atrBars: number;
    /** Research entry thresholds are multiples of ATR, never a fixed percentage. */
    thresholdUnit: "ATR_MULTIPLE";
    /** The paper engine's global 5-minute threshold, kept only to report what it means in ATR terms here. */
    legacyM5ThresholdPct: number;
  };
  /** Abstain from any entry unless the forecast move exceeds k × estimated round-trip cost. */
  costGate: { k: number; forecastAtrMultiple: number };
  minimumSample: { minBarsIntraday: number; minBarsDaily: number; minOosTrades: number; minMlEffectiveTestLabels: number; minMlEffectiveSignals: number };
  /** Session windows for session-aware variants (intraday bars only; empty = no session variant). */
  sessionWindows: SessionWindowId[];
};

const NO_WIDENING = { sessionOpen: 1, sessionClose: 1, rollover: 1, maintenanceOrHoliday: 1, outsideRegularHours: 1 };

const COMMON_SAMPLE = { minBarsIntraday: 1500, minBarsDaily: 500, minOosTrades: 30, minMlEffectiveTestLabels: 100, minMlEffectiveSignals: 30 };

export const MARKET_CONFIGS: Record<MarketId, MarketResearchConfig> = {
  CRYPTO: {
    id: "CRYPTO",
    version: MARKET_CONFIG_VERSION,
    description: "Liquid crypto majors (SOL, BTC, ETH against USD stablecoins), 24/7",
    calendar: "CRYPTO_24_7",
    instruments: ["SOL/USDC", "BTC/USD", "ETH/USD"],
    cost: {
      feeBpsPerSide: 10,
      spreadFull: 10,
      slippagePerSide: 5,
      unit: "BPS",
      widening: NO_WIDENING,
      validationQuantile: 0.9,
      assumptions: [
        "Centralised-venue taker fee 10 bps/side; 10 bps quoted spread; 5 bps slippage at small size",
        "Speculative DEX pools cost far more: use the ASCEND-06 cost basis or the CLI cost flags for them",
        "No session widening is modelled for a 24/7 market",
      ],
    },
    tradingHoursPerDay: 24,
    tradingDaysPerYear: 365,
    horizonsTradingHours: [24, 6, 72],
    volatility: { method: "ATR", atrBars: 14, thresholdUnit: "ATR_MULTIPLE", legacyM5ThresholdPct: 2 },
    costGate: { k: 2, forecastAtrMultiple: 1 },
    minimumSample: COMMON_SAMPLE,
    sessionWindows: [],
  },
  GOLD: {
    id: "GOLD",
    version: MARKET_CONFIG_VERSION,
    description: "Spot gold (XAU/USD) on the FX/metals calendar",
    calendar: "FX_24_5",
    instruments: ["XAU/USD"],
    cost: {
      feeBpsPerSide: 0,
      spreadFull: 35,
      slippagePerSide: 5,
      unit: "PIPS",
      widening: { sessionOpen: 3, sessionClose: 2, rollover: 3, maintenanceOrHoliday: 5, outsideRegularHours: 1 },
      validationQuantile: 0.9,
      assumptions: [
        "Spread-only retail CFD/spot account: no commission; 35-pip (US$0.35) quoted spread, 5-pip slippage per side; pip = 0.01",
        "Half-spread ×3 in the first two hours after the Sunday open and in the hours either side of the 22:00 UTC roll; ×2 in the two hours before the Friday close; ×5 in the maintenance hour or on a holiday",
        "Fixed 22:00 UTC roll all year (true roll is 17:00 New York; one hour early in summer)",
      ],
    },
    tradingHoursPerDay: 23,
    tradingDaysPerYear: 260,
    horizonsTradingHours: [8, 4, 24],
    volatility: { method: "ATR", atrBars: 14, thresholdUnit: "ATR_MULTIPLE", legacyM5ThresholdPct: 2 },
    costGate: { k: 2, forecastAtrMultiple: 1 },
    minimumSample: COMMON_SAMPLE,
    sessionWindows: ["LONDON_OPEN", "NY_OPEN"],
  },
  FX: {
    id: "FX",
    version: MARKET_CONFIG_VERSION,
    description: "Spot FX majors (EUR/USD, GBP/USD, USD/JPY) on the FX/metals calendar",
    calendar: "FX_24_5",
    instruments: ["EUR/USD", "GBP/USD", "USD/JPY"],
    cost: {
      feeBpsPerSide: 0,
      spreadFull: 1.2,
      slippagePerSide: 0.2,
      unit: "PIPS",
      widening: { sessionOpen: 3, sessionClose: 2, rollover: 3, maintenanceOrHoliday: 5, outsideRegularHours: 1 },
      validationQuantile: 0.9,
      assumptions: [
        "Spread-only retail account: no commission; 1.2-pip quoted spread, 0.2-pip slippage per side",
        "Pip = 0.0001, except JPY-quoted pairs where pip = 0.01; converted to bps at the bar's price",
        "Half-spread ×3 in the first two hours after the Sunday open and in the hours either side of the 22:00 UTC roll; ×2 in the two hours before the Friday close; ×5 in the maintenance hour or on a holiday",
        "Fixed 22:00 UTC roll all year (true roll is 17:00 New York; one hour early in summer)",
      ],
    },
    tradingHoursPerDay: 23,
    tradingDaysPerYear: 260,
    horizonsTradingHours: [8, 4, 24],
    volatility: { method: "ATR", atrBars: 14, thresholdUnit: "ATR_MULTIPLE", legacyM5ThresholdPct: 2 },
    costGate: { k: 2, forecastAtrMultiple: 1 },
    minimumSample: COMMON_SAMPLE,
    sessionWindows: ["LONDON_OPEN", "NY_OPEN"],
  },
  ETF: {
    id: "ETF",
    version: MARKET_CONFIG_VERSION,
    description: "US-listed index ETFs (SPY, QQQ) on the NYSE calendar",
    calendar: "US_EQUITY",
    instruments: ["SPY", "QQQ"],
    cost: {
      feeBpsPerSide: 0.1,
      spreadFull: 1,
      slippagePerSide: 2,
      unit: "PIPS",
      widening: { sessionOpen: 2, sessionClose: 2, rollover: 1, maintenanceOrHoliday: 1, outsideRegularHours: 4 },
      validationQuantile: 0.9,
      assumptions: [
        "Commission-free broker; 0.1 bps regulatory/clearing allowance; 1-cent quoted spread and 2-cent slippage per side; pip = one cent",
        "Half-spread ×2 in the first and last 30 minutes of regular trading hours (09:30-16:00 New York); ×4 outside them",
        "Daily bars fill at the opening auction at ×1 (the auction has no quoted spread; slippage still applies)",
      ],
    },
    tradingHoursPerDay: 6.5,
    tradingDaysPerYear: 252,
    horizonsTradingHours: [6.5, 3, 32.5],
    volatility: { method: "ATR", atrBars: 14, thresholdUnit: "ATR_MULTIPLE", legacyM5ThresholdPct: 2 },
    costGate: { k: 2, forecastAtrMultiple: 1 },
    minimumSample: { ...COMMON_SAMPLE, minBarsIntraday: 1000 },
    sessionWindows: ["RTH_OPEN", "RTH"],
  },
};

export function marketConfig(id: MarketId): MarketResearchConfig {
  return MARKET_CONFIGS[id];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
}

/** SHA-256 of the canonical (key-sorted) configuration: any change to any field changes the hash. */
export function marketConfigHash(cfg: MarketResearchConfig): string {
  return createHash("sha256").update(JSON.stringify(canonical(cfg))).digest("hex");
}

/**
 * Size of one quote unit (pip) in price terms. FX: 0.01 for JPY-quoted pairs, else 0.0001. Metals: 0.01 for
 * gold, 0.001 for silver. ETFs: one cent. Crypto quotes in bps, so the pip size is unused (null).
 */
export function pipSizeFor(market: MarketId, instrument: string): number | null {
  const sym = instrument.toUpperCase().replace(/[^A-Z]/g, "");
  if (market === "CRYPTO") return null;
  if (market === "ETF") return 0.01;
  if (market === "GOLD") return sym.startsWith("XAG") ? 0.001 : 0.01;
  return sym.endsWith("JPY") ? 0.01 : 0.0001;
}

/** Converts an amount in the market's quote unit to bps at `price`. */
export function unitToBps(amount: number, unit: QuoteUnit, pipSize: number | null, price: number): number {
  if (unit === "BPS") return amount;
  if (pipSize === null || !(price > 0)) throw new Error("a pip-quoted cost needs a pip size and a positive price");
  return ((amount * pipSize) / price) * 10_000;
}

export type CostWindow = "NORMAL" | "SESSION_OPEN" | "SESSION_CLOSE" | "ROLLOVER" | "MAINTENANCE_OR_HOLIDAY" | "OUTSIDE_REGULAR_HOURS";

/** Which spread-widening window the instant `t` falls in (bars shorter than a day; daily bars are NORMAL). */
export function costWindowAt(cfg: MarketResearchConfig, t: number, barMs: number): CostWindow {
  if (barMs >= 86_400_000) return "NORMAL";
  if (cfg.calendar === "FX_24_5") {
    const state = fxSessionState(t);
    if (state !== "OPEN") return "MAINTENANCE_OR_HOLIDAY";
    const d = new Date(t);
    const h = d.getUTCHours();
    const dow = d.getUTCDay();
    // The first two hours of the week: Sunday 22:00-24:00 UTC.
    if (dow === 0 && h >= 22) return "SESSION_OPEN";
    if (dow === 5 && (h === 19 || h === 20)) return "SESSION_CLOSE";
    if (h === 20 || h === 22) return "ROLLOVER";
    return "NORMAL";
  }
  if (cfg.calendar === "US_EQUITY") {
    const p = nyLocalParts(t);
    const minute = p.hour * 60 + p.minute;
    if (!isUsEquitySessionDate(p.ymd) || minute < 570 || minute >= 960) return "OUTSIDE_REGULAR_HOURS";
    if (minute < 600) return "SESSION_OPEN";
    if (minute >= 930) return "SESSION_CLOSE";
    return "NORMAL";
  }
  return "NORMAL";
}

function wideningFor(cost: CostModel, w: CostWindow): number {
  switch (w) {
    case "SESSION_OPEN":
      return cost.widening.sessionOpen;
    case "SESSION_CLOSE":
      return cost.widening.sessionClose;
    case "ROLLOVER":
      return cost.widening.rollover;
    case "MAINTENANCE_OR_HOLIDAY":
      return cost.widening.maintenanceOrHoliday;
    case "OUTSIDE_REGULAR_HOURS":
      return cost.widening.outsideRegularHours;
    default:
      return 1;
  }
}

/** Estimated cost per side in bps for a fill at instant `t` and `price`: fee + half-spread × widening + slippage. */
export function costBpsPerSideAt(cfg: MarketResearchConfig, instrument: string, t: number, price: number, barMs: number): number {
  const pip = pipSizeFor(cfg.id, instrument);
  const half = unitToBps(cfg.cost.spreadFull / 2, cfg.cost.unit, pip, price);
  const slip = unitToBps(cfg.cost.slippagePerSide, cfg.cost.unit, pip, price);
  return cfg.cost.feeBpsPerSide + half * wideningFor(cfg.cost, costWindowAt(cfg, t, barMs)) + slip;
}

/**
 * Whether a fill at instant `t` is allowed at all. FX/metals: only while the market is OPEN (never in the
 * weekend closure, the maintenance hour or a holiday). ETFs on intraday bars: regular trading hours of a NYSE
 * session only. Crypto and daily bars: always.
 */
export function isTradeableAt(cfg: MarketResearchConfig, t: number, barMs: number): boolean {
  if (barMs >= 86_400_000) return true;
  if (cfg.calendar === "FX_24_5") return fxSessionState(t) === "OPEN";
  if (cfg.calendar === "US_EQUITY") return costWindowAt(cfg, t, barMs) !== "OUTSIDE_REGULAR_HOURS";
  return true;
}

/**
 * The single per-side cost the walk-forward validator charges: the configured quantile of the per-bar cost over
 * the bars where a fill is allowed. It reads prices and times only (never returns), so it is performance-blind.
 */
export function validationCostBpsPerSide(cfg: MarketResearchConfig, instrument: string, bars: readonly ResearchBar[], barMs: number): number {
  const costs = bars.filter((b) => isTradeableAt(cfg, b.t, barMs)).map((b) => costBpsPerSideAt(cfg, instrument, b.t, b.open, barMs)).sort((a, b) => a - b);
  if (!costs.length) throw new Error("no tradeable bar to price the validation cost on");
  return costs[Math.min(costs.length - 1, Math.floor(cfg.cost.validationQuantile * costs.length))]!;
}

/** Bars per trading hour-based horizon: intraday by clock, daily by trading hours per day. Never below 1. */
export function horizonBars(cfg: MarketResearchConfig, tradingHours: number, barMs: number): number {
  if (barMs >= 86_400_000) return Math.max(1, Math.round(tradingHours / cfg.tradingHoursPerDay / (barMs / 86_400_000)));
  return Math.max(1, Math.round((tradingHours * 3_600_000) / barMs));
}

/** Bars per year for annualisation. */
export function periodsPerYearFor(cfg: MarketResearchConfig, barMs: number): number {
  if (barMs >= 86_400_000) return cfg.tradingDaysPerYear / (barMs / 86_400_000);
  return (cfg.tradingDaysPerYear * cfg.tradingHoursPerDay * 3_600_000) / barMs;
}

/** Simple average true range over the last `n` bars of `bars` (needs n + 1 bars; null otherwise). */
export function averageTrueRange(bars: readonly ResearchBar[], n: number): number | null {
  if (n < 1 || bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i += 1) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return sum / n;
}

/**
 * What the paper engine's universal 2% 5-minute threshold means on this dataset, as a multiple of the median
 * ATR-as-a-fraction-of-price, scaled to 5 minutes by √time. Diagnostic only: it explains why one fixed
 * percentage almost never fires on FX or ETFs; it changes nothing.
 */
export function legacyThresholdDiagnostic(cfg: MarketResearchConfig, bars: readonly ResearchBar[], barMs: number): { legacyPct: number; medianAtrPct: number | null; medianAtrPct5m: number | null; legacyInAtr5m: number | null } {
  const n = cfg.volatility.atrBars;
  const fracs: number[] = [];
  for (let i = n; i < bars.length; i += 1) {
    const a = averageTrueRange(bars.slice(i - n, i + 1), n);
    if (a !== null && bars[i]!.close > 0) fracs.push(a / bars[i]!.close);
  }
  fracs.sort((a, b) => a - b);
  const med = fracs.length ? fracs[Math.floor(fracs.length / 2)]! : null;
  const med5 = med === null ? null : med * Math.sqrt(300_000 / barMs);
  return { legacyPct: cfg.volatility.legacyM5ThresholdPct, medianAtrPct: med === null ? null : med * 100, medianAtrPct5m: med5 === null ? null : med5 * 100, legacyInAtr5m: med5 && med5 > 0 ? cfg.volatility.legacyM5ThresholdPct / 100 / med5 : null };
}
