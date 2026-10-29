import { describe, expect, it } from "vitest";
import { protectionForPosition } from "./operator-capacity.service.js";
import { classifyNoTradeReason, summarizeNoTrades } from "./why-no-trades.js";

describe("why-no-trades classification", () => {
  it("prefers statusReason over reason codes and higher-precedence families over NO_EDGE", () => {
    expect(classifyNoTradeReason("INSTANCE_BUDGET_EXHAUSTED: 0 left", ["NO_EDGE"])).toBe("INSTANCE_BUDGET_EXHAUSTED");
    expect(classifyNoTradeReason(null, ["NO_EDGE", "ENTRIES_SUSPENDED"])).toBe("SAFETY_SUSPENSION");
    expect(classifyNoTradeReason("free text", ["MARKET_ENTRY_DISABLED"])).toBe("MARKET_NOT_SELECTED");
    expect(classifyNoTradeReason(null, ["DATA_OK"])).toBeNull();
  });

  it("attributes one decisive family per cycle/pair and skips acted evaluations", () => {
    const at = new Date("2026-10-29T00:00:00Z");
    const summary = summarizeNoTrades({
      decisions: [
        { cycleId: "c1", agent: "PULSE", pairAddress: "p1", decision: "HOLD", reasonCodes: ["NO_EDGE"], createdAt: at },
        { cycleId: "c1", agent: "ATLAS", pairAddress: "p1", decision: "REJECT", reasonCodes: ["DATA_STALE"], createdAt: at },
        { cycleId: "c2", agent: "PULSE", pairAddress: "p1", decision: "HOLD", reasonCodes: ["NO_EDGE"], createdAt: at },
        { cycleId: "c2", agent: "EXECUTOR", pairAddress: "p2", decision: "ACT", reasonCodes: ["ORDER_PROPOSED"], createdAt: at },
      ],
      intents: [],
      active: [],
    });
    expect(summary.evaluations).toBe(3);
    expect(summary.actedEvaluations).toBe(1);
    expect(summary.families.map((row) => [row.id, row.count])).toEqual([
      ["STALE_DATA", 1],
      ["NO_ELIGIBLE_SIGNAL", 1],
    ]);
    expect(summary.primary?.basis).toBe("MOST_FREQUENT_IN_WINDOW");
  });
});

describe("protectionForPosition", () => {
  const base = { positionKey: "acct:pair", lifecycleId: "L1", localQty: "5" };
  const leg = (overrides: Record<string, unknown>) => ({
    positionKey: "acct:pair",
    lifecycleId: "L1",
    kind: "STOP",
    status: "ARMED",
    ackState: "ACKED",
    remainingQty: "5",
    protectedQty: "5",
    ...overrides,
  });

  it("is PROTECTED only when an ARMED+ACKED stop covers the full qty", () => {
    expect(protectionForPosition({ ...base, legs: [leg({})] }).status).toBe("PROTECTED");
    expect(protectionForPosition({ ...base, legs: [leg({ remainingQty: "4", protectedQty: "4" })] }).status).toBe("UNPROTECTED");
    expect(protectionForPosition({ ...base, legs: [leg({ kind: "TAKE_PROFIT" })] }).status).toBe("UNPROTECTED");
  });

  it("reports REQUESTED for desired/submitted legs and ignores other lifecycles", () => {
    expect(protectionForPosition({ ...base, legs: [leg({ ackState: "SUBMITTED" })] }).status).toBe("REQUESTED");
    expect(protectionForPosition({ ...base, legs: [leg({ lifecycleId: "L0" })] }).status).toBe("UNPROTECTED");
    expect(protectionForPosition({ ...base, legs: [leg({ ackState: "DESIRED_ONLY", status: "CANCELLED" })] }).status).toBe("UNPROTECTED");
  });
});
