import { describe, expect, it } from "vitest";
import { ObservabilityRegistry } from "./observability.js";

describe("observability registry (D52)", () => {
  it("records counters by category without inventing values", () => {
    const registry = new ObservabilityRegistry();
    registry.record({
      category: "provider_api",
      name: "gateway_fx_fetch",
      value: 1,
      unit: "call",
      meta: { readiness: { frankfurter_fx: "READY" } },
    });
    registry.record({
      category: "portfolio_reconciliation",
      name: "reconcile_clean",
      value: 0,
      unit: "issues",
    });
    const totals = registry.totalsByCategory();
    expect(totals.provider_api).toBe(1);
    expect(totals.portfolio_reconciliation).toBe(0);
    expect(registry.snapshot()).toHaveLength(2);
    registry.clear();
    expect(registry.snapshot()).toHaveLength(0);
  });
});
