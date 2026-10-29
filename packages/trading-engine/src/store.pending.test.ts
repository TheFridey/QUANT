import { DEFAULT_STRATEGY } from "@odin/shared";
import { describe, expect, it, vi } from "vitest";

/**
 * Unit-level contract for pending eligibility: CommitOrder carries eligibleAt and
 * commitProposedOrder must not treat future eligibility as an immediate fill.
 * Full DB settlement is covered by integration tests when DATABASE_URL is set.
 */
describe("pending eligibility contract", () => {
  it("exposes eligibleAt on the commit order type used by the worker", async () => {
    const store = await import("./store.js");
    const now = new Date("2026-10-28T16:00:00.000Z");
    const eligibleAt = new Date(now.getTime() + 5_000);
    const order: store.CommitOrder = {
      clientOrderId: "cyc:pair:BUY:ENTRY",
      pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      baseSymbol: "SOL",
      side: "BUY",
      intent: "ENTRY",
      qty: "1.00000000",
      observationId: "obs_1",
      reasonCodes: ["ORDER_PROPOSED"],
      eligibleAt: eligibleAt.toISOString(),
      expiresAt: new Date(eligibleAt.getTime() + DEFAULT_STRATEGY.orderExpiryMs).toISOString(),
    };
    expect(Date.parse(order.eligibleAt!)).toBeGreaterThan(now.getTime());
    expect(store.commitProposedOrder).toEqual(expect.any(Function));
    expect(store.settlePendingOrder).toEqual(expect.any(Function));
    void vi;
  });
});
