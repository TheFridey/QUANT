import { describe, expect, it } from "vitest";
import { applyBreakeven, armOco, evaluateOco } from "./protection.js";

describe("OCO protection", () => {
  it("cancels the sibling when stop triggers and suppresses a racing target", () => {
    const group = armOco({
      groupId: "oco1",
      positionKey: "primary:PAIR",
      stopPriceUsd: "95.00000000",
      takeProfitPriceUsd: "110.00000000",
    });
    const first = evaluateOco(group, "94.00000000");
    expect(first.triggered?.kind).toBe("STOP");
    expect(first.cancelled).toHaveLength(1);
    expect(first.cancelled[0]?.kind).toBe("TAKE_PROFIT");
    const second = evaluateOco(first.group, "120.00000000");
    expect(second.triggered).toBeNull();
    expect(second.raceSuppressed).toBe(true);
  });

  it("on a gap through both levels, prefers STOP (risk-reducing) deterministically", () => {
    const group = armOco({
      groupId: "oco2",
      positionKey: "primary:PAIR",
      stopPriceUsd: "100.00000000",
      takeProfitPriceUsd: "100.00000000",
    });
    // Mark equals both triggers — STOP wins.
    const result = evaluateOco(group, "100.00000000");
    expect(result.triggered?.kind).toBe("STOP");
    expect(result.cancelled.some((leg) => leg.kind === "TAKE_PROFIT")).toBe(true);
  });

  it("arms breakeven only after activate threshold", () => {
    expect(applyBreakeven({ entryPriceUsd: "100", markUsd: "101", activateAtPct: "2" }).armed).toBe(false);
    const moved = applyBreakeven({ entryPriceUsd: "100", markUsd: "103", activateAtPct: "2", bufferPct: "0.1" });
    expect(moved.armed).toBe(true);
    expect(Number(moved.stopPriceUsd)).toBeCloseTo(100.1, 5);
  });
});
