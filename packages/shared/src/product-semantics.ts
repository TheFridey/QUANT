import { d } from "./money.js";
import { findInstrument, type AssetClass, type Instrument } from "./instruments.js";

/**
 * Product economics for sizing / PnL / costs.
 * Incomplete commodity futures semantics stay honest: executionSupported=false.
 */
export type ProductSemantics = {
  instrumentId: string;
  assetClass: AssetClass;
  /** Quote / PnL currency (ISO). */
  currency: string;
  /**
   * Contract / unit multiplier applied to (price * qty) for notional.
   * Paper spot proxies use 1. Futures-style contracts need a real multiplier.
   */
  multiplier: string;
  /** Minimum price increment. */
  tickSize: string;
  /** Minimum tradeable size in contract/units. */
  lotSize: string;
  /** Half-spread estimate bps for paper costs. */
  spreadBpsEstimate: string;
  /** Fee bps. */
  feeBps: string;
  /**
   * When false, paper/runtime must refuse sizing as PRODUCT_SEMANTICS_UNSUPPORTED
   * rather than inventing futures economics.
   */
  executionSupported: boolean;
  unsupportedReason: string | null;
  notes: string;
};

const COMMODITY_PAPER: Record<string, Omit<ProductSemantics, "instrumentId" | "assetClass" | "tickSize" | "lotSize">> = {
  "commodity:XAUUSD": {
    currency: "USD",
    multiplier: "1",
    spreadBpsEstimate: "5",
    feeBps: "2",
    // Spot gold USD paper proxy — multiplier 1 is honest for proxy units, not XAU futures.
    executionSupported: true,
    unsupportedReason: null,
    notes: "Paper gold/USD spot proxy. Not exchange-cleared XAU futures; no contract multiplier.",
  },
  "commodity:WTI": {
    currency: "USD",
    multiplier: "1",
    spreadBpsEstimate: "8",
    feeBps: "3",
    // Without CL contract size (e.g. 1000 barrels) we only allow paper proxy units.
    executionSupported: true,
    unsupportedReason: null,
    notes:
      "Paper WTI spot proxy units (multiplier=1). CL futures contract multiplier is NOT modelled — do not treat fills as exchange futures.",
  },
};

/**
 * Resolve product semantics. Unknown / incomplete futures-style products return
 * executionSupported=false so callers can refuse without inventing economics.
 */
export function productSemanticsFor(instrumentIdOrPair: string): ProductSemantics | null {
  const instrument = findInstrument(instrumentIdOrPair);
  if (!instrument) {
    if (instrumentIdOrPair.startsWith("commodity:")) {
      return unsupportedCommodity(instrumentIdOrPair, "Unknown commodity instrument — no registry row");
    }
    return null;
  }
  if (instrument.assetClass === "COMMODITY_PROXY") {
    const known = COMMODITY_PAPER[instrument.id];
    if (!known) {
      return unsupportedCommodity(instrument.id, "Commodity proxy lacks product semantics table entry");
    }
    return {
      instrumentId: instrument.id,
      assetClass: instrument.assetClass,
      tickSize: instrument.tickSize,
      lotSize: instrument.lotSize,
      ...known,
    };
  }
  if (instrument.assetClass === "EQUITY_INDEX") {
    return {
      instrumentId: instrument.id,
      assetClass: instrument.assetClass,
      currency: instrument.quote,
      multiplier: "1",
      tickSize: instrument.tickSize,
      lotSize: instrument.lotSize,
      spreadBpsEstimate: "0",
      feeBps: "0",
      executionSupported: false,
      unsupportedReason: "Index levels are RESEARCH_ONLY / NO_EXECUTION",
      notes: instrument.notes ?? "Index — no paper fills",
    };
  }
  return {
    instrumentId: instrument.id,
    assetClass: instrument.assetClass,
    currency: instrument.quote,
    multiplier: "1",
    tickSize: instrument.tickSize,
    lotSize: instrument.lotSize,
    spreadBpsEstimate: instrument.assetClass === "FX_SPOT" ? "1.5" : instrument.assetClass === "EQUITY_ETF_PROXY" ? "2" : "0",
    feeBps: instrument.assetClass === "FX_SPOT" ? "0.5" : instrument.assetClass === "EQUITY_ETF_PROXY" ? "1" : "0",
    executionSupported: !instrument.executionCapabilities.includes("NO_EXECUTION") &&
      !instrument.executionCapabilities.includes("RESEARCH_ONLY"),
    unsupportedReason: instrument.executionCapabilities.includes("NO_EXECUTION")
      ? "NO_EXECUTION"
      : instrument.executionCapabilities.includes("RESEARCH_ONLY")
        ? "RESEARCH_ONLY"
        : null,
    notes: instrument.notes ?? "",
  };
}

function unsupportedCommodity(id: string, reason: string): ProductSemantics {
  return {
    instrumentId: id,
    assetClass: "COMMODITY_PROXY",
    currency: "USD",
    multiplier: "1",
    tickSize: "0.01",
    lotSize: "1",
    spreadBpsEstimate: "0",
    feeBps: "0",
    executionSupported: false,
    unsupportedReason: reason,
    notes: reason,
  };
}

/** Notional in quote currency: price * qty * multiplier. */
export function notionalFromProduct(input: {
  price: string;
  qty: string;
  semantics: ProductSemantics;
}): { ok: true; notional: string } | { ok: false; reason: string } {
  if (!input.semantics.executionSupported) {
    return {
      ok: false,
      reason: input.semantics.unsupportedReason ?? "PRODUCT_SEMANTICS_UNSUPPORTED",
    };
  }
  const notional = d(input.price).mul(d(input.qty)).mul(d(input.semantics.multiplier));
  if (notional.lte(0)) return { ok: false, reason: "NON_POSITIVE_NOTIONAL" };
  return { ok: true, notional: notional.toFixed(8) };
}

export function assertCommoditySemanticsHonest(instrument: Instrument): {
  ok: boolean;
  reason?: string;
  semantics: ProductSemantics | null;
} {
  const semantics = productSemanticsFor(instrument.id);
  if (!semantics) return { ok: false, reason: "NO_SEMANTICS", semantics: null };
  if (!semantics.executionSupported) {
    return { ok: false, reason: semantics.unsupportedReason ?? "PRODUCT_SEMANTICS_UNSUPPORTED", semantics };
  }
  return { ok: true, semantics };
}
