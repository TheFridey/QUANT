import { CLIENT_ORDER_ID_PATTERN, DEFAULT_STRATEGY, d, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { mergeDecisions, planCycle, type PlanInput } from "./plan.js";
import { allocateOpportunities, toPlanIntents, type AttributedSignal } from "./strategy-instances.js";
import type { DecisionDraft, PlanIntent } from "./types.js";

const fx = "fx:EURUSD";
const gbp = "fx:GBPUSD";

function pair(pairAddress = fx, overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "fixture",
    chainId: "fx",
    pairAddress,
    dexId: null,
    url: null,
    baseAddress: pairAddress,
    baseSymbol: pairAddress.slice(3, 6),
    baseName: pairAddress,
    quoteAddress: "USD",
    quoteSymbol: "USD",
    priceUsd: "1.00",
    liquidityUsd: "5000000",
    volume24hUsd: "100000000",
    volume5mUsd: "1000000",
    priceChangeM5Pct: "0.1",
    priceChangeH1Pct: "0.1",
    priceChangeH24Pct: null,
    txnsM5Buys: null,
    txnsM5Sells: null,
    observationId: `obs_${pairAddress}`,
    freshness: "LIVE",
    receivedAt: "2026-10-28T16:00:00.000Z",
    ...overrides,
  };
}

function signal(strategyInstanceId: string, pairAddress: string, intent: AttributedSignal["intent"]): AttributedSignal {
  return {
    intent,
    reasonCodes: ["TEST"],
    instrumentId: pairAddress,
    pairAddress,
    strategyInstanceId,
    strategyVersion: `${strategyInstanceId}@1`,
    moduleRef: "pulse-momentum-v1",
    accountId: "acct",
    artifactHash: null,
    sourceHash: null,
  };
}

function intents(...signals: AttributedSignal[]): PlanIntent[] {
  return toPlanIntents(signals, { cycleId: "cyc_multi", accountId: "acct" });
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  const pairs = overrides.pairs ?? [pair(fx), pair(gbp)];
  return {
    cycleId: "cyc_multi",
    accountId: "acct",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    positions: [],
    pairs,
    marks: Object.fromEntries(pairs.map((p) => [p.pairAddress, { priceUsd: p.priceUsd, freshness: "LIVE" as const }])),
    dailyPnlUsd: "0",
    flatten: false,
    operator: null,
    highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    aggregateExposureUsd: "0",
    now: new Date("2026-10-28T16:00:00.000Z"),
    instanceIntents: [],
    ...overrides,
  };
}

const held = (qty: string, pairAddress = fx) => ({
  pairAddress,
  baseSymbol: pairAddress.slice(3, 6),
  baseQty: qty,
  avgCostUsd: "1.00",
  realizedPnlUsd: "0",
});

describe("multi-intent planner (F04 / Stages E–F)", () => {
  it("two instances entering the same symbol produce two independent, broker-safe orders", () => {
    const planned = intents(signal("inst_a", fx, "ENTER_LONG"), signal("inst_b", fx, "ENTER_LONG"));
    const plan = planCycle(input({ instanceIntents: planned, maxNewEntries: 1 }));
    const buys = plan.orders.filter((o) => o.side === "BUY");
    expect(buys.map((o) => o.strategyInstanceId)).toEqual(["inst_a", "inst_b"]);
    expect(new Set(buys.map((o) => o.clientOrderId)).size).toBe(2);
    for (const order of buys) {
      expect(order.clientOrderId).toMatch(CLIENT_ORDER_ID_PATTERN);
      expect(order.ownerScope).toBe("STRATEGY");
      expect(order.intentId).toMatch(/^int_/);
      expect(d(order.estimatedCostUsd!).gt(d(order.estimatedNotionalUsd!))).toBe(true);
    }
    // B joins a pair A opened this cycle — it does not consume a second net-position slot.
    expect(plan.intentOutcomes.filter((o) => o.status === "ADMITTED")).toHaveLength(2);
  });

  it("replanning the same cycle reproduces identical client order ids (idempotent retry)", () => {
    const planned = intents(signal("inst_a", fx, "ENTER_LONG"));
    const first = planCycle(input({ instanceIntents: planned }));
    const second = planCycle(input({ instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG")) }));
    expect(second.orders[0]!.clientOrderId).toBe(first.orders[0]!.clientOrderId);
  });

  it("an instance already holding the symbol does not pyramid; another instance may still enter", () => {
    const planned = intents(signal("inst_a", fx, "ENTER_LONG"), signal("inst_b", fx, "ENTER_LONG"));
    const plan = planCycle(
      input({
        instanceIntents: planned,
        positions: [held("100")],
        cashUsd: "9900",
        aggregateExposureUsd: "100",
        allocations: new Map([["inst_a::" + fx, { qty: "100", reservedExitQty: "0" }]]),
      }),
    );
    expect(plan.orders.map((o) => o.strategyInstanceId)).toEqual(["inst_b"]);
    expect(plan.intentOutcomes.find((o) => o.strategyInstanceId === "inst_a")).toMatchObject({
      status: "REJECTED",
      reason: "INSTANCE_ALREADY_OWNS",
    });
  });

  it("pending entry in flight for the same owner+pair is rejected, not duplicated", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG")),
        pendingEntryKeys: new Set(["inst_a::" + fx]),
      }),
    );
    expect(plan.orders).toHaveLength(0);
    expect(plan.intentOutcomes[0]).toMatchObject({ status: "REJECTED", reason: "PENDING_ENTRY_IN_FLIGHT" });
  });
});

describe("sized instance admission (F02 / Stage H)", () => {
  it("budget 100 with 99 committed cannot fund a 500 order: rejected, never oversized", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG")),
        instanceAvailableUsd: new Map([["inst_a", "1"]]),
      }),
    );
    expect(plan.orders).toHaveLength(0);
    expect(plan.intentOutcomes[0]).toMatchObject({ status: "REJECTED", reason: "INSTANCE_BUDGET_EXHAUSTED" });
  });

  it("resizes an account-sized 500 entry down to the instance's remaining 300, including fees/slippage", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG")),
        instanceAvailableUsd: new Map([["inst_a", "300"]]),
      }),
    );
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0]!;
    expect(d(order.estimatedCostUsd!).lte(d("300"))).toBe(true);
    expect(d(order.estimatedNotionalUsd!).gt(d("250"))).toBe(true);
    expect(plan.intentOutcomes[0]).toMatchObject({ status: "ADMITTED", reason: "INSTANCE_BUDGET_RESIZED" });
  });

  it("in-cycle spend is deducted: the same instance's second entry sees the reduced budget", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG"), signal("inst_a", gbp, "ENTER_LONG")),
        instanceAvailableUsd: new Map([["inst_a", "520"]]),
      }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.intentOutcomes[1]).toMatchObject({ status: "REJECTED", reason: "INSTANCE_BUDGET_EXHAUSTED" });
  });

  it("missing instance budget entry fails closed", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG")),
        instanceAvailableUsd: new Map(),
      }),
    );
    expect(plan.orders).toHaveLength(0);
  });
});

describe("fair admission (Stage P)", () => {
  it("a budget-rejected candidate does not consume another strategy's slot", () => {
    const ordered = allocateOpportunities({
      signals: intents(signal("inst_a", fx, "ENTER_LONG"), signal("inst_b", gbp, "ENTER_LONG")),
      maxNewEntries: 1,
    }).ordered;
    const plan = planCycle(
      input({
        instanceIntents: ordered,
        maxNewEntries: 1,
        instanceAvailableUsd: new Map([
          ["inst_a", "0"],
          ["inst_b", "1000"],
        ]),
      }),
    );
    expect(plan.orders.map((o) => o.strategyInstanceId)).toEqual(["inst_b"]);
  });

  it("entries beyond the slot limit are DEFERRED with WAITING_FAIR_ALLOCATION", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG"), signal("inst_b", gbp, "ENTER_LONG")),
        maxNewEntries: 1,
      }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.intentOutcomes[1]).toMatchObject({ status: "DEFERRED", reason: "WAITING_FAIR_ALLOCATION" });
  });
});

describe("ownership-aware exits (F03 / Stage L)", () => {
  const owned = new Map([
    ["inst_a::" + fx, { qty: "3", reservedExitQty: "0" }],
    ["inst_b::" + fx, { qty: "7", reservedExitQty: "0" }],
  ]);

  it("A owns 3, B owns 7: A EXIT closes exactly 3 and is attributed to A", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "EXIT_LONG")),
        positions: [held("10")],
        cashUsd: "9990",
        aggregateExposureUsd: "10",
        allocations: owned,
      }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]).toMatchObject({ side: "SELL", qty: "3.00000000", strategyInstanceId: "inst_a", ownerScope: "STRATEGY" });
  });

  it("quantity already reserved by an in-flight exit is not sold twice", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "EXIT_LONG")),
        positions: [held("10")],
        allocations: new Map([["inst_a::" + fx, { qty: "3", reservedExitQty: "3" }]]),
      }),
    );
    expect(plan.orders).toHaveLength(0);
    expect(plan.intentOutcomes[0]).toMatchObject({ status: "DEFERRED", reason: "EXIT_QTY_RESERVED" });
  });

  it("an instance without an allocation cannot sell someone else's quantity", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_c", fx, "EXIT_LONG")),
        positions: [held("10")],
        allocations: owned,
      }),
    );
    expect(plan.orders).toHaveLength(0);
    expect(plan.intentOutcomes[0]).toMatchObject({ status: "REJECTED", reason: "ALLOCATION_NOT_OWNED" });
  });

  it("owner exits wait while a net close for the pair is in flight", () => {
    const plan = planCycle(
      input({
        instanceIntents: intents(signal("inst_a", fx, "EXIT_LONG")),
        positions: [held("10")],
        allocations: owned,
        pendingNetCloseByPair: new Set([fx]),
      }),
    );
    expect(plan.orders).toHaveLength(0);
    expect(plan.intentOutcomes[0]).toMatchObject({ status: "DEFERRED", reason: "NET_CLOSE_IN_FLIGHT" });
  });

  it("flatten is a NET-scope order for the full position and suppresses owner exits that cycle", () => {
    const plan = planCycle(
      input({
        flatten: true,
        instanceIntents: intents(signal("inst_a", fx, "EXIT_LONG")),
        positions: [held("10")],
        allocations: owned,
      }),
    );
    const sells = plan.orders.filter((o) => o.side === "SELL");
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ qty: "10.00000000", ownerScope: "ACCOUNT_FLATTEN", strategyInstanceId: null });
    expect(plan.intentOutcomes.find((o) => o.strategyInstanceId === "inst_a")).toMatchObject({ status: "DEFERRED" });
  });

  it("operator ALLOCATION close sells only that owner's quantity", () => {
    const plan = planCycle(
      input({
        operator: { side: "SELL", pairAddress: fx, scope: "ALLOCATION", strategyInstanceId: "inst_b", clientIntentId: "op-close-b-0001" },
        positions: [held("10")],
        allocations: owned,
      }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]).toMatchObject({ side: "SELL", qty: "7.00000000", ownerScope: "STRATEGY", strategyInstanceId: "inst_b" });
  });

  it("operator NET close sells the full net with OPERATOR scope", () => {
    const plan = planCycle(
      input({
        operator: { side: "SELL", pairAddress: fx, clientIntentId: "op-close-net-0001" },
        positions: [held("10")],
        allocations: owned,
      }),
    );
    expect(plan.orders[0]).toMatchObject({ side: "SELL", qty: "10.00000000", ownerScope: "OPERATOR", strategyInstanceId: null });
  });
});

describe("decision persistence (Stage G)", () => {
  it("merges same agent+pair rows so no intent's audit is overwritten", () => {
    const base: DecisionDraft = {
      agent: "ATLAS",
      modelVersion: "t",
      pairAddress: fx,
      decision: "REJECT",
      confidence: "1",
      reasonCodes: ["INSTANCE_BUDGET_EXHAUSTED"],
      input: {},
      output: { intentId: "int_a" },
    };
    const merged = mergeDecisions([
      base,
      { ...base, decision: "ACT", reasonCodes: ["SIZE_COMPUTED"], output: { intentId: "int_b" } },
      { ...base, agent: "EXECUTOR", output: { intentId: "int_b" } },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.decision).toBe("ACT");
    expect((merged[0]!.output.intents as Array<{ intentId: string }>).map((i) => i.intentId)).toEqual(["int_a", "int_b"]);
    expect(merged[0]!.reasonCodes).toEqual(["INSTANCE_BUDGET_EXHAUSTED", "SIZE_COMPUTED"]);
  });

  it("planner output never has two rows for the same agent and pair", () => {
    const plan = planCycle(
      input({ instanceIntents: intents(signal("inst_a", fx, "ENTER_LONG"), signal("inst_b", fx, "ENTER_LONG")) }),
    );
    const keys = plan.decisions.map((row) => `${row.agent}|${row.pairAddress}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
