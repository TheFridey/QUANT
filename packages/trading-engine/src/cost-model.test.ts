import { describe, expect, it } from "vitest";
import { costModelForInstrument } from "./cost-model.js";
import { quoteFill } from "./fill.js";

describe("market-specific cost models", () => {
  it("does not apply DEX impact to EURUSD or SPY", () => {
    const fx = costModelForInstrument("fx:EURUSD", {
      feeBps: "30",
      spreadBpsEstimate: "5",
      minLiquidityUsd: "1",
    });
    expect(fx.applyDexImpact).toBe(false);
    expect(Number(fx.feeBps)).toBeLessThan(30);

    const etf = costModelForInstrument("etf:SPY", {
      feeBps: "30",
      spreadBpsEstimate: "5",
      minLiquidityUsd: "1",
    });
    expect(etf.applyDexImpact).toBe(false);

    const quoted = quoteFill({
      side: "BUY",
      midPriceUsd: "1.085",
      quantity: "10000",
      liquidityUsd: "0",
      feeBps: "30",
      maxSlippageBps: "150",
      instrumentId: "fx:EURUSD",
    });
    expect(quoted.ok).toBe(true);
    if (quoted.ok) expect(Number(quoted.fill.impactBps)).toBe(0);
  });

  it("keeps DEX impact for Solana-style pairs", () => {
    const crypto = costModelForInstrument("somepair", {
      feeBps: "30",
      spreadBpsEstimate: "5",
      minLiquidityUsd: "25000",
    });
    expect(crypto.applyDexImpact).toBe(true);
  });
});
