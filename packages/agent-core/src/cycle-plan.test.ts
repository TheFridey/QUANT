import { describe, expect, it } from "vitest";
import { admitAgainstPlan } from "./cycle-plan.js";
import type { DecisionDraft, ProposedOrder } from "./types.js";

function order(overrides: Partial<ProposedOrder>): ProposedOrder {
  return {
    clientOrderId: "cid_buy_a",
    pairAddress: "pairA",
    baseSymbol: "A",
    side: "BUY",
    intent: "ENTRY",
    qty: "10.00000000",
    observationId: "obs",
    reasonCodes: [],
    estimatedCostUsd: "100.00000000",
    estimatedNotionalUsd: "99.00000000",
    ...overrides,
  };
}

const reject = (pairAddress: string, reasonCodes: string[]): DecisionDraft =>
  ({ agent: "ATLAS", pairAddress, decision: "REJECT", reasonCodes, confidence: "1", input: {}, output: {}, modelVersion: "t", inputSource: "t", durationMs: 0 }) as unknown as DecisionDraft;

describe("admission against the cycle plan (audit F1)", () => {
  it("admits a planned entry at the planned quantity even if the re-check sizes it larger", () => {
    const result = admitAgainstPlan({ orders: [order({})] }, { orders: [order({ qty: "12.00000000" })], decisions: [] });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.qty).toBe("10.00000000");
    expect(result.records[0]?.result).toBe("ADMITTED");
  });

  it("uses the smaller re-check quantity and scales the reservation estimate", () => {
    const result = admitAgainstPlan({ orders: [order({})] }, { orders: [order({ qty: "5.00000000" })], decisions: [] });
    expect(result.orders[0]?.qty).toBe("5.00000000");
    expect(result.orders[0]?.estimatedCostUsd).toBe("50.00000000");
    expect(result.records[0]?.result).toBe("ADMITTED_REDUCED");
  });

  it("never executes an entry the cycle plan did not decide", () => {
    const result = admitAgainstPlan({ orders: [] }, { orders: [order({ clientOrderId: "cid_new" })], decisions: [] });
    expect(result.orders).toEqual([]);
    expect(result.records[0]?.result).toBe("NOT_IN_PLAN");
  });

  it("records a planned entry the re-check rejects, with the re-check's reason", () => {
    const result = admitAgainstPlan({ orders: [order({})] }, { orders: [], decisions: [reject("pairA", ["DATA_DELAYED"])] });
    expect(result.orders).toEqual([]);
    expect(result.records[0]).toMatchObject({ result: "REJECTED_AT_ADMISSION", reasonCodes: ["DATA_DELAYED"], plannedQty: "10.00000000" });
  });

  it("always admits risk-reducing exits, including ones that appeared only at admission", () => {
    const exit = order({ clientOrderId: "cid_exit", side: "SELL", intent: "EXIT" });
    const result = admitAgainstPlan({ orders: [] }, { orders: [exit], decisions: [] });
    expect(result.orders).toEqual([exit]);
    expect(result.records[0]?.result).toBe("ADMISSION_ONLY_EXIT");
  });

  it("falls back to the admission plan for legacy cycles without a stored plan", () => {
    const entry = order({});
    const result = admitAgainstPlan(null, { orders: [entry], decisions: [] });
    expect(result.orders).toEqual([entry]);
    expect(result.records[0]?.result).toBe("NO_SNAPSHOT");
  });
});
