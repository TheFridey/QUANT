import type { AssetClass } from "@odin/shared";
import { findInstrument, productSemanticsFor } from "@odin/shared";

export type MarketCostModel = {
  /** Half-spread estimate in bps applied to mid. */
  spreadBpsEstimate: string;
  /** Fee in bps. */
  feeBps: string;
  /**
   * When false, skip DEX-style participation impact (qty*mid/liquidity).
   * FX/ETF paper uses spread+fee; crypto DEX keeps impact.
   */
  applyDexImpact: boolean;
  /** Synthetic liquidity floor used only when applyDexImpact is true. */
  minLiquidityUsd: string;
  /** Quote currency for costs / PnL. */
  currency?: string;
  /** Contract / unit multiplier (1 for spot proxies). */
  multiplier?: string;
  /** False when product economics incomplete — caller must refuse inventing fills. */
  executionSupported?: boolean;
  unsupportedReason?: string | null;
};

/**
 * Market-specific paper cost models — never apply Solana DEX impact to EURUSD/SPY.
 * Commodity proxies pull spread/fee/currency/multiplier from product semantics.
 */
export function costModelForInstrument(
  instrumentIdOrPair: string,
  defaults: { feeBps: string; spreadBpsEstimate: string; minLiquidityUsd: string },
): MarketCostModel {
  const semantics = productSemanticsFor(instrumentIdOrPair);
  if (semantics) {
    if (semantics.assetClass === "COMMODITY_PROXY" || semantics.assetClass === "FX_SPOT" || semantics.assetClass === "EQUITY_ETF_PROXY") {
      return {
        spreadBpsEstimate: semantics.spreadBpsEstimate || defaults.spreadBpsEstimate,
        feeBps: semantics.feeBps || defaults.feeBps,
        applyDexImpact: false,
        minLiquidityUsd: "1000000000",
        currency: semantics.currency,
        multiplier: semantics.multiplier,
        executionSupported: semantics.executionSupported,
        unsupportedReason: semantics.unsupportedReason,
      };
    }
    if (!semantics.executionSupported) {
      return {
        spreadBpsEstimate: "0",
        feeBps: "0",
        applyDexImpact: false,
        minLiquidityUsd: "0",
        currency: semantics.currency,
        multiplier: semantics.multiplier,
        executionSupported: false,
        unsupportedReason: semantics.unsupportedReason,
      };
    }
  }
  const instrument = findInstrument(instrumentIdOrPair);
  const assetClass: AssetClass | null = instrument?.assetClass ?? inferClass(instrumentIdOrPair);
  if (assetClass === "FX_SPOT") {
    return {
      spreadBpsEstimate: "1.5",
      feeBps: "0.5",
      applyDexImpact: false,
      minLiquidityUsd: "1000000000",
      currency: "USD",
      multiplier: "1",
      executionSupported: true,
    };
  }
  if (assetClass === "EQUITY_ETF_PROXY") {
    return {
      spreadBpsEstimate: "2",
      feeBps: "1",
      applyDexImpact: false,
      minLiquidityUsd: "1000000000",
      currency: "USD",
      multiplier: "1",
      executionSupported: true,
    };
  }
  if (assetClass === "COMMODITY_PROXY") {
    return {
      spreadBpsEstimate: "5",
      feeBps: "2",
      applyDexImpact: false,
      minLiquidityUsd: "1000000000",
      currency: "USD",
      multiplier: "1",
      executionSupported: true,
    };
  }
  return {
    spreadBpsEstimate: defaults.spreadBpsEstimate,
    feeBps: defaults.feeBps,
    applyDexImpact: true,
    minLiquidityUsd: defaults.minLiquidityUsd,
    currency: "USD",
    multiplier: "1",
    executionSupported: true,
  };
}

function inferClass(id: string): AssetClass | null {
  if (id.startsWith("fx:")) return "FX_SPOT";
  if (id.startsWith("etf:")) return "EQUITY_ETF_PROXY";
  if (id.startsWith("commodity:")) return "COMMODITY_PROXY";
  if (id.startsWith("index:")) return "EQUITY_INDEX";
  return null;
}
