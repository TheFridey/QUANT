/**
 * Research promotion never writes EngineControl.
 * An approved flag is a review record. The approved paper strategy stays unchanged.
 */
export function reviewPromotion(input: {
  deploymentEligible: boolean;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
  reviewed: boolean;
}): { appliedToPaperEngine: false; accepted: boolean; reason: string } {
  if (!input.reviewed || input.approvalStatus !== "APPROVED" || !input.deploymentEligible) {
    return {
      appliedToPaperEngine: false,
      accepted: false,
      reason: "Unreviewed research output stays out of the approved paper engine",
    };
  }
  return {
    appliedToPaperEngine: false,
    accepted: true,
    reason: "Promotion is recorded for an operator. The approved paper strategy is unchanged.",
  };
}
