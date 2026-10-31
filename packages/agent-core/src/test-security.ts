import type { SecurityAssessment } from "@odin/shared";
import type { PlanInput } from "./types.js";

/** Test-only: a PASS assessment, so planner tests exercise entries past Aegis explicitly. */
export function passingAssessment(tokenAddress: string): SecurityAssessment {
  return {
    tokenAddress,
    category: "PASS",
    confidence: "0.850000",
    reasonCodes: ["SECURITY_PASS"],
    mintAuthority: "revoked",
    freezeAuthority: "revoked",
    transferRestricted: false,
    token2022Extensions: null,
    holderConcentrationTop10Pct: "10.000000",
    suspiciousDeployer: null,
    liquidityFragile: false,
    largeWalletMove: null,
    fraudIndicators: [],
    source: "mock",
    fetchedAt: "2026-10-28T16:00:00.000Z",
    stale: false,
    fields: {},
  };
}

/** Test-only: PASS for every Solana base mint in the input unless the test supplied its own map. */
export function withPassingSecurity(input: PlanInput): PlanInput {
  if (input.securityByMint) return input;
  const securityByMint = Object.fromEntries(
    input.pairs.filter((pair) => pair.chainId === "solana").map((pair) => [pair.baseAddress, passingAssessment(pair.baseAddress)]),
  );
  return { ...input, securityByMint };
}
