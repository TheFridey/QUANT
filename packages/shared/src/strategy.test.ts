import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, mergeStrategy, parseStrategyConfig } from "./strategy.js";

describe("strategy config", () => {
  it("accepts the default paper configuration with activity headroom", () => {
    expect(parseStrategyConfig(DEFAULT_STRATEGY).startingBalanceUsd).toBe("10000.00000000");
    expect(DEFAULT_STRATEGY.maxPositions).toBe(8);
    expect(DEFAULT_STRATEGY.universeLimit).toBe(24);
    expect(DEFAULT_STRATEGY.minOrderNotionalUsd).toBe("25");
    expect(DEFAULT_STRATEGY.maxPositionPctEquity).toBe("5");
    expect(DEFAULT_STRATEGY.maxDailyLossPct).toBe("3");
    expect(DEFAULT_STRATEGY.maxRiskPerTradePct).toBe("0.5");
    expect(DEFAULT_STRATEGY.maxAggregateExposurePct).toBe("20");
    expect(DEFAULT_STRATEGY.maxTotalDrawdownPct).toBe("10");
  });

  it("rejects a config where min order exceeds max position budget at start", () => {
    expect(() =>
      mergeStrategy(DEFAULT_STRATEGY, {
        startingBalanceUsd: "100.00000000",
        maxPositionPctEquity: "5",
        minOrderNotionalUsd: "5",
      }),
    ).toThrow(/minOrderNotionalUsd/);
  });

  it("heals legacy $100/$5 deadlock rows on parse without loosening % risk", () => {
    const healed = parseStrategyConfig({
      ...DEFAULT_STRATEGY,
      startingBalanceUsd: "100.00000000",
      minOrderNotionalUsd: "5",
      maxPositions: 4,
      universeLimit: 12,
    });
    expect(healed.startingBalanceUsd).toBe("10000.00000000");
    expect(healed.minOrderNotionalUsd).toBe("25");
    expect(healed.maxPositionPctEquity).toBe("5");
    expect(healed.maxRiskPerTradePct).toBe("0.5");
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
