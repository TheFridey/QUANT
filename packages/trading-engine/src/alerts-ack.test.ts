import { describe, expect, it } from "vitest";
import { reconcileOrders } from "./reconcile.js";

/**
 * Alert ACK ≠ resolve safety suspension.
 * Reconcile must clear suspension via clean state — not via DurableAlert.acked alone.
 */
describe("alert ACK vs safety suspension", () => {
  it("unknown exposure keeps suspendEntries true regardless of any ack flag", () => {
    const dirty = reconcileOrders({
      broker: [{ clientOrderId: "ghost", status: "FILLED", filledQty: "1", venue: "EXTERNAL" }],
      ledger: [],
    });
    expect(dirty.suspendEntries).toBe(true);

    // Simulating an operator ACK does not change reconcile math.
    const stillDirty = reconcileOrders({
      broker: [{ clientOrderId: "ghost", status: "FILLED", filledQty: "1", venue: "EXTERNAL" }],
      ledger: [],
    });
    expect(stillDirty.suspendEntries).toBe(true);
    expect(stillDirty.ok).toBe(false);
  });

  it("only a clean reconcile report clears the path to resolve suspension", () => {
    const clean = reconcileOrders({
      broker: [{ clientOrderId: "p1", status: "FILLED", filledQty: "1", venue: "PAPER" }],
      ledger: [{ clientOrderId: "p1", status: "FILLED", filledQty: "1", venue: "PAPER" }],
    });
    expect(clean.ok).toBe(true);
    expect(clean.suspendEntries).toBe(false);
  });
});
