import { DEFAULT_STRATEGY, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { planCycle, type PlanInput } from "./plan.js";
import { runPulse } from "./pulse.js";
import {
  allocateOpportunities,
  evaluateConcurrentInstances,
  toCanonicalIntents,
  toPlanIntents,
  type AttributedSignal,
  type DurableStrategyInstance,
} from "./strategy-instances.js";
import type { DecisionDraft, PlanIntent } from "./types.js";

function intentFor(
  strategyInstanceId: string,
  pairAddress: string,
  action: "ENTER" | "EXIT",
  cycleId = "cyc_attr",
): PlanIntent {
  const signal: AttributedSignal = {
    intent: action === "ENTER" ? "ENTER_LONG" : "EXIT_LONG",
    reasonCodes: [action === "ENTER" ? "ENTRY_MOMENTUM" : "EXIT_MOMENTUM"],
    instrumentId: pairAddress,
    pairAddress,
    strategyInstanceId,
    strategyVersion: `${strategyInstanceId}@1.0.0`,
    moduleRef: "pulse-momentum-v1",
    accountId: "primary",
    artifactHash: null,
    sourceHash: null,
  };
  return toPlanIntents([signal], { cycleId, accountId: "primary" })[0]!;
}

const fx = "fx:EURUSD";
const etf = "etf:SPY";

function instance(
  partial: Partial<DurableStrategyInstance> &
    Pick<DurableStrategyInstance, "id" | "name" | "instrumentIds" | "moduleRef">,
): DurableStrategyInstance {
  return {
    version: "1.0.0",
    accountId: "primary",
    timeframe: "M5",
    params: {},
    budgetUsd: "10000",
    health: "HEALTHY",
    status: "ACTIVE",
    artifactHash: null,
    sourceHash: `src_${partial.id}`,
    ...partial,
  };
}

function fxPair(overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "fixture",
    chainId: "fx",
    pairAddress: fx,
    dexId: null,
    url: null,
    baseAddress: "EUR",
    baseSymbol: "EUR",
    baseName: "Euro",
    quoteAddress: "USD",
    quoteSymbol: "USD",
    priceUsd: "1.08",
    liquidityUsd: "5000000",
    volume24hUsd: "100000000",
    volume5mUsd: "1000000",
    priceChangeM5Pct: "0.1",
    priceChangeH1Pct: "0.1",
    priceChangeH24Pct: null,
    txnsM5Buys: null,
    txnsM5Sells: null,
    observationId: "obs_fx",
    // LIVE so risk admits paper entries; DELAYED would reject BUY at ATLAS.
    freshness: "LIVE",
    receivedAt: "2026-10-28T16:00:00.000Z",
    ...overrides,
  };
}

function etfPair(overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    ...fxPair({ pairAddress: etf, baseAddress: "SPY", baseSymbol: "SPY", baseName: "SPY", chainId: "etf" }),
    ...overrides,
    pairAddress: etf,
    chainId: "etf",
  };
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  const pair = fxPair();
  return {
    cycleId: "cyc_attr",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    positions: [],
    pairs: [pair],
    marks: { [fx]: { priceUsd: pair.priceUsd, freshness: "LIVE" } },
    dailyPnlUsd: "0",
    flatten: false,
    operator: null,
    highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    aggregateExposureUsd: "0",
    now: new Date("2026-10-28T16:00:00.000Z"),
    ...overrides,
  };
}

const passSurveillance: DecisionDraft = {
  agent: "SENTINEL",
  modelVersion: "test",
  pairAddress: fx,
  decision: "PASS",
  confidence: "1.000000",
  reasonCodes: ["DATA_OK"],
  input: {},
  output: {},
};

describe("§5 attributed concurrent intents", () => {
  it("mean-revert ENTER reaches planning while momentum HOLDs (no pulse edge)", () => {
    const mrEntry = {
      strategyInstanceId: "stratinst_mr",
      strategyVersion: "mean-revert-fade-v1@1.0.0",
      moduleRef: "mean-revert-fade-v1",
      reasonCodes: ["ENTRY_MEAN_REVERT", "FADE_OVERSOLD"],
      artifactHash: "art",
      sourceHash: "src",
    };
    const pair = etfPair({ priceChangeM5Pct: "-2.5", priceChangeH1Pct: "-0.5" });
    void mrEntry;
    const intents = [intentFor("stratinst_mr", etf, "ENTER")];
    // Global pulse HOLDs (no momentum, instance gating active) — it never invents an entry itself.
    const draft = runPulse(pair, undefined, passSurveillance, planInput({
      pairs: [pair],
      marks: { [etf]: { priceUsd: "520", freshness: "LIVE" } },
      instanceIntents: intents,
      activeStrategyId: "pulse-momentum-v1",
    }));
    expect(draft.decision).not.toBe("ACT");

    const plan = planCycle(
      planInput({
        pairs: [pair],
        marks: { [etf]: { priceUsd: "520", freshness: "LIVE" } },
        instanceIntents: intents,
        activeStrategyId: "pulse-momentum-v1",
      }),
    );
    const buy = plan.orders.find((o) => o.side === "BUY" && o.strategyInstanceId === "stratinst_mr");
    expect(buy).toBeDefined();
    expect(buy?.clientOrderId).toBe(intents[0]!.clientOrderId);
    expect(buy?.ownerScope).toBe("STRATEGY");
  });

  it("momentum ENTER reaches planning while mean-revert HOLDs", () => {
    const momEntry = {
      strategyInstanceId: "stratinst_mom",
      strategyVersion: "pulse-momentum-v1@1.0.0",
      moduleRef: "pulse-momentum-v1",
      reasonCodes: ["ENTRY_MOMENTUM"],
    };
    const pair = fxPair({ priceChangeM5Pct: "3", priceChangeH1Pct: "1.5" });
    const plan = planCycle(
      planInput({
        pairs: [pair],
        marks: { [fx]: { priceUsd: "1.08", freshness: "LIVE" } },
        instanceIntents: [intentFor(momEntry.strategyInstanceId, fx, "ENTER")],
        activeStrategyId: "mean-revert-fade-v1",
      }),
    );
    expect(plan.orders.some((o) => o.side === "BUY" && o.strategyInstanceId === "stratinst_mom")).toBe(true);
  });

  it("breakout ENTER alone produces an order without a second strategy ACT", () => {
    const bo = {
      strategyInstanceId: "stratinst_bo",
      strategyVersion: "breakout-hold-v1@1.0.0",
      moduleRef: "breakout-hold-v1",
      reasonCodes: ["ENTRY_MOMENTUM"],
    };
    const pair = fxPair({ priceChangeM5Pct: "2.5", priceChangeH1Pct: "1.2" });
    const plan = planCycle(
      planInput({
        pairs: [pair],
        instanceIntents: [intentFor(bo.strategyInstanceId, fx, "ENTER")],
        // No activeStrategyId — instance path is sufficient.
        activeStrategyId: null,
      }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]?.strategyInstanceId).toBe("stratinst_bo");
  });

  it("HOLD from instances does not suppress protection stop exits", () => {
    const pair = fxPair({ priceUsd: "0.90" });
    const plan = planCycle(
      planInput({
        pairs: [pair],
        marks: { [fx]: { priceUsd: "0.90", freshness: "DELAYED" } },
        positions: [
          {
            pairAddress: fx,
            baseSymbol: "EUR",
            baseQty: "1000",
            avgCostUsd: "1.08",
            realizedPnlUsd: "0",
          },
        ],
        cashUsd: "8000",
        aggregateExposureUsd: "1080",
        instanceIntents: [],
        activeStrategyId: "mean-revert-fade-v1",
      }),
    );
    expect(plan.orders.some((o) => o.side === "SELL" && o.intent === "EXIT")).toBe(true);
    expect(plan.decisions.some((d) => d.reasonCodes.includes("STOP_LOSS"))).toBe(true);
  });

  it("one invalid instance does not abort healthy instance evaluation", () => {
    const instances = [
      instance({
        id: "bad",
        name: "renamed-display",
        moduleRef: "totally-unknown-module",
        instrumentIds: [fx],
      }),
      instance({
        id: "good",
        name: "pulse-momentum-v1-fx",
        moduleRef: "pulse-momentum-v1",
        instrumentIds: [fx],
      }),
    ];
    const { signals, errors } = evaluateConcurrentInstances({
      instances,
      bars: [
        {
          instrumentId: fx,
          pairAddress: fx,
          receivedAt: "2026-10-28T16:00:00.000Z",
          priceUsd: "1.08",
          liquidityUsd: null,
          volume24hUsd: null,
          priceChangeM5Pct: "3",
          priceChangeH1Pct: "1",
          txnsM5Buys: null,
          txnsM5Sells: null,
          dataState: "DELAYED",
        },
      ],
      context: { config: DEFAULT_STRATEGY, openPositions: [], history: [] },
    });
    expect(errors.some((e) => e.strategyInstanceId === "bad")).toBe(true);
    expect(signals.some((s) => s.strategyInstanceId === "good")).toBe(true);
  });

  it("disabled market blocks entries not exits", () => {
    // Use a LIVE Solana pair so SENTINEL passes; MarketSelection is the admission under test.
    const sol = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
    const solPair: CyclePair = {
      source: "dexscreener",
      chainId: "solana",
      pairAddress: sol,
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
      priceChangeM5Pct: "3.5",
      priceChangeH1Pct: "1.2",
      priceChangeH24Pct: "1",
      txnsM5Buys: 80,
      txnsM5Sells: 20,
      observationId: "obs_sol",
      freshness: "LIVE",
      receivedAt: "2026-10-28T16:00:00.000Z",
    };
    const entry = {
      strategyInstanceId: "stratinst_crypto",
      strategyVersion: "pulse@1",
      moduleRef: "pulse-momentum-v1",
      reasonCodes: ["ENTRY_MOMENTUM"],
    };
    const blocked = planCycle(
      planInput({
        pairs: [solPair],
        marks: { [sol]: { priceUsd: "100", freshness: "LIVE" } },
        instanceIntents: [intentFor(entry.strategyInstanceId, sol, "ENTER")],
        marketEntryEnabled: new Map([["solana:spot:universe", false]]),
      }),
    );
    expect(blocked.orders.filter((o) => o.side === "BUY")).toHaveLength(0);
    expect(
      blocked.decisions.some(
        (d) =>
          d.reasonCodes.includes("MARKET_ENTRY_DISABLED") ||
          (d.output as { blockedBy?: string })?.blockedBy === "MARKET_SELECTION",
      ),
    ).toBe(true);

    const exitOk = planCycle(
      planInput({
        marketEntryEnabled: new Map([["solana:spot:universe", false]]),
        instanceIntents: [intentFor("stratinst_crypto", sol, "EXIT")],
        allocations: new Map([["stratinst_crypto::" + sol, { qty: "0.25", reservedExitQty: "0" }]]),
        positions: [
          { pairAddress: sol, baseSymbol: "SOL", baseQty: "0.25", avgCostUsd: "100", realizedPnlUsd: "0" },
        ],
        cashUsd: "9750",
        aggregateExposureUsd: "250",
        pairs: [solPair],
        marks: { [sol]: { priceUsd: "100", freshness: "LIVE" } },
      }),
    );
    expect(exitOk.orders.some((o) => o.side === "SELL")).toBe(true);
  });

  it("empty instance output does not invent unrelated auto-entry", () => {
    const pair = fxPair({ priceChangeM5Pct: "5", priceChangeH1Pct: "2" });
    const plan = planCycle(
      planInput({
        pairs: [pair],
        instanceIntents: [],
      }),
    );
    expect(plan.orders.filter((o) => o.side === "BUY")).toHaveLength(0);
    expect(
      plan.decisions.some(
        (d) =>
          d.reasonCodes.includes("STRATEGY_INSTANCE_GATING") ||
          d.reasonCodes.includes("NO_INTENT") ||
          (d.output as { blockedBy?: string })?.blockedBy === "STRATEGY_INSTANCE_ALLOCATION",
      ),
    ).toBe(true);
  });

  it("re-eval with same client identity does not duplicate accepted ENTERs in allocation", () => {
    const signal = {
      intent: "ENTER_LONG" as const,
      reasonCodes: ["ENTRY_MOMENTUM"],
      instrumentId: fx,
      pairAddress: fx,
      strategyInstanceId: "i1",
      strategyVersion: "pulse@1",
      moduleRef: "pulse-momentum-v1",
      accountId: "primary",
      artifactHash: null,
      sourceHash: null,
    };
    const deduped = toPlanIntents([signal, signal], { cycleId: "cyc_attr", accountId: "primary" });
    expect(deduped).toHaveLength(1);
    const a = allocateOpportunities({ signals: deduped, maxNewEntries: 1 });
    expect(a.accepted.filter((s) => s.action === "ENTER")).toHaveLength(1);
    const canonical = toCanonicalIntents([signal], { tradingEnvironment: "MARKET_DATA_PAPER" });
    expect(canonical[0]).toMatchObject({
      action: "ENTER",
      strategyInstanceId: "i1",
      accountId: "primary",
      tradingEnvironment: "MARKET_DATA_PAPER",
      instrumentId: fx,
    });
  });
});
