import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRATEGY,
  mergeStrategy,
  parseStrategyConfig,
  strategyPatchOnlyOperational,
  strategyPatchHasNonOperationalKeys,
} from "./strategy.js";

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

  it("rejects a legacy $100 / 5% deadlock config instead of silently healing it (audit H1)", () => {
    const stored = {
      ...DEFAULT_STRATEGY,
      startingBalanceUsd: "100.00000000",
      minOrderNotionalUsd: "5",
      maxPositions: 4,
      universeLimit: 12,
    };
    const snapshot = structuredClone(stored);
    expect(() => parseStrategyConfig(stored)).toThrow(/minOrderNotionalUsd/);
    // The stored object is untouched: no balance raised to $10,000, no positions raised to 8.
    expect(stored).toEqual(snapshot);
    expect(stored.startingBalanceUsd).toBe("100.00000000");
    expect(stored.maxPositions).toBe(4);
  });

  it("never rewrites a valid stored value on load", () => {
    const stored = { ...DEFAULT_STRATEGY, maxPositions: 3, startingBalanceUsd: "5000.00000000" };
    const parsed = parseStrategyConfig(stored);
    expect(parsed.maxPositions).toBe(3);
    expect(parsed.startingBalanceUsd).toBe("5000.00000000");
  });

  it("defaults DEMO entries off and keeps a bounded exit impact cap (audit H2, C3)", () => {
    expect(DEFAULT_STRATEGY.allowDemoPaperEntries).toBe(false);
    expect(DEFAULT_STRATEGY.maxExitImpactBps).toBe("1000");
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { maxExitImpactBps: "0" })).toThrow();
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { maxExitImpactBps: "5001" })).toThrow();
  });

  it("rejects private-key shaped extras and an unsafe starting balance", () => {
    expect(() => parseStrategyConfig({ ...DEFAULT_STRATEGY, privateKey: "secret" })).toThrow();
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { startingBalanceUsd: "0" })).toThrow();
    expect(mergeStrategy(DEFAULT_STRATEGY, { maxPositions: 2 }).maxPositions).toBe(2);
    expect(() => mergeStrategy(DEFAULT_STRATEGY, { maxEntryM5ChangePct: "1" })).toThrow();
  });

  it("classifies operational-only patches for RUNNING updates (D16)", () => {
    expect(strategyPatchOnlyOperational({ pauseNewEntries: true })).toBe(true);
    expect(strategyPatchOnlyOperational({ pauseNewEntries: true, entryM5ChangePct: "3" })).toBe(false);
    expect(strategyPatchHasNonOperationalKeys({ allowDemoPaperEntries: false })).toBe(false);
    expect(strategyPatchHasNonOperationalKeys({ maxPositions: 2 })).toBe(true);
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
