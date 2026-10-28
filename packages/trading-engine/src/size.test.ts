import { describe, expect, it } from "vitest";
import { admitNotionalAgainstMinOrder, maxEntryNotional } from "./size.js";

describe("sizing admission", () => {
  it("never rounds a risk-sized notional up through the minimum order floor", () => {
    const cap = maxEntryNotional({
      cashUsd: "100.00000000",
      equityUsd: "100.00000000",
      liquidityUsd: "1000000",
      maxPositionPctEquity: "5",
      maxParticipationPctLiquidity: "1",
      feeBps: "30",
      maxSlippageBps: "150",
    });
    expect(Number(cap)).toBeLessThanOrEqual(5);
    const admitted = admitNotionalAgainstMinOrder({
      riskSizedNotionalUsd: cap,
      minOrderNotionalUsd: "5",
    });
    // After fee haircut inside maxEntryNotional cash path, or exact 5 — either reject or equal; never inflate.
    if (!admitted.ok) {
      expect(admitted.reason).toBe("MIN_ORDER_EXCEEDS_RISK_CAP");
    } else {
      expect(Number(admitted.notionalUsd)).toBeLessThanOrEqual(Number(cap));
    }
    const below = admitNotionalAgainstMinOrder({
      riskSizedNotionalUsd: "4.90000000",
      minOrderNotionalUsd: "5",
    });
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.reason).toBe("MIN_ORDER_EXCEEDS_RISK_CAP");
  });

  it("accepts risk-sized notional at or above the minimum", () => {
    const ok = admitNotionalAgainstMinOrder({
      riskSizedNotionalUsd: "25.00000000",
      minOrderNotionalUsd: "25",
    });
    expect(ok).toEqual({ ok: true, notionalUsd: "25.00000000" });
  });
});
