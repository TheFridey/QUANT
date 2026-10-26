import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, mergeStrategy, parseStrategyConfig } from "./strategy.js";

describe("strategy config", () => {
  it("accepts the default paper configuration", () => {
    expect(parseStrategyConfig(DEFAULT_STRATEGY).startingBalanceUsd).toBe("100.00000000");
    expect(DEFAULT_STRATEGY.maxPositions).toBe(4);
    expect(DEFAULT_STRATEGY.maxPositionPctEquity).toBe("5");
    expect(DEFAULT_STRATEGY.maxDailyLossPct).toBe("3");
    expect(DEFAULT_STRATEGY.maxRiskPerTradePct).toBe("0.5");
    expect(DEFAULT_STRATEGY.maxAggregateExposurePct).toBe("20");
    expect(DEFAULT_STRATEGY.maxTotalDrawdownPct).toBe("10");
  });

  it("rejects private-key shaped extras and an unsafe starting balance", () => {
    expect(() => parseStrategyConfig({ ...DEFAULT_STRATEGY, privateKey: "secret" })).toThrow();
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { startingBalanceUsd: "0" })).toThrow();
    expect(mergeStrategy(DEFAULT_STRATEGY, { maxPositions: 2 }).maxPositions).toBe(2);
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { maxEntryM5ChangePct: "1" })).toThrow();
  });

  it("fills missing institutional keys from defaults when an older config is loaded", () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_STRATEGY };
    delete legacy.maxEntryM5ChangePct;
    delete legacy.maxRiskPerTradePct;
    delete legacy.maxAggregateExposurePct;
    delete legacy.maxTotalDrawdownPct;
    delete legacy.maxPriceImpactBps;
    delete legacy.paperLatencyMs;
    delete legacy.spreadBpsEstimate;
    delete legacy.orderExpiryMs;
    delete legacy.pulseMinObservations;
    delete legacy.discoveryMaxPairAgeHours;
    delete legacy.discoveryMinPairAgeMinutes;
    const parsed = parseStrategyConfig(legacy);
    expect(parsed.maxEntryM5ChangePct).toBe("25");
    expect(parsed.maxRiskPerTradePct).toBe("0.5");
    expect(parsed.maxAggregateExposurePct).toBe("20");
    expect(parsed.maxTotalDrawdownPct).toBe("10");
    expect(parsed.spreadBpsEstimate).toBe("5");
  });
});
