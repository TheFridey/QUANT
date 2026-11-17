import { describe, expect, it } from "vitest";
import { assessLegacyRetirement, aurumReadiness } from "./aurum-readiness.js";

describe("AURUM read-only readiness and retirement proposal", () => {
  it("never grants eligibility or fabricates account/provider observations", () => {
    const result = aurumReadiness();
    expect(result.executionEligible).toBe(false);
    expect(result.researchEligible).toBe(false);
    expect(result.account).toBeNull();
    expect(result.balanceGbp).toBeNull();
    expect(result.goldMarketData.bid).toBeNull();
    result.blockers.length = 0;
    expect(aurumReadiness().blockers.length).toBeGreaterThan(0);
  });
  const flat = { openPositions: 0, pendingOrders: 0, unsettledFills: 0, protectiveActions: 0, researchNeedsCrypto: false };
  it("requires complete zero-obligation evidence, preserving exits even in the proposal", () => {
    expect(assessLegacyRetirement(flat)).toMatchObject({ eligibleForOperatorApproval: true, activated: false, proposed: { protectiveExitEnabled: true } });
    for (const key of ["openPositions", "pendingOrders", "unsettledFills", "protectiveActions"] as const) {
      for (const value of [null, 1, -1, NaN, Infinity, 0.5]) {
        expect(assessLegacyRetirement({ ...flat, [key]: value }).eligibleForOperatorApproval).toBe(false);
      }
    }
    for (const value of [null, true]) expect(assessLegacyRetirement({ ...flat, researchNeedsCrypto: value }).eligibleForOperatorApproval).toBe(false);
  });
});
