import { describe, expect, it } from "vitest";
import { cashMatchesLedger, detectDuplicateExposure, reconcileOrders } from "./reconcile.js";

describe("reconciliation", () => {
  it("suspends entries on unknown broker exposure after ack without ledger", () => {
    const report = reconcileOrders({
      broker: [{ clientOrderId: "c1", status: "ACKED", filledQty: "0", venue: "SANDBOX" }],
      ledger: [],
    });
    expect(report.ok).toBe(false);
    expect(report.suspendEntries).toBe(true);
    expect(report.issues.some((i) => i.kind === "UNKNOWN_EXPOSURE")).toBe(true);
  });

  it("flags qty mismatch and duplicate client ids", () => {
    const report = reconcileOrders({
      broker: [{ clientOrderId: "c2", status: "FILLED", filledQty: "2", venue: "PAPER" }],
      ledger: [{ clientOrderId: "c2", status: "FILLED", filledQty: "1", venue: "PAPER" }],
    });
    expect(report.issues.some((i) => i.kind === "QTY_MISMATCH")).toBe(true);
    expect(detectDuplicateExposure([
      { clientOrderId: "x", status: "FILLED", filledQty: "1", venue: "PAPER" },
      { clientOrderId: "x", status: "FILLED", filledQty: "1", venue: "PAPER" },
    ])).toEqual(["x"]);
  });

  it("verifies cash equals cash-affecting ledger sum", () => {
    expect(
      cashMatchesLedger({
        accountCashUsd: "90.00000000",
        cashAffectingLines: ["100.00000000", "-10.00000000"],
      }).ok,
    ).toBe(true);
  });
});
