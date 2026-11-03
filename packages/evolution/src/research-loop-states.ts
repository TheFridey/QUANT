import type { AutonomyAction } from "./autonomy.js";

/**
 * ASCEND-08 research-loop experiment states. A state names the stage whose work runs next:
 * an experiment in FORGE has not been forged yet; the tick that performs the forge moves it to TEST.
 * REVIEW is where autonomous work ends: only an operator acts on it (and may only abandon it here).
 */
export const RESEARCH_EXPERIMENT_STAGES = [
  "OBSERVE",
  "HYPOTHESISE",
  "FORGE",
  "TEST",
  "CHALLENGE",
  "VALIDATE",
  "PAPER",
  "REVIEW",
] as const;

export const RESEARCH_EXPERIMENT_TERMINAL = ["REJECTED", "FAILED", "ABANDONED"] as const;

export const RESEARCH_EXPERIMENT_STATES = [
  ...RESEARCH_EXPERIMENT_STAGES,
  ...RESEARCH_EXPERIMENT_TERMINAL,
  "BLOCKED_APPROVAL",
] as const;

export type ResearchExperimentState = (typeof RESEARCH_EXPERIMENT_STATES)[number];

/** Stages whose work needs an autonomy-gate decision (and, where the gate says so, an operator approval). */
export const GATED_STAGE_ACTIONS = {
  FORGE: "forge_code",
  TEST: "run_backtest",
  PAPER: "promote_paper",
} as const satisfies Partial<Record<ResearchExperimentState, AutonomyAction>>;

export type GatedStage = keyof typeof GATED_STAGE_ACTIONS;
export type ApprovableAction = (typeof GATED_STAGE_ACTIONS)[GatedStage];
export const APPROVABLE_ACTIONS: readonly ApprovableAction[] = ["forge_code", "run_backtest", "promote_paper"];

export function isGatedStage(state: string): state is GatedStage {
  return Object.prototype.hasOwnProperty.call(GATED_STAGE_ACTIONS, state);
}

/**
 * The complete legal transition table. Anything not listed is refused.
 * - Each stage advances only to the next stage, or ends (REJECTED: the candidate is bad;
 *   FAILED: the work could not be done, e.g. retry ceiling; ABANDONED: the operator or a missing hypothesis).
 * - Only gated stages (FORGE, TEST, PAPER) may enter BLOCKED_APPROVAL, and BLOCKED_APPROVAL may only
 *   return to the stage it blocked (checked by `canTransitionExperiment` with `blockedState`).
 * - REVIEW never advances autonomously; terminal states have no exits.
 */
export const RESEARCH_EXPERIMENT_TRANSITIONS: Record<ResearchExperimentState, readonly ResearchExperimentState[]> = {
  OBSERVE: ["HYPOTHESISE", "FAILED", "ABANDONED"],
  HYPOTHESISE: ["FORGE", "FAILED", "ABANDONED"],
  FORGE: ["TEST", "REJECTED", "FAILED", "ABANDONED", "BLOCKED_APPROVAL"],
  TEST: ["CHALLENGE", "REJECTED", "FAILED", "ABANDONED", "BLOCKED_APPROVAL"],
  CHALLENGE: ["VALIDATE", "REJECTED", "FAILED", "ABANDONED"],
  VALIDATE: ["PAPER", "REJECTED", "FAILED", "ABANDONED"],
  PAPER: ["REVIEW", "FAILED", "ABANDONED", "BLOCKED_APPROVAL"],
  REVIEW: ["ABANDONED"],
  BLOCKED_APPROVAL: ["FORGE", "TEST", "PAPER", "FAILED", "ABANDONED"],
  REJECTED: [],
  FAILED: [],
  ABANDONED: [],
};

export function isResearchExperimentState(value: string): value is ResearchExperimentState {
  return (RESEARCH_EXPERIMENT_STATES as readonly string[]).includes(value);
}

export function isTerminalExperimentState(state: string): boolean {
  return (RESEARCH_EXPERIMENT_TERMINAL as readonly string[]).includes(state);
}

/** States the loop may claim and work on. REVIEW and terminal states are never claimed. */
export const CLAIMABLE_EXPERIMENT_STATES: readonly ResearchExperimentState[] = [
  "OBSERVE",
  "HYPOTHESISE",
  "FORGE",
  "TEST",
  "CHALLENGE",
  "VALIDATE",
  "PAPER",
  "BLOCKED_APPROVAL",
];

export type ExperimentTransitionCheck = { ok: true } | { ok: false; error: string };

export function canTransitionExperiment(
  from: string,
  to: string,
  options: { blockedState?: string | null } = {},
): ExperimentTransitionCheck {
  if (!isResearchExperimentState(from)) return { ok: false, error: `Unknown from state ${from}` };
  if (!isResearchExperimentState(to)) return { ok: false, error: `Unknown to state ${to}` };
  if (!RESEARCH_EXPERIMENT_TRANSITIONS[from].includes(to)) {
    return { ok: false, error: `Illegal transition ${from} → ${to}` };
  }
  if (to === "BLOCKED_APPROVAL" && !isGatedStage(from)) {
    return { ok: false, error: `${from} is not a gated stage` };
  }
  if (from === "BLOCKED_APPROVAL" && isGatedStage(to) && options.blockedState !== to) {
    return { ok: false, error: `BLOCKED_APPROVAL may only return to ${String(options.blockedState)}, not ${to}` };
  }
  return { ok: true };
}

/** Next stage after a stage's work succeeds. */
export function nextStage(state: ResearchExperimentState): ResearchExperimentState | null {
  const index = (RESEARCH_EXPERIMENT_STAGES as readonly string[]).indexOf(state);
  if (index < 0 || index >= RESEARCH_EXPERIMENT_STAGES.length - 1) return null;
  return RESEARCH_EXPERIMENT_STAGES[index + 1]!;
}
