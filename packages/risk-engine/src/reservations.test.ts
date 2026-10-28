import { describe, expect, it } from "vitest";
import { ReservationLedger, admitParallel } from "./reservations.js";

function budget() {
  return {
    cashAvailableUsd: "1000.00000000",
    exposureCapUsd: "500.00000000",
    exposureUsedUsd: "0.00000000",
    slotsAvailable: 2,
    slotsUsed: 0,
    riskBudgetUsd: "100.00000000",
    riskUsedUsd: "0.00000000",
  };
}

function req(id: string, exposure = "300.00000000"): Parameters<ReservationLedger["reserve"]>[0] {
  return {
    id: `res_${id}`,
    accountId: "primary",
    clientOrderId: id,
    cashUsd: exposure,
    exposureUsd: exposure,
    slots: 1,
    riskUsd: "40.00000000",
  };
}

describe("atomic risk reservations", () => {
  it("admits until budgets exhaust and rejects the overflow without exceeding caps", () => {
    const ledger = new ReservationLedger(budget());
    const first = ledger.reserve(req("a", "100.00000000"));
    const second = ledger.reserve(req("b", "100.00000000"));
    const third = ledger.reserve(req("c", "100.00000000"));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(["MAX_POSITIONS", "AGGREGATE_EXPOSURE", "RISK_BUDGET"]).toContain(third.reason);
    expect(ledger.snapshot().slotsUsed).toBe(2);
    expect(Number(ledger.snapshot().exposureUsedUsd)).toBeLessThanOrEqual(500);
  });

  it("parallel admission under a single ledger never exceeds exposure or slots", () => {
    const ledger = new ReservationLedger(budget());
    const results = admitParallel(ledger, [req("p1", "400"), req("p2", "400"), req("p3", "400")]);
    const held = results.filter((row) => row.result.ok);
    expect(held.length).toBe(1);
    expect(Number(ledger.snapshot().exposureUsedUsd)).toBeLessThanOrEqual(500);
  });

  it("releases unused reservation on cancel and restores budgets", () => {
    const ledger = new ReservationLedger(budget());
    expect(ledger.reserve(req("x")).ok).toBe(true);
    expect(ledger.release("x")?.status).toBe("RELEASED");
    expect(ledger.snapshot().slotsUsed).toBe(0);
    expect(ledger.snapshot().cashAvailableUsd).toBe("1000.00000000");
    expect(ledger.reserve(req("y")).ok).toBe(true);
  });

  it("releases partial unused after consume", () => {
    const ledger = new ReservationLedger(budget());
    expect(ledger.reserve(req("partial", "200")).ok).toBe(true);
    expect(ledger.consume("partial")?.status).toBe("CONSUMED");
    ledger.releasePartial("partial", {
      cashUsd: "50.00000000",
      exposureUsd: "50.00000000",
      riskUsd: "10.00000000",
      slots: 0,
    });
    expect(Number(ledger.snapshot().cashAvailableUsd)).toBeCloseTo(850, 4);
  });
});
