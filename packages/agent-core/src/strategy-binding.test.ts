import { DEFAULT_STRATEGY, configHashOf } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { builtinArtifactIdentity, resolveStrategyBinding, verifyRuntimeBinding } from "./strategy-binding.js";
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

  it("refuses a builtin moduleRef whose claimed artifactHash is not that module's identity", () => {
    const identity = builtinArtifactIdentity("pulse-momentum-v1")!;
    expect(
      resolveStrategyBinding({ moduleRef: "pulse-momentum-v1", artifactHash: identity.artifactHash, instrumentIds: [] }).ok,
    ).toBe(true);
    const forged = resolveStrategyBinding({
      moduleRef: "pulse-momentum-v1",
      artifactHash: "f".repeat(64),
      instrumentIds: [],
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("ARTIFACT_HASH_MISMATCH");
  });
});

describe("builtin executable identity", () => {
  it("keeps source, artifact, and config identities distinct and stable", () => {
    const a = builtinArtifactIdentity("pulse-momentum-v1")!;
    const b = builtinArtifactIdentity("pulse-momentum-v1")!;
    const other = builtinArtifactIdentity("mean-revert-fade-v1")!;
    expect(a).toEqual(b);
    expect(a.artifactHash).not.toBe(a.sourceHash);
    expect(a.artifactHash).not.toBe(other.artifactHash);
    expect(a.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(builtinArtifactIdentity("fx-breakout-v1")).toBeNull();
    expect(builtinArtifactIdentity("custom-generated-v1")).toBeNull();
  });
});

describe("verifyRuntimeBinding", () => {
  const identity = builtinArtifactIdentity("pulse-momentum-v1")!;
  const config = { ...DEFAULT_STRATEGY, entryM5ChangePct: "3" };
  const active = {
    strategyId: "strat",
    strategyVersion: "1",
    moduleRef: identity.moduleRef,
    moduleVersion: identity.moduleVersion,
    sourceHash: identity.sourceHash,
    artifactHash: identity.artifactHash,
    configHash: configHashOf(config),
  };
  const loaded = resolveStrategyBinding({ moduleRef: "pulse-momentum-v1", instrumentIds: [] });
  if (!loaded.ok) throw new Error("builtin must resolve");

  it("accepts the exact promoted module and config", () => {
    expect(
      verifyRuntimeBinding({
        activeStrategy: active,
        loadedModule: { moduleRef: loaded.moduleRef, version: loaded.module.version, config: { ...config } },
      }),
    ).toEqual({ ok: true, mismatches: [] });
  });

  it("reports a different module, version, or config instead of stamping the promoted identity", () => {
    const otherModule = verifyRuntimeBinding({
      activeStrategy: active,
      loadedModule: { moduleRef: "mean-revert-fade-v1", version: "1.1.0", config },
    });
    expect(otherModule.ok).toBe(false);
    expect(otherModule.mismatches.map((m) => m.field)).toEqual(
      expect.arrayContaining(["moduleRef", "moduleVersion", "artifactHash"]),
    );
    const changedConfig = verifyRuntimeBinding({
      activeStrategy: active,
      loadedModule: { moduleRef: loaded.moduleRef, version: loaded.module.version, config: { ...config, entryM5ChangePct: "9" } },
    });
    expect(changedConfig.ok).toBe(false);
    expect(changedConfig.mismatches.map((m) => m.field)).toEqual(["configHash"]);
    const bumped = verifyRuntimeBinding({
      activeStrategy: active,
      loadedModule: { moduleRef: loaded.moduleRef, version: "9.9.9", config },
    });
    expect(bumped.mismatches.map((m) => m.field)).toEqual(["moduleVersion", "artifactHash"]);
  });

  it("treats legacy or missing bindings as unverified", () => {
    const legacy = verifyRuntimeBinding({
      activeStrategy: { strategyId: "s", strategyVersion: "1", sourceHash: "a".repeat(64), artifactHash: "b".repeat(64) },
      loadedModule: { moduleRef: loaded.moduleRef, version: loaded.module.version, config },
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.mismatches[0]?.field).toBe("binding");
    expect(verifyRuntimeBinding({ activeStrategy: null, loadedModule: { moduleRef: "x", version: "1", config } }).ok).toBe(false);
  });
});
