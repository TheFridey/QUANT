import { describe, expect, it } from "vitest";
import { applyBreakeven, armOco, evaluateOco, updateTrailing } from "./protection.js";

describe("OCO protection", () => {
  it("triggers stop and cancels take-profit; second eval is race-suppressed (long)", () => {
    const group = armOco({
      groupId: "g1",
      positionKey: "pair:A",
      direction: "LONG",
      protectedQty: "10",
      stopPriceUsd: "95.00000000",
      takeProfitPriceUsd: "110.00000000",
    });
    const first = evaluateOco(group, "94.00000000");
    expect(first.triggered?.kind).toBe("STOP");
    expect(first.cancelled.map((l) => l.kind)).toEqual(["TAKE_PROFIT"]);
    const second = evaluateOco(first.group, "120.00000000");
    expect(second.raceSuppressed).toBe(true);
    expect(second.triggered).toBeNull();
  });

  it("prefers STOP over TAKE_PROFIT when both would hit on a gap (long)", () => {
    const group = armOco({
      groupId: "g2",
      positionKey: "pair:B",
      direction: "LONG",
      protectedQty: "5",
      stopPriceUsd: "100.00000000",
      takeProfitPriceUsd: "100.00000000",
    });
    const result = evaluateOco(group, "100.00000000");
    expect(result.triggered?.kind).toBe("STOP");
  });

  it("short: stop triggers above entry, take-profit below", () => {
    const group = armOco({
      groupId: "g3",
      positionKey: "fx:EURUSD",
      direction: "SHORT",
      protectedQty: "10000",
      stopPriceUsd: "1.10000000",
      takeProfitPriceUsd: "1.05000000",
    });
    const stopHit = evaluateOco(group, "1.10500000");
    expect(stopHit.triggered?.kind).toBe("STOP");

    const group2 = armOco({
      groupId: "g4",
      positionKey: "fx:EURUSD",
      direction: "SHORT",
      protectedQty: "10000",
      stopPriceUsd: "1.10000000",
      takeProfitPriceUsd: "1.05000000",
    });
    const tpHit = evaluateOco(group2, "1.04000000");
    expect(tpHit.triggered?.kind).toBe("TAKE_PROFIT");
  });

  it("breakeven arms for long and short", () => {
    const long = applyBreakeven({
      direction: "LONG",
      entryPriceUsd: "100",
      markUsd: "103",
      activateAtPct: "2",
      bufferPct: "0.1",
    });
    expect(long.armed).toBe(true);
    expect(Number(long.stopPriceUsd)).toBeCloseTo(100.1, 4);

    const short = applyBreakeven({
      direction: "SHORT",
      entryPriceUsd: "100",
      markUsd: "97",
      activateAtPct: "2",
      bufferPct: "0.1",
    });
    expect(short.armed).toBe(true);
    expect(Number(short.stopPriceUsd)).toBeCloseTo(99.9, 4);
  });

  it("trailing updates peak for long and trough for short", () => {
    const long = updateTrailing({
      direction: "LONG",
      markUsd: "110",
      extremePriceUsd: "105",
      trailPct: "2",
    });
    expect(long.extremePriceUsd).toBe("110.00000000");
    expect(Number(long.stopPriceUsd)).toBeCloseTo(107.8, 4);

    const short = updateTrailing({
      direction: "SHORT",
      markUsd: "90",
      extremePriceUsd: "95",
      trailPct: "2",
    });
    expect(short.extremePriceUsd).toBe("90.00000000");
    expect(Number(short.stopPriceUsd)).toBeCloseTo(91.8, 4);
  });
});
