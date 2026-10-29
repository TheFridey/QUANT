import { describe, expect, it } from "vitest";
import {
  advanceProtectionLeg,
  armLongShortOco,
  evaluateOco,
  markProtectionFailed,
  reduceProtectedQty,
} from "./protection-lifecycle.js";

describe("protection lifecycle (long/short)", () => {
  it("arms long and short with correct stop/target geometry", () => {
    const long = armLongShortOco({
      groupId: "L1",
      positionKey: "etf:SPY",
      direction: "LONG",
      qty: "10",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    expect(Number(long.legs.find((l) => l.kind === "STOP")!.triggerPriceUsd)).toBeCloseTo(97, 4);
    expect(Number(long.legs.find((l) => l.kind === "TAKE_PROFIT")!.triggerPriceUsd)).toBeCloseTo(105, 4);

    const short = armLongShortOco({
      groupId: "S1",
      positionKey: "fx:EURUSD",
      direction: "SHORT",
      qty: "10000",
      entryPriceUsd: "1.10000000",
      stopLossPct: "2",
      takeProfitPct: "3",
    });
    expect(Number(short.legs.find((l) => l.kind === "STOP")!.triggerPriceUsd)).toBeCloseTo(1.122, 4);
    expect(Number(short.legs.find((l) => l.kind === "TAKE_PROFIT")!.triggerPriceUsd)).toBeCloseTo(1.067, 4);
  });

  it("failed synthetic exit stays FAILED (unresolved) and is not permanently suppressed as success", () => {
    const group = armLongShortOco({
      groupId: "F1",
      positionKey: "p",
      direction: "LONG",
      qty: "1",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    const hit = evaluateOco(group, "96");
    expect(hit.triggered?.kind).toBe("STOP");
    const failed = markProtectionFailed(hit.group, hit.triggered!.id);
    expect(failed.legs.find((l) => l.kind === "STOP")?.status).toBe("FAILED");
    // Re-eval does not invent a fill — FAILED is terminal for this claim; retry uses ProtectionIntent.
    const again = evaluateOco(failed, "96");
    expect(again.raceSuppressed).toBe(true);
    expect(again.triggered).toBeNull();
  });

  it("partial close reduces remaining protected qty", () => {
    const group = armLongShortOco({
      groupId: "P1",
      positionKey: "p",
      direction: "LONG",
      qty: "10",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    const reduced = reduceProtectedQty(group, "4");
    expect(reduced.remainingQty).toBe("6.00000000");
    const closed = reduceProtectedQty(reduced, "6");
    expect(closed.remainingQty).toBe("0.00000000");
    expect(closed.legs.every((l) => l.status === "CANCELLED")).toBe(true);
  });

  it("advances TRIGGERED → SUBMITTED → FILLED", () => {
    const group = armLongShortOco({
      groupId: "A1",
      positionKey: "p",
      direction: "SHORT",
      qty: "2",
      entryPriceUsd: "50",
      stopLossPct: "2",
      takeProfitPct: "4",
    });
    const hit = evaluateOco(group, "52");
    expect(hit.triggered).not.toBeNull();
    const submitted = advanceProtectionLeg(hit.group, hit.triggered!.id, "SUBMITTED");
    expect(submitted.legs.find((l) => l.id === hit.triggered!.id)?.status).toBe("SUBMITTED");
    const filled = advanceProtectionLeg(submitted, hit.triggered!.id, "FILLED");
    expect(filled.remainingQty).toBe("0.00000000");
  });
});
