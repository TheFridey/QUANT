import { describe, expect, it } from "vitest";
import { executeRetention, type ExecuteOptions } from "./retention-executor.js";
import { APPROVED_RETENTION_POLICY_HASHES, PROPOSED_RETENTION, policyHash } from "./retention-policy.js";

// Guard regression: no database connection or fixture truncation is needed to prove zero mutation.
// Former deletion success-path proofs belong to original 34c05f2 and are not current readiness evidence.
describe("TITANIUM retention deletion quarantine", () => {
  it("refuses the real policy and an injected alternate approval before touching any resource", async () => {
    let touched = false;
    const options = new Proxy({ policy: PROPOSED_RETENTION, expectedPolicyHash: policyHash(PROPOSED_RETENTION), approvedPolicyHashes: [policyHash(PROPOSED_RETENTION)] }, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        touched = true;
        throw new Error("resource accessed before policy refusal");
      },
    }) as unknown as ExecuteOptions;
    expect(APPROVED_RETENTION_POLICY_HASHES).toEqual([]);
    expect(await executeRetention(options)).toMatchObject({ ok: false, reason: "POLICY_NOT_APPROVED" });
    expect(touched).toBe(false);
  });
  it("refuses MarketObservation even if a caller removes its block", async () => {
    const policy = PROPOSED_RETENTION.map(p => p.table === "MarketObservation" ? { ...p, executorBlocked: undefined } : p);
    expect(await executeRetention({ policy, expectedPolicyHash: policyHash(policy) } as ExecuteOptions)).toMatchObject({ ok: false, reason: "MARKET_OBSERVATION_MUST_STAY_BLOCKED" });
  });
});
