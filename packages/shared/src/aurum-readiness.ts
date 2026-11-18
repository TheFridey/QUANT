/** Read-only command API contract. Evidence labels never grant execution authority. */
export type AurumReadinessState =
  | "NOT_CONFIGURED" | "IMPLEMENTED_INACTIVE" | "SHADOW_ONLY" | "VERIFIED_TEST"
  | "BLOCKED_APPROVAL" | "BLOCKED_RESEARCH";

export function aurumReadiness() {
  return {
    contractVersion: 1 as const,
    executionEligible: false as const,
    researchEligible: false as const,
    account: null,
    balanceGbp: null,
    goldMarketData: {
      state: "IMPLEMENTED_INACTIVE" as AurumReadinessState,
      providerConnectivity: null,
      bid: null, ask: null, spread: null, eventTime: null, receivedAt: null,
      quoteAgeMs: null, quality: null, session: null, circuitBreaker: null,
    },
    shadowIngestion: { state: "BLOCKED_APPROVAL" as AurumReadinessState, active: false },
    product: { state: "IMPLEMENTED_INACTIVE" as AurumReadinessState },
    accountArchitecture: { state: "BLOCKED_APPROVAL" as AurumReadinessState },
    research: { state: "BLOCKED_RESEARCH" as AurumReadinessState },
    execution: { state: "BLOCKED_APPROVAL" as AurumReadinessState },
    storage: { state: "BLOCKED_APPROVAL" as AurumReadinessState, health: null },
    legacyHistory: { state: "NOT_CONFIGURED" as AurumReadinessState, snapshot: null },
    blockers: ["C3_DATABASE_FOUNDATION", "C10_ACCOUNT_ISOLATION", "LEGACY_TRIAL_RECONCILIATION",
      "QUOTE_POLICY_APPROVAL", "SHADOW_PERSISTENCE_APPROVAL", "STORAGE_SAFETY_REVIEW"],
  };
}

/** Proposal validator only; deliberately has no scheduler, environment or database access. */
export type LegacyRetirementEvidence = {
  openPositions: number | null;
  pendingOrders: number | null;
  unsettledFills: number | null;
  protectiveActions: number | null;
  researchNeedsCrypto: boolean | null;
};

export function assessLegacyRetirement(evidence: LegacyRetirementEvidence) {
  const counts = [evidence.openPositions, evidence.pendingOrders, evidence.unsettledFills, evidence.protectiveActions];
  const reasons: string[] = [];
  if (counts.some((n) => n === null || !Number.isSafeInteger(n) || n < 0) || evidence.researchNeedsCrypto === null) {
    reasons.push("EVIDENCE_UNAVAILABLE");
  }
  if (counts.some((n) => n !== null && n > 0)) reasons.push("LEGACY_OBLIGATIONS_REMAIN");
  if (evidence.researchNeedsCrypto !== false) reasons.push("RESEARCH_DEPENDENCY_UNRESOLVED");
  return {
    eligibleForOperatorApproval: reasons.length === 0,
    activated: false as const,
    proposed: { discoveryEnabled: false, strategyEvaluationEnabled: false, newEntryEnabled: false, protectiveExitEnabled: true },
    reasons,
  };
}
