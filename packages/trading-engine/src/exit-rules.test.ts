import { describe, expect, it } from "vitest";
import { evaluateExitRules, protectionPricesFromEntry } from "./exit-rules.js";

const baseConfig = {
  stopLossPct: "3",
  takeProfitPct: "5",
  trailingStopPct: "2" as string | null,
  maxHoldingMs: 10_000 as number | null,
  exitM5ChangePct: "-3",
};

describe("shared exit rules", () => {
  it("short stop/target geometry", () => {
    const prices = protectionPricesFromEntry({
      direction: "SHORT",
      entryPriceUsd: "100",
      stopLossPct: "2",
      takeProfitPct: "4",
    });
    expect(Number(prices.stopPriceUsd)).toBeCloseTo(102, 4);
    expect(Number(prices.takeProfitPriceUsd)).toBeCloseTo(96, 4);
  });

  it("prefers stop before take-profit when both could apply sequentially", () => {
    const stop = evaluateExitRules({
      markUsd: "96",
      markAt: "2026-10-28T12:00:00.000Z",
      position: {
        direction: "LONG",
        avgCostUsd: "100",
        openedAt: "2026-10-28T11:59:00.000Z",
        extremeMarkUsd: "100",
        qty: "1",
      },
      config: baseConfig,
    });
    expect(stop?.reasonCodes).toContain("STOP_LOSS");
  });
});
