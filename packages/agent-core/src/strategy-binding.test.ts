import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { resolveStrategyBinding } from "./strategy-binding.js";
import { moduleForInstance, type DurableStrategyInstance } from "./strategy-instances.js";

describe("§7 explicit strategy binding", () => {
  it("resolves builtin moduleRef without using display name", () => {
    const binding = resolveStrategyBinding({
      moduleRef: "mean-revert-fade-v1",
      name: "Totally Different Display Name",
      instrumentIds: ["etf:SPY"],
      instanceId: "inst1",
    });
    expect(binding.ok).toBe(true);
    if (binding.ok) {
      expect(binding.moduleRef).toBe("mean-revert-fade-v1");
      expect(binding.provenance).toBe("builtin");
      expect(binding.module.id).toBe("inst1");
    }
  });

  it("rename alone does not change strategy when moduleRef stays", () => {
    const a = moduleForInstance({
      id: "x",
      name: "old-label",
      moduleRef: "pulse-momentum-v1",
      version: "1.0.0",
      accountId: "primary",
      instrumentIds: ["fx:EURUSD"],
      timeframe: "M5",
      params: {},
      budgetUsd: "1",
      health: "HEALTHY",
      status: "ACTIVE",
      artifactHash: null,
      sourceHash: null,
    } satisfies DurableStrategyInstance);
    const b = moduleForInstance({
      id: "x",
      name: "new-marketing-name",
      moduleRef: "pulse-momentum-v1",
      version: "1.0.0",
      accountId: "primary",
      instrumentIds: ["fx:EURUSD"],
      timeframe: "M5",
      params: {},
      budgetUsd: "1",
      health: "HEALTHY",
      status: "ACTIVE",
      artifactHash: null,
      sourceHash: null,
    });
    expect(a.version).toBe(b.version);
    expect(a.id).toBe("x");
    expect(b.id).toBe("x");
    // Same module family — rename must not swap to mean-revert/breakout.
    const flat = {
      instrumentId: "fx:EURUSD",
      pairAddress: "fx:EURUSD",
      receivedAt: "2026-10-28T16:00:00.000Z",
      priceUsd: "1.08",
      liquidityUsd: null,
      volume24hUsd: null,
      priceChangeM5Pct: "3",
      priceChangeH1Pct: "1",
      txnsM5Buys: null,
      txnsM5Sells: null,
      dataState: "DELAYED",
    };
    const ctx = {
      config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "2", minH1ChangePct: "0.5" },
      openPositions: [],
      history: [],
    };
    expect(a.onBar(flat, ctx).intent).toBe(b.onBar(flat, ctx).intent);
    expect(a.onBar(flat, ctx).intent).toBe("ENTER_LONG");
  });

  it("unknown moduleRef fails clearly", () => {
    const binding = resolveStrategyBinding({
      moduleRef: "made-up-strategy-v9",
      instrumentIds: ["fx:EURUSD"],
    });
    expect(binding.ok).toBe(false);
    if (!binding.ok) {
      expect(binding.code).toBe("UNKNOWN_MODULE_REF");
      expect(binding.message).toContain("made-up-strategy-v9");
    }
  });

  it("missing moduleRef fails — display name is not a binding", () => {
    const binding = resolveStrategyBinding({
      moduleRef: null,
      name: "mean-revert-fade-v1",
      instrumentIds: ["etf:SPY"],
    });
    expect(binding.ok).toBe(false);
    if (!binding.ok) expect(binding.code).toBe("MISSING_MODULE_REF");
  });

  it("dynamic artifact for non-builtin is explicitly unavailable", () => {
    const binding = resolveStrategyBinding({
      moduleRef: "custom-generated-v1",
      artifactHash: "abc123",
      instrumentIds: ["fx:EURUSD"],
    });
    expect(binding.ok).toBe(false);
    if (!binding.ok) {
      expect(binding.code).toBe("DYNAMIC_ARTIFACT_UNAVAILABLE");
      expect(binding.message).toMatch(/unavailable/i);
    }
  });
});
