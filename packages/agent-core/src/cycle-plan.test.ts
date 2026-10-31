import { describe, expect, it } from "vitest";
import {
  admitAgainstPlan,
  applyAdmissionToDecisions,
  applyAdmissionToOutcomes,
  InvalidCyclePlanError,
  parseCyclePlanSnapshot,
} from "./cycle-plan.js";
import type { DecisionDraft, IntentOutcome, ProposedOrder } from "./types.js";

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
    const result = admitAgainstPlan(
      { orders: [order({})] },
      { orders: [order({ qty: "5.00000000", estimatedCostUsd: "50.00000000", estimatedNotionalUsd: "49.50000000" })], decisions: [] },
    );
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

  it("prices the reservation at the admission quote when the price rose (planned quantity used)", () => {
    // Planned at $10/unit; at admission the re-check quotes $11/unit for 12 units.
    const result = admitAgainstPlan(
      { orders: [order({})] },
      { orders: [order({ qty: "12.00000000", estimatedCostUsd: "132.00000000", estimatedNotionalUsd: "131.00000000" })], decisions: [] },
    );
    expect(result.orders[0]?.qty).toBe("10.00000000");
    expect(result.orders[0]?.estimatedCostUsd).toBe("110.00000000");
    expect(result.orders[0]?.estimatedNotionalUsd).toBe("109.16666667");
  });

  it("prices the reservation at the admission quote when the price rose (reduced quantity)", () => {
    const result = admitAgainstPlan(
      { orders: [order({})] },
      { orders: [order({ qty: "9.00000000", estimatedCostUsd: "99.00000000", estimatedNotionalUsd: "98.10000000" })], decisions: [] },
    );
    expect(result.orders[0]?.qty).toBe("9.00000000");
    expect(result.orders[0]?.estimatedCostUsd).toBe("99.00000000");
    expect(result.orders[0]?.estimatedNotionalUsd).toBe("98.10000000");
  });

  it("keeps the plan-time price when the price fell, so the reservation never shrinks below the plan", () => {
    const result = admitAgainstPlan(
      { orders: [order({})] },
      { orders: [order({ qty: "10.00000000", estimatedCostUsd: "80.00000000", estimatedNotionalUsd: "79.00000000" })], decisions: [] },
    );
    expect(result.orders[0]?.estimatedCostUsd).toBe("100.00000000");
  });

  it("fails closed on a stored plan with a non-positive quantity", () => {
    expect(() => admitAgainstPlan({ orders: [order({ qty: "0" })] }, { orders: [order({})], decisions: [] })).toThrow(InvalidCyclePlanError);
    expect(() => admitAgainstPlan({ orders: [order({ qty: "-1" })] }, { orders: [order({})], decisions: [] })).toThrow(InvalidCyclePlanError);
  });

  it("parses a stored plan and rejects malformed ones", () => {
    const good = { cycleId: "c", plannedAt: "2026-10-31T00:00:00.000Z", decisions: [], orders: [order({})], watchlist: [], intentOutcomes: [] };
    expect(parseCyclePlanSnapshot(good)).toBe(good);
    expect(() => parseCyclePlanSnapshot({ ...good, orders: "x" })).toThrow(InvalidCyclePlanError);
    expect(() => parseCyclePlanSnapshot({ ...good, orders: [order({ qty: "NaN" })] })).toThrow(InvalidCyclePlanError);
    expect(() => parseCyclePlanSnapshot(null)).toThrow(InvalidCyclePlanError);
  });

  it("records a planned exit the re-check no longer needs as EXIT_NO_LONGER_NEEDED", () => {
    const exit = order({ clientOrderId: "cid_exit", side: "SELL", intent: "EXIT" });
    const result = admitAgainstPlan({ orders: [exit] }, { orders: [], decisions: [] });
    expect(result.orders).toEqual([]);
    expect(result.records[0]).toMatchObject({ result: "EXIT_NO_LONGER_NEEDED", reasonCodes: ["EXIT_NO_LONGER_NEEDED"] });
  });

  it("admits planned and unplanned FLATTEN and OPERATOR sells", () => {
    const flatten = order({ clientOrderId: "cid_flat", side: "SELL", intent: "FLATTEN" });
    const operator = order({ clientOrderId: "cid_op", side: "SELL", intent: "OPERATOR", pairAddress: "pairB" });
    const result = admitAgainstPlan({ orders: [flatten] }, { orders: [flatten, operator], decisions: [] });
    expect(result.orders).toEqual([flatten, operator]);
    expect(result.records.map((row) => row.result)).toEqual(["ADMITTED", "ADMISSION_ONLY_EXIT"]);
  });

  it("rewrites intent outcomes to what was admitted", () => {
    const outcome = (clientOrderId: string): IntentOutcome => ({
      intentId: clientOrderId,
      idempotencyKey: clientOrderId,
      clientOrderId,
      strategyInstanceId: "inst",
      pairAddress: "pairA",
      action: "ENTER",
      status: "ADMITTED",
      reason: "ADMITTED",
      sizedQty: "12.00000000",
      sizedNotionalUsd: "120.00000000",
    });
    const admission = admitAgainstPlan(
      { orders: [order({})] },
      { orders: [order({ qty: "12.00000000" }), order({ clientOrderId: "cid_new" })], decisions: [] },
    );
    const [kept, dropped] = applyAdmissionToOutcomes([outcome("cid_buy_a"), outcome("cid_new")], admission);
    expect(kept).toMatchObject({ status: "ADMITTED", sizedQty: "10.00000000", sizedNotionalUsd: admission.orders[0]?.estimatedNotionalUsd });
    expect(dropped).toMatchObject({ status: "REJECTED", reason: "NOT_IN_CYCLE_PLAN", sizedQty: null });
  });

  it("turns an EXECUTOR ACT row into REJECT when nothing for the pair was admitted", () => {
    const act = { ...reject("pairB", []), agent: "EXECUTOR", decision: "ACT" } as DecisionDraft;
    const admission = admitAgainstPlan({ orders: [] }, { orders: [order({ clientOrderId: "cid_new", pairAddress: "pairB" })], decisions: [] });
    const [row] = applyAdmissionToDecisions([act], admission.records);
    expect(row).toMatchObject({ decision: "REJECT", reasonCodes: ["NOT_IN_CYCLE_PLAN"] });
    expect((row?.output as { admission: unknown[] }).admission).toHaveLength(1);
  });
});
