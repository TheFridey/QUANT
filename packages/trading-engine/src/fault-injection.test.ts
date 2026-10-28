import { describe, expect, it } from "vitest";
import { reconcileOrders } from "./reconcile.js";
import { armOco, evaluateOco } from "./protection.js";

describe("fault injection regressions", () => {
  it("unknown broker exposure suspends entries and survives as durable issue signal", () => {
    const report = reconcileOrders({
      broker: [
        { clientOrderId: "ghost_fill", status: "FILLED", filledQty: "2", venue: "EXTERNAL" },
      ],
      ledger: [],
    });
    expect(report.ok).toBe(false);
    expect(report.suspendEntries).toBe(true);
    expect(report.issues.some((issue) => issue.kind === "UNKNOWN_EXPOSURE")).toBe(true);
  });

  it("qty mismatch suspends entries without inventing fills", () => {
    const report = reconcileOrders({
      broker: [{ clientOrderId: "o1", status: "FILLED", filledQty: "5", venue: "EXTERNAL" }],
      ledger: [{ clientOrderId: "o1", status: "FILLED", filledQty: "2", venue: "EXTERNAL" }],
    });
    expect(report.suspendEntries).toBe(true);
    expect(report.issues.some((issue) => issue.kind === "QTY_MISMATCH")).toBe(true);
  });

  it("clean paper self-truth reconcile does not suspend", () => {
    const report = reconcileOrders({
      broker: [{ clientOrderId: "p1", status: "FILLED", filledQty: "1", venue: "PAPER" }],
      ledger: [{ clientOrderId: "p1", status: "FILLED", filledQty: "1", venue: "PAPER" }],
    });
    expect(report.ok).toBe(true);
    expect(report.suspendEntries).toBe(false);
  });

  it("OCO race: first trigger cancels sibling even under gap", () => {
    const group = armOco({
      groupId: "oco_fault",
      positionKey: "primary:pair",
      stopPriceUsd: "90",
      takeProfitPriceUsd: "120",
      origin: "SYNTHETIC_ENGINE",
    });
    const first = evaluateOco(group, "80");
    expect(first.triggered?.kind).toBe("STOP");
    expect(first.cancelled).toHaveLength(1);
    const second = evaluateOco(first.group, "130");
    expect(second.triggered).toBeNull();
    expect(second.raceSuppressed).toBe(true);
  });
});
