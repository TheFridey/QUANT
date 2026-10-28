import type { AssetClass } from "@odin/shared";
import { findInstrument } from "@odin/shared";

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
};

/**
 * Market-specific paper cost models — never apply Solana DEX impact to EURUSD/SPY.
 */
export function costModelForInstrument(
  instrumentIdOrPair: string,
  defaults: { feeBps: string; spreadBpsEstimate: string; minLiquidityUsd: string },
): MarketCostModel {
  const instrument = findInstrument(instrumentIdOrPair);
  const assetClass: AssetClass | null = instrument?.assetClass ?? inferClass(instrumentIdOrPair);
  if (assetClass === "FX_SPOT") {
    return {
      spreadBpsEstimate: "1.5",
      feeBps: "0.5",
      applyDexImpact: false,
      minLiquidityUsd: "1000000000",
    };
  }
  if (assetClass === "EQUITY_ETF_PROXY") {
    return {
      spreadBpsEstimate: "2",
      feeBps: "1",
      applyDexImpact: false,
      minLiquidityUsd: "1000000000",
    };
  }
  if (assetClass === "COMMODITY_PROXY") {
    return {
      spreadBpsEstimate: "5",
      feeBps: "2",
      applyDexImpact: false,
      minLiquidityUsd: "1000000000",
    };
  }
  return {
    spreadBpsEstimate: defaults.spreadBpsEstimate,
    feeBps: defaults.feeBps,
    applyDexImpact: true,
    minLiquidityUsd: defaults.minLiquidityUsd,
  };
}

function inferClass(id: string): AssetClass | null {
  if (id.startsWith("fx:")) return "FX_SPOT";
  if (id.startsWith("etf:")) return "EQUITY_ETF_PROXY";
  if (id.startsWith("commodity:")) return "COMMODITY_PROXY";
  if (id.startsWith("index:")) return "EQUITY_INDEX";
  return null;
}
