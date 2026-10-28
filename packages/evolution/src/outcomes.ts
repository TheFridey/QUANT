export const RESEARCH_OUTCOMES = [
  "PIPELINE_COMPLETED",
  "EXPERIMENT_EXECUTED",
  "RESULTS_MEASURABLE",
  "STATISTICALLY_EVALUATED",
  "OUT_OF_SAMPLE_VALIDATED",
  "FORWARD_PAPER_VALIDATED",
  "DEPLOYMENT_ELIGIBLE",
] as const;

export type ResearchOutcome = (typeof RESEARCH_OUTCOMES)[number];

export type OutcomeAssessment = {
  met: boolean;
  detail: string;
};

export type ResearchOutcomeMap = Record<ResearchOutcome, OutcomeAssessment>;

/**
 * Each outcome is independent. Completing the pipeline does not imply a measurable
 * or deployable strategy. A null return cannot satisfy RESULTS_MEASURABLE.
 */
export function classifyResearchOutcomes(input: {
  pipelineFinished: boolean;
  experimentExecuted: boolean;
  returnPct: string | null;
  sampleSize: number;
  minSampleSize: number;
  statisticsRecorded: boolean;
  untouchedTestReturnPct: string | null;
  untouchedSampleSize: number;
  tunedOnEvaluationSample: boolean;
  forwardPaperValidated: boolean;
  promotionAuthorised: boolean;
}): ResearchOutcomeMap {
  const measurable = input.experimentExecuted && input.returnPct !== null && input.sampleSize > 0;
  const statistical =
    measurable && input.statisticsRecorded && input.sampleSize >= input.minSampleSize && input.returnPct !== null;
  const oos =
    statistical &&
    !input.tunedOnEvaluationSample &&
    input.untouchedTestReturnPct !== null &&
    input.untouchedSampleSize >= input.minSampleSize;
  const forward = oos && input.forwardPaperValidated;
  const eligible = forward && input.promotionAuthorised;
  return {
    PIPELINE_COMPLETED: {
      met: input.pipelineFinished,
      detail: input.pipelineFinished ? "Research stages finished" : "Research stages did not finish",
    },
    EXPERIMENT_EXECUTED: {
      met: input.experimentExecuted,
      detail: input.experimentExecuted
        ? "Compiled strategy code executed in the isolated runner"
        : "Generated code did not execute",
    },
    RESULTS_MEASURABLE: {
      met: measurable,
      detail: measurable
        ? `Net return ${input.returnPct}% from ${input.sampleSize} closed trades`
        : "Return is null or no closed trades were simulated",
    },
    STATISTICALLY_EVALUATED: {
      met: statistical,
      detail: statistical
        ? `Sample ${input.sampleSize} meets the minimum ${input.minSampleSize}`
        : `Sample ${input.sampleSize} is below ${input.minSampleSize} or the return is unavailable`,
    },
    OUT_OF_SAMPLE_VALIDATED: {
      met: oos,
      detail: input.tunedOnEvaluationSample
        ? "Parameters were fit on the evaluation window"
        : oos
          ? `Untouched window return ${input.untouchedTestReturnPct}% (n=${input.untouchedSampleSize})`
          : "Untouched window lacks a measured return at the minimum sample size",
    },
    FORWARD_PAPER_VALIDATED: {
      met: forward,
      detail: forward ? "Forward paper evidence is recorded" : "Forward paper validation is still open",
    },
    DEPLOYMENT_ELIGIBLE: {
      met: eligible,
      detail: eligible
        ? "Explicit promotion authorisation is recorded. The live paper engine is unchanged by this flag."
        : "Deployment requires out-of-sample evidence, forward paper, and explicit promotion",
    },
  };
}
