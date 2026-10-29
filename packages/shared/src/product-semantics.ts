import { d } from "./money.js";
import {
  SEED_INSTRUMENTS,
  findInstrument,
  type AssetClass,
  type Instrument,
  type SessionKind,
} from "./instruments.js";

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
  /** Human/ops product label — never invents futures contract size. */
  productLabel: string;
  /** Session kind from registry (for ops / session gate). */
  session: SessionKind | null;
  /**
   * FX pip size when assetClass=FX_SPOT (e.g. 0.0001 for most pairs, 0.01 for JPY).
   * Null for non-FX.
   */
  pipSize: string | null;
  /** Paper product family for UX / cost routing. */
  paperFamily: "CRYPTO_SPOT" | "FX_SPOT" | "ETF_PROXY" | "COMMODITY_PROXY" | "INDEX_RESEARCH" | "UNSUPPORTED";
};

const COMMODITY_PAPER: Record<
  string,
  Omit<ProductSemantics, "instrumentId" | "assetClass" | "tickSize" | "lotSize" | "session" | "productLabel" | "pipSize" | "paperFamily">
> = {
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

function fxPipSize(instrument: Instrument): string {
  // JPY quotes conventionally use 0.01 pip; most majors use 0.0001.
  if (instrument.quote === "JPY" || instrument.base === "JPY") return "0.01";
  return "0.0001";
}

function paperFamilyFor(assetClass: AssetClass, executionSupported: boolean): ProductSemantics["paperFamily"] {
  if (!executionSupported && assetClass === "EQUITY_INDEX") return "INDEX_RESEARCH";
  if (!executionSupported) return "UNSUPPORTED";
  switch (assetClass) {
    case "SPOT_CRYPTO_PAIR":
      return "CRYPTO_SPOT";
    case "FX_SPOT":
      return "FX_SPOT";
    case "EQUITY_ETF_PROXY":
      return "ETF_PROXY";
    case "COMMODITY_PROXY":
      return "COMMODITY_PROXY";
    default:
      return "UNSUPPORTED";
  }
}

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
      productLabel: `${instrument.symbol} paper commodity proxy (not futures)`,
      session: instrument.session,
      pipSize: null,
      paperFamily: "COMMODITY_PROXY",
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
      productLabel: `${instrument.symbol} index level (research-only)`,
      session: instrument.session,
      pipSize: null,
      paperFamily: "INDEX_RESEARCH",
    };
  }
  if (instrument.assetClass === "FUTURES_PROXY") {
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
      unsupportedReason: "FUTURES_MULTIPLIER_UNSUPPORTED",
      notes: "Futures contract multiplier not modelled — refuse rather than invent economics",
      productLabel: `${instrument.symbol} futures proxy (unsupported)`,
      session: instrument.session,
      pipSize: null,
      paperFamily: "UNSUPPORTED",
    };
  }
  const executionSupported =
    !instrument.executionCapabilities.includes("NO_EXECUTION") &&
    !instrument.executionCapabilities.includes("RESEARCH_ONLY");
  const isFx = instrument.assetClass === "FX_SPOT";
  const isEtf = instrument.assetClass === "EQUITY_ETF_PROXY";
  return {
    instrumentId: instrument.id,
    assetClass: instrument.assetClass,
    currency: instrument.quote,
    multiplier: "1",
    tickSize: instrument.tickSize,
    lotSize: instrument.lotSize,
    spreadBpsEstimate: isFx ? "1.5" : isEtf ? "2" : "0",
    feeBps: isFx ? "0.5" : isEtf ? "1" : "0",
    executionSupported,
    unsupportedReason: instrument.executionCapabilities.includes("NO_EXECUTION")
      ? "NO_EXECUTION"
      : instrument.executionCapabilities.includes("RESEARCH_ONLY")
        ? "RESEARCH_ONLY"
        : null,
    notes: instrument.notes ?? "",
    productLabel: isFx
      ? `${instrument.symbol} FX spot paper (${fxPipSize(instrument)} pip)`
      : isEtf
        ? `${instrument.symbol} equity ETF proxy (cash session)`
        : `${instrument.symbol} ${instrument.assetClass}`,
    session: instrument.session,
    pipSize: isFx ? fxPipSize(instrument) : null,
    paperFamily: paperFamilyFor(instrument.assetClass, executionSupported),
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
    productLabel: `${id} unsupported commodity`,
    session: null,
    pipSize: null,
    paperFamily: "UNSUPPORTED",
  };
}

/** Ops-facing product label for seed instruments (never invents CL futures size). */
export function productLabelFor(instrumentIdOrPair: string): string | null {
  return productSemanticsFor(instrumentIdOrPair)?.productLabel ?? null;
}

/**
 * Honest product catalog roll-up for registry instruments (A09).
 * FUTURES_PROXY / unknown futures never invent contract multipliers.
 */
export type ProductCatalogRow = {
  instrumentId: string;
  paperFamily: ProductSemantics["paperFamily"];
  executionSupported: boolean;
  productLabel: string;
  session: SessionKind | null;
  pipSize: string | null;
  /** True when quote is non-USD and risk accounting must convert before USD caps. */
  quoteConversionRequired: boolean;
  refusesFuturesMultiplier: boolean;
};

export function productCatalogForSeeds(): ProductCatalogRow[] {
  return SEED_INSTRUMENTS.map((instrument) => {
    const semantics = productSemanticsFor(instrument.id);
    const notes = semantics?.notes.toLowerCase() ?? "";
    const refusesFutures =
      instrument.assetClass === "FUTURES_PROXY" ||
      (instrument.id.startsWith("commodity:") && notes.includes("futures"));
    return {
      instrumentId: instrument.id,
      paperFamily: semantics?.paperFamily ?? "UNSUPPORTED",
      executionSupported: semantics?.executionSupported ?? false,
      productLabel: semantics?.productLabel ?? instrument.symbol,
      session: semantics?.session ?? instrument.session,
      pipSize: semantics?.pipSize ?? null,
      quoteConversionRequired: instrument.quote !== "USD",
      refusesFuturesMultiplier: refusesFutures,
    };
  });
}

/** Refuse sizing for futures-style ids that lack registry/multiplier support. */
export function refuseUnsupportedFutures(instrumentId: string): {
  refused: boolean;
  reason: string | null;
} {
  if (instrumentId.startsWith("futures:")) {
    return { refused: true, reason: "FUTURES_MULTIPLIER_UNSUPPORTED" };
  }
  const semantics = productSemanticsFor(instrumentId);
  if (!semantics) {
    if (instrumentId.startsWith("commodity:") || instrumentId.startsWith("futures:")) {
      return { refused: true, reason: "PRODUCT_SEMANTICS_UNSUPPORTED" };
    }
    return { refused: false, reason: null };
  }
  if (semantics.assetClass === "FUTURES_PROXY") {
    return { refused: true, reason: semantics.unsupportedReason ?? "FUTURES_MULTIPLIER_UNSUPPORTED" };
  }
  if (!semantics.executionSupported && semantics.paperFamily === "UNSUPPORTED") {
    return { refused: true, reason: semantics.unsupportedReason ?? "PRODUCT_SEMANTICS_UNSUPPORTED" };
  }
  // Paper WTI/XAU are proxies (multiplier=1) — not exchange futures; do not refuse the proxy path.
  return { refused: false, reason: null };
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
