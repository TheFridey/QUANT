import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import {
  allocateOpportunities,
  buildInstancePlanGates,
  evaluateConcurrentInstances,
  type DurableStrategyInstance,
} from "./strategy-instances.js";

function instance(partial: Partial<DurableStrategyInstance> & Pick<DurableStrategyInstance, "id" | "name" | "instrumentIds">): DurableStrategyInstance {
  return {
    version: "1.0.0",
    accountId: "primary",
    timeframe: "M5",
    params: {},
    budgetUsd: "10000",
    health: "HEALTHY",
    status: "ACTIVE",
    artifactHash: `art_${partial.id}`,
    sourceHash: `src_${partial.id}`,
    ...partial,
  };
}

describe("concurrent strategy instances", () => {
  it("allocateOpportunities prefers exits and caps new entries fairly", () => {
    const signals = [
      {
        intent: "EXIT_LONG" as const,
        reasonCodes: ["EXIT_MOMENTUM"],
        instrumentId: "fx:EURUSD",
        pairAddress: "fx:EURUSD",
        strategyInstanceId: "i2",
        strategyVersion: "pulse@1",
        artifactHash: null,
        sourceHash: null,
      },
      {
        intent: "ENTER_LONG" as const,
        reasonCodes: ["ENTRY_MOMENTUM"],
        instrumentId: "fx:EURUSD",
        pairAddress: "fx:EURUSD",
        strategyInstanceId: "i2",
        strategyVersion: "pulse@1",
        artifactHash: null,
        sourceHash: null,
      },
      {
        intent: "ENTER_LONG" as const,
        reasonCodes: ["ENTRY_MOMENTUM"],
        instrumentId: "etf:SPY",
        pairAddress: "etf:SPY",
        strategyInstanceId: "i3",
        strategyVersion: "mean@1",
        artifactHash: null,
        sourceHash: null,
      },
      {
        intent: "ENTER_LONG" as const,
        reasonCodes: ["ENTRY_MOMENTUM"],
        instrumentId: "crypto",
        pairAddress: "crypto",
        strategyInstanceId: "i1",
        strategyVersion: "pulse@1",
        artifactHash: null,
        sourceHash: null,
      },
    ];
    const allocated = allocateOpportunities({ signals, maxNewEntries: 2 });
    expect(allocated.accepted.some((s) => s.intent === "EXIT_LONG")).toBe(true);
    expect(allocated.accepted.filter((s) => s.intent === "ENTER_LONG")).toHaveLength(2);
    expect(allocated.deferred.filter((s) => s.intent === "ENTER_LONG")).toHaveLength(1);

    const gates = buildInstancePlanGates(allocated.accepted);
    expect(gates.exitByPair.get("fx:EURUSD")).toBe("i2");
    expect(gates.entryAllowlist.has("fx:EURUSD")).toBe(true);
    expect(gates.instanceByPair.get("fx:EURUSD")).toBeTruthy();
  });

  it("empty ENTER intents produce an empty allowlist (never null-fallback semantics)", () => {
    const gates = buildInstancePlanGates([
      {
        intent: "EXIT_LONG",
        reasonCodes: ["EXIT_MOMENTUM"],
        instrumentId: "fx:EURUSD",
        pairAddress: "fx:EURUSD",
        strategyInstanceId: "i2",
        strategyVersion: "pulse@1",
        artifactHash: null,
        sourceHash: null,
      },
      {
        intent: "HOLD",
        reasonCodes: ["NO_EDGE"],
        instrumentId: "etf:SPY",
        pairAddress: "etf:SPY",
        strategyInstanceId: "i3",
        strategyVersion: "mean@1",
        artifactHash: null,
        sourceHash: null,
      },
    ]);
    expect(gates.entryAllowlist.size).toBe(0);
    expect(gates.exitByPair.get("fx:EURUSD")).toBe("i2");
    expect(gates.instanceByPair.get("fx:EURUSD")).toBe("i2");
  });

  it("runs ≥3 instances across crypto/FX/ETF and attributes signals", () => {
    const instances = [
      instance({ id: "i1", name: "pulse-momentum-v1", instrumentIds: ["solana:spot:universe"] }),
      instance({ id: "i2", name: "pulse-momentum-v1-fx", instrumentIds: ["fx:EURUSD"] }),
      instance({
        id: "i3",
        name: "mean-revert-fade-v1",
        instrumentIds: ["etf:SPY"],
        params: {},
      }),
    ];
    // Two share EURUSD safely via attribution
    instances.push(instance({ id: "i4", name: "breakout-hold-v1", instrumentIds: ["fx:EURUSD"] }));

    const bars = [
      {
        instrumentId: "solana:spot:universe",
        pairAddress: "crypto-pair",
        receivedAt: "2026-10-28T16:00:00.000Z",
        priceUsd: "10",
        liquidityUsd: "1000000",
        volume24hUsd: "500000",
        priceChangeM5Pct: "3",
        priceChangeH1Pct: "1",
        txnsM5Buys: 10,
        txnsM5Sells: 2,
        dataState: "LIVE",
      },
      {
        instrumentId: "fx:EURUSD",
        pairAddress: "fx:EURUSD",
        receivedAt: "2026-10-28T16:00:00.000Z",
        priceUsd: "1.08",
        liquidityUsd: null,
        volume24hUsd: null,
        priceChangeM5Pct: "2.5",
        priceChangeH1Pct: "1",
        txnsM5Buys: null,
        txnsM5Sells: null,
        dataState: "DELAYED",
      },
      {
        instrumentId: "etf:SPY",
        pairAddress: "etf:SPY",
        receivedAt: "2026-10-28T16:00:00.000Z",
        priceUsd: "520",
        liquidityUsd: null,
        volume24hUsd: null,
        priceChangeM5Pct: "-2",
        priceChangeH1Pct: "0",
        txnsM5Buys: null,
        txnsM5Sells: null,
        dataState: "DELAYED",
      },
    ];

    const signals = evaluateConcurrentInstances({
      instances,
      bars,
      context: {
        config: DEFAULT_STRATEGY,
        openPositions: [],
        history: [],
      },
    });
    expect(signals.length).toBeGreaterThanOrEqual(3);
    const fxSignals = signals.filter((s) => s.instrumentId === "fx:EURUSD" || s.pairAddress === "fx:EURUSD");
    expect(fxSignals.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fxSignals.map((s) => s.strategyInstanceId)).size).toBeGreaterThanOrEqual(2);

    const allocated = allocateOpportunities({ signals, maxNewEntries: 2 });
    expect(allocated.accepted.filter((s) => s.intent === "ENTER_LONG").length).toBeLessThanOrEqual(2);
  });
});
