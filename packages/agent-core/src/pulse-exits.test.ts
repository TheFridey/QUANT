import { DEFAULT_STRATEGY, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { planCycle, type PlanInput } from "./plan.js";
import { runPulse } from "./pulse.js";
import type { DecisionDraft } from "./types.js";

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

function solPair(overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress,
    dexId: "orca",
    url: null,
    baseAddress: "So11111111111111111111111111111111111111112",
    baseSymbol: "SOL",
    baseName: "Wrapped SOL",
    quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteSymbol: "USDC",
    priceUsd: "100",
    liquidityUsd: "1000000",
    volume24hUsd: "5000000",
    volume5mUsd: "10000",
    priceChangeM5Pct: "0.1",
    priceChangeH1Pct: "0.1",
    priceChangeH24Pct: "1",
    txnsM5Buys: 10,
    txnsM5Sells: 10,
    observationId: "obs_pulse",
    freshness: "LIVE",
    receivedAt: "2026-10-28T16:00:00.000Z",
    ...overrides,
  };
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  const pair = solPair();
  return {
    cycleId: "cyc_pulse_exits",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: "9750.00000000",
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    positions: [
      {
        pairAddress,
        baseSymbol: "SOL",
        baseQty: "0.25000000",
        avgCostUsd: "100.00000000",
        realizedPnlUsd: "0.00000000",
        openedAt: "2026-10-28T15:00:00.000Z",
      },
    ],
    pairs: [pair],
    marks: { [pairAddress]: { priceUsd: pair.priceUsd, freshness: "LIVE" } },
    dailyPnlUsd: "0.00000000",
    flatten: false,
    operator: null,
    highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    aggregateExposureUsd: "250.00000000",
    now: new Date("2026-10-28T16:00:00.000Z"),
    ...overrides,
  };
}

const passSurveillance: DecisionDraft = {
  agent: "SENTINEL",
  modelVersion: "test",
  pairAddress,
  decision: "PASS",
  confidence: "1.000000",
  reasonCodes: ["DATA_OK"],
  input: {},
  output: {},
};

describe("pulse invariant exits (D12) + instance exits (D11)", () => {
  it("promoted HOLD still fires stop-loss on an open position", () => {
    const pair = solPair({ priceUsd: "90" });
    const draft = runPulse(
      pair,
      {
        pairAddress,
        baseSymbol: "SOL",
        baseQty: "0.25000000",
        avgCostUsd: "100.00000000",
        realizedPnlUsd: "0.00000000",
      },
      passSurveillance,
      planInput({
        pairs: [pair],
        marks: { [pairAddress]: { priceUsd: "90", freshness: "LIVE" } },
        activeStrategyId: "mean-revert-fade-v1",
      }),
    );
    expect(draft.decision).toBe("ACT");
    expect(draft.reasonCodes).toContain("STOP_LOSS");
    expect(draft.output).toMatchObject({ side: "SELL", intent: "EXIT" });
  });

  it("promoted HOLD still fires time exit when maxHoldingMs elapses", () => {
    const pair = solPair({ priceUsd: "101", receivedAt: "2026-10-28T18:00:00.000Z" });
    const draft = runPulse(
      pair,
      {
        pairAddress,
        baseSymbol: "SOL",
        baseQty: "0.25000000",
        avgCostUsd: "100.00000000",
        realizedPnlUsd: "0.00000000",
        openedAt: "2026-10-28T15:00:00.000Z",
      },
      passSurveillance,
      planInput({
        pairs: [pair],
        marks: { [pairAddress]: { priceUsd: "101", freshness: "LIVE" } },
        activeStrategyId: "mean-revert-fade-v1",
        config: { ...DEFAULT_STRATEGY, maxHoldingMs: 60 * 60 * 1000, trailingStopPct: null },
      }),
    );
    expect(draft.decision).toBe("ACT");
    expect(draft.reasonCodes.some((c) => c === "TIME_EXIT" || c === "MAX_HOLDING")).toBe(true);
  });

  it("instance EXIT_LONG reaches planning as a sell", () => {
    const plan = planCycle(
      planInput({
        concurrentExitByPair: new Map([[pairAddress, "stratinst_test"]]),
        concurrentInstanceByPair: new Map([[pairAddress, "stratinst_test"]]),
        pairs: [solPair({ priceUsd: "101", priceChangeM5Pct: "0.5" })],
        marks: { [pairAddress]: { priceUsd: "101", freshness: "LIVE" } },
      }),
    );
    expect(plan.orders.some((o) => o.side === "SELL" && o.intent === "EXIT")).toBe(true);
    expect(plan.orders[0]?.strategyInstanceId).toBe("stratinst_test");
    expect(plan.decisions.some((d) => d.reasonCodes.includes("STRATEGY_INSTANCE_EXIT"))).toBe(true);
  });

  it("empty concurrent entry allowlist blocks automatic entries (D11/§5)", () => {
    const plan = planCycle(
      planInput({
        cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
        positions: [],
        aggregateExposureUsd: "0",
        concurrentEntryAllowlist: new Set(),
        concurrentEntryByPair: new Map(),
        pairs: [solPair({ priceChangeM5Pct: "3.5", priceChangeH1Pct: "1.2", txnsM5Buys: 80, txnsM5Sells: 20 })],
        marks: { [pairAddress]: { priceUsd: "100", freshness: "LIVE" } },
      }),
    );
    expect(plan.orders.filter((o) => o.side === "BUY")).toHaveLength(0);
    // §5: gating HOLDs at PULSE (empty ≠ ungated); ATLAS allocation block remains valid if ENTRY leaked.
    expect(
      plan.decisions.some(
        (d) =>
          d.reasonCodes.includes("STRATEGY_INSTANCE_GATING") ||
          (d.output && (d.output as { blockedBy?: string }).blockedBy === "STRATEGY_INSTANCE_ALLOCATION"),
      ),
    ).toBe(true);
  });

  it("disabled MarketSelection blocks new ENTRY while exits still plan (D15)", () => {
    const entryBlocked = planCycle(
      planInput({
        cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
        positions: [],
        aggregateExposureUsd: "0",
        marketEntryEnabled: new Map([["solana:spot:universe", false]]),
        pairs: [solPair({ priceChangeM5Pct: "3.5", priceChangeH1Pct: "1.2", txnsM5Buys: 80, txnsM5Sells: 20 })],
        marks: { [pairAddress]: { priceUsd: "100", freshness: "LIVE" } },
      }),
    );
    expect(entryBlocked.orders.filter((o) => o.side === "BUY")).toHaveLength(0);
    expect(entryBlocked.decisions.some((d) => d.reasonCodes.includes("MARKET_ENTRY_DISABLED"))).toBe(true);

    const exitOk = planCycle(
      planInput({
        marketEntryEnabled: new Map([["solana:spot:universe", false]]),
        pairs: [solPair({ priceUsd: "90" })],
        marks: { [pairAddress]: { priceUsd: "90", freshness: "LIVE" } },
      }),
    );
    expect(exitOk.orders.some((o) => o.side === "SELL")).toBe(true);
  });
});
