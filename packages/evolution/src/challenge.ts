import { z } from "zod";

export const challengeFindingSchema = z
  .object({
    code: z.enum([
      "LOOK_AHEAD",
      "LEAKAGE",
      "SURVIVORSHIP",
      "OVERFITTING",
      "MULTIPLE_TESTING",
      "REGIME",
      "EXECUTION_REALISM",
      "SAMPLE_SIZE",
      "CORRELATION",
      "TAILS",
      "OTHER",
    ]),
    severity: z.enum(["info", "warn", "block"]),
    detail: z.string().min(1).max(1000),
  })
  .strict();

export type ChallengeFinding = z.infer<typeof challengeFindingSchema>;

export const challengeReportSchema = z
  .object({
    passed: z.boolean(),
    findings: z.array(challengeFindingSchema).max(64),
    summary: z.string().min(1).max(4000),
    reviewer: z.literal("CHALLENGE"),
    independent: z.literal(true),
  })
  .strict();

export type ChallengeReport = z.infer<typeof challengeReportSchema>;

export type ChallengeInput = {
  sampleSize: number;
  oosSampleSize: number | null;
  inSampleReturnPct: string | null;
  oosReturnPct: string | null;
  maxDrawdownPct: string | null;
  inactivePairCount: number;
  disappearedPairCount: number;
  parameterTrials: number;
  usedFutureBars: boolean;
  usedPostExitMemoryInEntry: boolean;
  costModelPresent: boolean;
  monteCarloRan: boolean;
  correlatedSiblingStrategies: number;
};

/**
 * Independent adversarial reviewer.
 * Prefer deterministic flags; LLM commentary optional and never clears a block.
 */
export function runChallengeReview(input: ChallengeInput): ChallengeReport {
  const findings: ChallengeFinding[] = [];

  if (input.usedFutureBars) {
    findings.push({
      code: "LOOK_AHEAD",
      severity: "block",
      detail: "Strategy or test harness referenced future bars.",
    });
  }
  if (input.usedPostExitMemoryInEntry) {
    findings.push({
      code: "LEAKAGE",
      severity: "block",
      detail: "Post-exit trade memory influenced historical entry decisions.",
    });
  }
  if (input.disappearedPairCount > 0 || input.inactivePairCount > 0) {
    findings.push({
      code: "SURVIVORSHIP",
      severity: "warn",
      detail: `Universe includes ${input.disappearedPairCount} disappeared and ${input.inactivePairCount} inactive pairs.`,
    });
  }
  if (input.sampleSize < 30) {
    findings.push({
      code: "SAMPLE_SIZE",
      severity: "block",
      detail: `Closed-trade sample ${input.sampleSize} < 30.`,
    });
  }
  if (input.oosSampleSize === null || input.oosSampleSize < 30) {
    findings.push({
      code: "OVERFITTING",
      severity: "block",
      detail: "Out-of-sample sample missing or below threshold.",
    });
  }
  if (
    input.inSampleReturnPct !== null &&
    input.oosReturnPct !== null &&
    Number(input.inSampleReturnPct) > 0 &&
    Number(input.oosReturnPct) < Number(input.inSampleReturnPct) * 0.25
  ) {
    findings.push({
      code: "OVERFITTING",
      severity: "warn",
      detail: "Large in-sample vs OOS return gap.",
    });
  }
  if (input.parameterTrials > 20) {
    findings.push({
      code: "MULTIPLE_TESTING",
      severity: "warn",
      detail: `${input.parameterTrials} parameter trials without multiplicity control.`,
    });
  }
  if (!input.costModelPresent) {
    findings.push({
      code: "EXECUTION_REALISM",
      severity: "block",
      detail: "Cost/slippage model absent.",
    });
  }
  if (!input.monteCarloRan) {
    findings.push({
      code: "TAILS",
      severity: "warn",
      detail: "Monte Carlo path resampling not run.",
    });
  }
  if (input.maxDrawdownPct !== null && Number(input.maxDrawdownPct) > 25) {
    findings.push({
      code: "TAILS",
      severity: "warn",
      detail: `Max drawdown ${input.maxDrawdownPct}% is severe for paper validation.`,
    });
  }
  if (input.correlatedSiblingStrategies >= 3) {
    findings.push({
      code: "CORRELATION",
      severity: "warn",
      detail: "Multiple highly similar sibling strategies inflate discovery odds.",
    });
  }
  if (input.oosReturnPct !== null && Number(input.oosReturnPct) < -10) {
    findings.push({
      code: "REGIME",
      severity: "warn",
      detail: "OOS return deeply negative — possible regime mismatch.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      code: "OTHER",
      severity: "info",
      detail: "No automated adversarial flags; human challenge still required.",
    });
  }

  const blocked = findings.some((finding) => finding.severity === "block");
  return challengeReportSchema.parse({
    passed: !blocked,
    findings,
    summary: blocked
      ? "CHALLENGE blocked progression pending remediation."
      : "CHALLENGE found no blocking issues; validation may proceed with disclosed warnings.",
    reviewer: "CHALLENGE",
    independent: true,
  });
}
