import { d } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { quoteFill } from "./fill.js";
import { applyFill, cashFromLines, type BookState } from "./ledger.js";
import { maxEntryNotional, qtyForNotional } from "./size.js";

describe("paper fill", () => {
  it("prices a buy from the mid, pool participation, and fee", () => {
    const quoted = quoteFill({
      side: "BUY",
      midPriceUsd: "100",
      quantity: "1",
      liquidityUsd: "1000000",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.fill.priceUsd).toBe("100.01000000");
    expect(quoted.fill.notionalUsd).toBe("100.01000000");
    expect(quoted.fill.feeUsd).toBe("0.30003000");
    expect(quoted.fill.slippageBps).toBe("1.0000");
  });

  it("rejects participation that would slip through the configured maximum", () => {
    const quoted = quoteFill({
      side: "BUY",
      midPriceUsd: "100",
      quantity: "20",
      liquidityUsd: "10000",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.reason).toBe("SLIPPAGE_LIMIT");
  });

  it("keeps cash equal to the ledger through a round trip", () => {
    const buy = quoteFill({
      side: "BUY",
      midPriceUsd: "100",
      quantity: "1",
      liquidityUsd: "1000000",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    if (!buy.ok) throw new Error("buy quote");
    const opened = applyFill(
      { cashUsd: "1000.00000000", positions: [] },
      { pairAddress: "PAIR", baseSymbol: "SOL", side: "BUY", fill: buy.fill },
    );
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.state.cashUsd).toBe(cashFromLines("1000.00000000", opened.lines));
    expect(opened.state.positions[0]?.baseQty).toBe("1.00000000");

    const sell = quoteFill({
      side: "SELL",
      midPriceUsd: "100",
      quantity: "1",
      liquidityUsd: "1000000",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    if (!sell.ok) throw new Error("sell quote");
    const closed = applyFill(opened.state, { pairAddress: "PAIR", baseSymbol: "SOL", side: "SELL", fill: sell.fill });
    if (!closed.ok) throw new Error(closed.reason);
    const lines = [...opened.lines, ...closed.lines];
    expect(closed.state.cashUsd).toBe(cashFromLines("1000.00000000", lines));
    expect(closed.state.positions[0]?.baseQty).toBe("0.00000000");
    expect(d(closed.state.cashUsd).lt("1000")).toBe(true);
  });

  it("caps entry notional by equity percentage and cash after fees", () => {
    const cap = maxEntryNotional({
      cashUsd: "100.00000000",
      equityUsd: "100.00000000",
      liquidityUsd: "1000000",
      maxPositionPctEquity: "25",
      maxParticipationPctLiquidity: "1",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    expect(cap).toBe("25.00000000");
    expect(qtyForNotional(cap, "100")).toBe("0.25000000");
  });

  it("does not sell more than the position or spend cash it does not have", () => {
    const state: BookState = {
      cashUsd: "1.00000000",
      positions: [
        {
          pairAddress: "PAIR",
          baseSymbol: "SOL",
          baseQty: "0.10000000",
          avgCostUsd: "10.00000000",
          realizedPnlUsd: "0.00000000",
        },
      ],
    };
    const quoted = quoteFill({
      side: "SELL",
      midPriceUsd: "10",
      quantity: "1",
      liquidityUsd: "1000000",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    if (!quoted.ok) throw new Error("quote");
    expect(applyFill(state, { pairAddress: "PAIR", baseSymbol: "SOL", side: "SELL", fill: quoted.fill }).ok).toBe(false);
  });
});
