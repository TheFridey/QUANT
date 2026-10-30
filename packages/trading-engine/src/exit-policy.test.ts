import { d } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { dexImpactBps, maxBuyNotionalWithinImpact, maxSellNotionalWithinImpact } from "./cost-model.js";
import { quoteFill } from "./fill.js";
import { maxEntryNotional } from "./size.js";

/** Audit C3: protective exits were rejected by entry slippage caps, and DEX impact was understated. */

const caps = { feeBps: "30", maxSlippageBps: "150", maxPriceImpactBps: "150", spreadBpsEstimate: "0" };

describe("DEX impact model (B2)", () => {
  it("matches constant-product impact on the per-side reserve", () => {
    // R = 100k / 2 = 50k. BUY N=1k: N/R = 2% = 200 bps. SELL N=1k: N/(R+N) = 1/51 ≈ 196.08 bps.
    expect(dexImpactBps("BUY", d("1000"), d("100000")).toFixed(4)).toBe("200.0000");
    expect(dexImpactBps("SELL", d("1000"), d("100000")).toFixed(4)).toBe("196.0784");
  });

  it("is never below the former linear notional / liquidity estimate", () => {
    for (const notional of ["10", "1000", "50000", "200000"]) {
      const linear = d(notional).div("100000").mul(10000);
      expect(dexImpactBps("BUY", d(notional), d("100000")).gte(linear)).toBe(true);
      expect(dexImpactBps("SELL", d(notional), d("100000")).gte(linear)).toBe(true);
    }
  });

  it("inverts exactly at the cap for sizing", () => {
    const buy = maxBuyNotionalWithinImpact(d("150"), d("100000"));
    expect(dexImpactBps("BUY", buy, d("100000")).toFixed(6)).toBe("150.000000");
    const sell = maxSellNotionalWithinImpact(d("1000"), d("100000"));
    expect(dexImpactBps("SELL", sell, d("100000")).lte(d("1000.000001"))).toBe(true);
  });

  it("sizes entries so a max-size BUY passes the impact cap it is later quoted against", () => {
    const notional = maxEntryNotional({
      cashUsd: "1000000",
      equityUsd: "1000000",
      liquidityUsd: "100000",
      maxPositionPctEquity: "100",
      maxParticipationPctLiquidity: "5",
      feeBps: "30",
      maxSlippageBps: "150",
      maxPriceImpactBps: "150",
    });
    expect(notional).toBe("750.00000000");
    const quoted = quoteFill({ side: "BUY", midPriceUsd: "1", quantity: notional, liquidityUsd: "100000", ...caps });
    expect(quoted.ok).toBe(true);
  });
});

describe("exit execution policy (B1)", () => {
  // Audit probe: 1,000 units at $1. Entry sized at 1% of $100k liquidity; liquidity then halves to $50k.
  const exitPolicy = { maxExitImpactBps: "1000" };

  it("fills a stop-loss exit at the worse modelled price after liquidity halves", () => {
    const quoted = quoteFill({ side: "SELL", midPriceUsd: "1", quantity: "1000", liquidityUsd: "50000", ...caps, exitPolicy });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    // R = 25k, N = 1k: N/(R+N) = 1/26 ≈ 384.6 bps — above the 150 bps entry caps, within the exit cap.
    expect(d(quoted.fill.impactBps).gt(150)).toBe(true);
    expect(quoted.fill.qty).toBe("1000.00000000");
    expect(quoted.fill.remainderQty).toBe("0.00000000");
    expect(d(quoted.fill.priceUsd).lt(1)).toBe(true);
    expect(d(quoted.fill.slippageBps).gte(d(quoted.fill.impactBps))).toBe(true);
  });

  it("still rejects the same exit without the exit policy (the audit failure)", () => {
    const quoted = quoteFill({ side: "SELL", midPriceUsd: "1", quantity: "1000", liquidityUsd: "50000", ...caps });
    expect(quoted).toEqual({ ok: false, reason: "SLIPPAGE_LIMIT" });
  });

  it("rejects a BUY at the same impact even if an exit policy is passed", () => {
    const quoted = quoteFill({ side: "BUY", midPriceUsd: "1", quantity: "1000", liquidityUsd: "50000", ...caps, exitPolicy });
    expect(quoted.ok).toBe(false);
  });

  it("fills up to maxExitImpactBps and reports the remainder when the exit is larger", () => {
    const quoted = quoteFill({ side: "SELL", midPriceUsd: "1", quantity: "20000", liquidityUsd: "50000", ...caps, exitPolicy });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(d(quoted.fill.impactBps).lte(d("1000.0001"))).toBe(true);
    expect(d(quoted.fill.qty).gt(0)).toBe(true);
    expect(d(quoted.fill.qty).plus(d(quoted.fill.remainderQty)).toFixed(8)).toBe("20000.00000000");
    expect(d(quoted.fill.remainderQty).gt(0)).toBe(true);
  });

  it("closes the remainder over successive retries", () => {
    let remaining = d("20000");
    let rounds = 0;
    while (remaining.gt(0) && rounds < 20) {
      const quoted = quoteFill({ side: "SELL", midPriceUsd: "1", quantity: remaining.toFixed(8), liquidityUsd: "50000", ...caps, exitPolicy });
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) break;
      remaining = d(quoted.fill.remainderQty);
      rounds += 1;
    }
    expect(remaining.toFixed(8)).toBe("0.00000000");
    expect(rounds).toBeGreaterThan(1);
  });
});
