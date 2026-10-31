import type { AssetClass, OrderSide } from "@odin/shared";
import { Decimal, d, findInstrument, productSemanticsFor } from "@odin/shared";

/**
 * DEX price impact in bps of mid, for the average fill price (audit C3 model).
 *
 * DexScreener `liquidityUsd` is the whole pool (both sides), so the per-side reserve is
 * R = liquidityUsd / 2. In a constant-product pool, trading notional N at mid moves the
 * average price by N / R for a BUY and N / (R + N) for a SELL. The former linear model
 * (N / liquidityUsd) is kept as a floor, so this never estimates less impact than before.
 */
export function dexImpactBps(side: OrderSide, notionalUsd: Decimal, liquidityUsd: Decimal): Decimal {
  if (liquidityUsd.lte(0)) throw new Error("dexImpactBps requires positive liquidity");
  const reserve = liquidityUsd.div(2);
  const constantProduct = side === "BUY" ? notionalUsd.div(reserve) : notionalUsd.div(reserve.plus(notionalUsd));
  const linear = notionalUsd.div(liquidityUsd);
  return Decimal.max(constantProduct, linear).mul(10000);
}

/** Largest BUY notional whose impact stays within `capBps`: N / R ≤ cap with R = liquidity / 2. */
export function maxBuyNotionalWithinImpact(capBps: Decimal, liquidityUsd: Decimal): Decimal {
  if (capBps.lte(0) || liquidityUsd.lte(0)) return d("0");
  return liquidityUsd.div(2).mul(capBps).div(10000);
}

/**
 * Largest SELL notional whose impact stays within `capBps` (inverse of dexImpactBps for SELL).
 * Both the constant-product and the linear floor must be within the cap.
 */
export function maxSellNotionalWithinImpact(capBps: Decimal, liquidityUsd: Decimal): Decimal {
  const cap = capBps.div(10000);
  if (cap.lte(0) || liquidityUsd.lte(0)) return d("0");
  const reserve = liquidityUsd.div(2);
  const linearLimit = cap.mul(liquidityUsd);
  const constantProductLimit = cap.gte(1) ? linearLimit : reserve.mul(cap).div(new Decimal(1).minus(cap));
  return Decimal.min(linearLimit, constantProductLimit);
}

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
