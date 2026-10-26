import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, mergeStrategy, parseStrategyConfig } from "./strategy.js";

describe("strategy config", () => {
  it("accepts the default paper configuration", () => {
    expect(parseStrategyConfig(DEFAULT_STRATEGY).startingBalanceUsd).toBe("100.00000000");
  });

  it("rejects private-key shaped extras and an unsafe starting balance", () => {
    expect(() => parseStrategyConfig({ ...DEFAULT_STRATEGY, privateKey: "secret" })).toThrow();
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { startingBalanceUsd: "0" })).toThrow();
    expect(mergeStrategy(DEFAULT_STRATEGY, { maxPositions: 2 }).maxPositions).toBe(2);
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { maxEntryM5ChangePct: "1" })).toThrow();
  });

  it("fills a missing anomaly cap from the default when an older config is loaded", () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_STRATEGY };
    delete legacy.maxEntryM5ChangePct;
    expect(parseStrategyConfig(legacy).maxEntryM5ChangePct).toBe("25");
  });
});
