import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_BOUNDS,
  shouldApplySnapshotRevision,
  summarizeSnapshotCost,
} from "./snapshot-cost.js";

describe("D29 snapshot cost helpers", () => {
  it("exposes explicit snapshot bounds (profile before optimising)", () => {
    expect(SNAPSHOT_BOUNDS.recentOrders).toBe(40);
    expect(SNAPSHOT_BOUNDS.funnelEvents).toBe(200);
    expect(SNAPSHOT_BOUNDS.closedTrades).toBe(200);
  });

  it("flags unbounded phases and slow totals", () => {
    const report = summarizeSnapshotCost([
      { name: "orders", elapsedMs: 12, rows: 40, bounded: true },
      { name: "legacy_scan", elapsedMs: 80, bounded: false },
    ]);
    expect(report.allBounded).toBe(false);
    expect(report.recommendations.some((r) => r.includes("unbounded"))).toBe(true);
    expect(report.recommendations.some((r) => r.includes("legacy_scan"))).toBe(true);
  });

  it("ignores stale snapshot revisions", () => {
    expect(shouldApplySnapshotRevision({ incomingRevision: 5, appliedRevision: 5 })).toBe(false);
    expect(shouldApplySnapshotRevision({ incomingRevision: 6, appliedRevision: 5 })).toBe(true);
  });
});
