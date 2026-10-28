import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORACLE_LIMITS, ORACLE_CAPABILITIES, emptyOracleQueue } from "./oracle-research.js";
import { runBoundedResearchCycle } from "./oracle-cycle.js";
import { FixtureModelProvider } from "./fixture-provider.js";
import { MemoryBudgetStore } from "./budget-store.js";
import { ModelRouter } from "./router.js";
import { sha256 } from "./compile-strategy.js";
import { isolationAvailable } from "./sandbox-runner.js";
import type { TradeMemoryRecord } from "@odin/shared";

const holdSource = `export function onBar() {
  return { intent: "HOLD", reasonCodes: ["HOLD_LOGIC"] };
}`;

const enterSource = `export function onBar() {
  return { intent: "ENTER_LONG", reasonCodes: ["ENTER_LOGIC"] };
}`;

const memory: TradeMemoryRecord[] = [
  {
    tradeId: "t1",
    pairAddress: "pair",
    phase: "BEFORE",
    capturedAt: "2026-10-28T12:00:00.000Z",
    context: { condition: "m5-thrust" },
    postExit: false,
  },
  {
    tradeId: "t1",
    pairAddress: "pair",
    phase: "BEFORE",
    capturedAt: "2026-10-28T12:05:00.000Z",
    context: { condition: "m5-thrust" },
    postExit: false,
  },
  {
    tradeId: "t1",
    pairAddress: "pair",
    phase: "AFTER",
    capturedAt: "2026-10-28T12:10:00.000Z",
    context: { condition: "m5-thrust", realizedPnlUsd: "10" },
    postExit: true,
  },
];

function routerFor(source: string, store = new MemoryBudgetStore()) {
  const fixture = new FixtureModelProvider({
    fast_observer: { weaknesses: ["thin follow-through"] },
    deep_hypothesis: {
      title: "M5 continuation fails out of sample",
      falsifier: "Untouched window return is null or negative",
      conditions: "m5 thrust continues for one bar",
    },
    engineering_source: { source },
    challenge_review: { verdict: "REJECT", findings: ["SAMPLE_SIZE"] },
  });
  const providers = new Map([
    ["hermes-primary", fixture],
    ["openai-primary", fixture],
    ["anthropic-primary", fixture],
    ["challenge-primary", fixture],
  ]);
  return new ModelRouter({ providers, mode: "live", env: {}, budgetStore: store, budgetCapUsd: "5" });
}

function cycleInput(router: ModelRouter, queue = emptyOracleQueue()) {
  return {
    router,
    performance: { returnPct: null as string | null, sampleSize: 0, maxDrawdownPct: null as string | null },
    memory,
    baselines: [{ id: "baseline", returnPct: "0.10", sampleSize: 40 }],
    hypothesisId: "hyp-cycle",
    instrumentIds: ["solana:spot:universe"],
    queue,
    limits: DEFAULT_ORACLE_LIMITS,
    bars: [
      {
        instrumentId: "solana:spot:universe",
        receivedAt: "2026-01-01T00:00:00.000Z",
        priceUsd: "1",
        liquidityUsd: "100000",
        volume24hUsd: "100000",
        priceChangeM5Pct: "1",
        priceChangeH1Pct: "1",
        txnsM5Buys: 3,
        txnsM5Sells: 1,
        dataState: "REPLAY",
      },
      {
        instrumentId: "solana:spot:universe",
        receivedAt: "2026-01-01T00:05:00.000Z",
        priceUsd: "1.01",
        liquidityUsd: "100000",
        volume24hUsd: "100000",
        priceChangeM5Pct: "1",
        priceChangeH1Pct: "1",
        txnsM5Buys: 3,
        txnsM5Sells: 1,
        dataState: "REPLAY",
      },
    ],
  };
}

describe("bounded oracle research cycle", () => {
  it("runs the thirteen capabilities in order and executes the engineering source", async () => {
    expect(isolationAvailable(), "bubblewrap is required to prove the executed hash").toBe(true);
    const hold = await runBoundedResearchCycle(cycleInput(routerFor(holdSource)));
    const enter = await runBoundedResearchCycle(cycleInput(routerFor(enterSource)));
    expect(hold.steps.map((step) => step.capability)).toEqual([...ORACLE_CAPABILITIES]);
    expect(enter.steps.map((step) => step.capability)).toEqual(hold.steps.map((step) => step.capability));
    expect(hold.actionCount).toBe(13);
    expect(hold.actionCount).toBeLessThanOrEqual(DEFAULT_ORACLE_LIMITS.maxExperimentsPerCycle + 5);
    expect(hold.forgeEndpointId).not.toBe(hold.challengeEndpointId);
    expect(hold.engineeringSource).toBe(holdSource);
    expect(hold.executedSourceHash).toBe(sha256(holdSource));
    expect(enter.executedSourceHash).toBe(sha256(enterSource));
    expect(hold.signalsClaimed).toBe(true);
    expect(enter.signalsClaimed).toBe(true);
    expect(hold.signals.map((signal) => signal.intent)).not.toEqual(enter.signals.map((signal) => signal.intent));
    expect(hold.candidateRejected).toBe(true);
    expect(hold.steps.every((step) => step.aiDiscovery === false)).toBe(true);
    expect(hold.aiDiscoveryStored).toBe(false);
    const tiers = hold.routerUsage.map((row) => row.tier);
    expect(tiers).toEqual(
      expect.arrayContaining(["FAST_OBSERVERS", "DEEP_RESEARCHERS", "ENGINEERING_AGENTS", "INDEPENDENT_CHALLENGE"]),
    );
    expect(hold.routerUsage.filter((row) => row.ok).every((row) => row.model === "FIXTURE" && row.provenance === "FIXTURE" && row.costKind === "ESTIMATED" && row.promptTokensEst > 0)).toBe(true);
    expect(hold.steps.find((step) => step.capability === "EXAMINE_TRADE_MEMORY")?.detail).toContain("2");
    expect(hold.steps.find((step) => step.capability === "EXAMINE_TRADE_MEMORY")?.detail).not.toContain("realizedPnlUsd");
    expect(JSON.stringify(hold)).not.toContain("TEMPLATE research strategy");
  });

  it("reports UNAVAILABLE and does not execute generated code when no provider is configured", async () => {
    const router = new ModelRouter({
      env: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", HERMES_API_KEY: "", ODIN_CHALLENGE_API_KEY: "" },
      mode: "live",
      budgetCapUsd: "5",
    });
    const result = await runBoundedResearchCycle(cycleInput(router));
    for (const capability of ["FALSIFIABLE_HYPOTHESIS", "REQUEST_CODE_GENERATION", "REVIEW_CHALLENGE"] as const) {
      expect(result.steps.find((step) => step.capability === capability)?.status).toBe("UNAVAILABLE");
    }
    expect(result.experimentExecuted).toBe(false);
    expect(result.signalsClaimed).toBe(false);
    expect(result.engineeringSource).toBeNull();
    expect(result.aiDiscoveryStored).toBe(false);
    expect(result.steps.every((step) => step.aiDiscovery === false)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("TEMPLATE research strategy");
    expect(result.routerUsage.some((row) => row.ok && row.provenance === "LIVE")).toBe(false);
  });

  it("rejects a malformed engineering payload and keeps fixture spend across a restarted store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odin-cycle-budget-"));
    const budgetPath = join(dir, "spend.json");
    const fixture = new FixtureModelProvider({
      fast_observer: { weaknesses: ["thin follow-through"] },
      deep_hypothesis: {
        title: "M5 continuation fails out of sample",
        falsifier: "Untouched window return is null or negative",
        conditions: "m5 thrust continues for one bar",
      },
      engineering_source: { source: 12 },
      challenge_review: { verdict: "MAYBE" },
    });
    const providers = new Map([
      ["hermes-primary", fixture],
      ["openai-primary", fixture],
      ["anthropic-primary", fixture],
      ["challenge-primary", fixture],
    ]);
    const first = new ModelRouter({ providers, mode: "live", env: {}, budgetPath, budgetCapUsd: "5" });
    const result = await runBoundedResearchCycle(cycleInput(first));
    expect(result.experimentExecuted).toBe(false);
    expect(result.signalsClaimed).toBe(false);
    expect(result.aiDiscoveryStored).toBe(false);
    expect(result.steps.find((step) => step.capability === "REQUEST_CODE_GENERATION")?.status).toBe("UNAVAILABLE");
    const restarted = new ModelRouter({ env: {}, mode: "live", budgetPath, budgetCapUsd: "5" });
    expect(Number(restarted.budget().spentUsd)).toBeGreaterThan(0);
    expect(JSON.stringify(restarted.budget())).not.toMatch(/API_KEY|sk-/);
  });

  it("stops a repeated failure from queuing another experiment", async () => {
    const router = routerFor(`export function onBar() { return { intent: "HOLD", reasonCodes: ["process.env.SECRET"] }; }`);
    const limits = { ...DEFAULT_ORACLE_LIMITS, maxRepeatedFailures: 1 };
    const first = await runBoundedResearchCycle({ ...cycleInput(router), limits });
    expect(first.queue.terminated || first.queue.failureStreak >= 1).toBe(true);
    const second = await runBoundedResearchCycle({ ...cycleInput(router, first.queue), limits });
    expect(second.steps.find((step) => step.capability === "RECOMMEND_EXPERIMENT")?.status).toBe("REJECTED");
    expect(second.actionCount).toBe(13);
  });
});
