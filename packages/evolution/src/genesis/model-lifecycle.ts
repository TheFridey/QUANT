/**
 * GENESIS Phase 5 model lifecycle (pure). These states are research evidence labels only. None of them,
 * PAPER_APPROVED included, grants any trading authority, writes EngineControl, risk configuration, strategy
 * instances or execution permissions, or creates orders. The operator promotion process
 * (packages/evolution/src/promotion.ts, unchanged) stays the only route to a paper strategy.
 *
 * The same table is enforced by the database (odin_genesis_model_transition_allowed in migration
 * 20261104100000_genesis_model_registry_shadow); keep the two identical.
 */
export const MODEL_STATES = [
  "EXPERIMENTAL",
  "REJECTED",
  "HISTORICALLY_ELIGIBLE",
  "SHADOW_CANDIDATE",
  "SHADOW_VALIDATED",
  "PAPER_CANDIDATE",
  "PAPER_APPROVED",
  "RETIRED",
  "FAILED",
] as const;

export type ModelState = (typeof MODEL_STATES)[number];

export const TERMINAL_MODEL_STATES: readonly ModelState[] = ["REJECTED", "RETIRED", "FAILED"];

/** States whose models the shadow service runs. */
export const SHADOW_STATES: readonly ModelState[] = ["SHADOW_CANDIDATE", "SHADOW_VALIDATED"];

/** States an operator actor must write (`operator:<identity>`). */
export const OPERATOR_ONLY_STATES: readonly ModelState[] = ["PAPER_CANDIDATE", "PAPER_APPROVED"];

export const MODEL_TRANSITIONS: Readonly<Record<ModelState, readonly ModelState[]>> = {
  EXPERIMENTAL: ["HISTORICALLY_ELIGIBLE", "REJECTED", "FAILED", "RETIRED"],
  HISTORICALLY_ELIGIBLE: ["SHADOW_CANDIDATE", "REJECTED", "FAILED", "RETIRED"],
  SHADOW_CANDIDATE: ["SHADOW_VALIDATED", "REJECTED", "FAILED", "RETIRED"],
  SHADOW_VALIDATED: ["PAPER_CANDIDATE", "REJECTED", "FAILED", "RETIRED"],
  PAPER_CANDIDATE: ["PAPER_APPROVED", "REJECTED", "FAILED", "RETIRED"],
  PAPER_APPROVED: ["REJECTED", "FAILED", "RETIRED"],
  REJECTED: [],
  RETIRED: [],
  FAILED: [],
};

export function isModelState(value: string): value is ModelState {
  return (MODEL_STATES as readonly string[]).includes(value);
}

export function canTransitionModel(from: ModelState, to: ModelState): boolean {
  return MODEL_TRANSITIONS[from].includes(to);
}

export function isOperatorActor(actor: string): boolean {
  return /^operator:.+/.test(actor);
}

export type ModelApprovalRef = { id: string; modelVersionId: string; approvedBy: string; approvedAt: Date; expiresAt: Date; subjectHash: string };

export type TransitionCheck = { ok: true } | { ok: false; code: string; error: string };

/**
 * App-side transition rule: known states, allowed edge, non-empty reason, operator actor for PAPER_* states,
 * and for PAPER_APPROVED a current approval by the same operator naming this exact artefact.
 */
export function checkModelTransition(input: {
  modelVersionId: string;
  artefactHash: string;
  from: string;
  to: string;
  actor: string;
  reason: string;
  approval?: ModelApprovalRef | null;
  now: Date;
}): TransitionCheck {
  if (!isModelState(input.from)) return { ok: false, code: "UNKNOWN_STATE", error: `unknown state ${input.from}` };
  if (!isModelState(input.to)) return { ok: false, code: "UNKNOWN_STATE", error: `unknown state ${input.to}` };
  if (!canTransitionModel(input.from, input.to)) return { ok: false, code: "ILLEGAL_TRANSITION", error: `illegal transition ${input.from} -> ${input.to}` };
  if (!input.reason.trim()) return { ok: false, code: "REASON_REQUIRED", error: "a transition needs a reason" };
  if (!input.actor.trim()) return { ok: false, code: "ACTOR_REQUIRED", error: "a transition needs an actor" };
  if (OPERATOR_ONLY_STATES.includes(input.to) && !isOperatorActor(input.actor)) {
    return { ok: false, code: "OPERATOR_REQUIRED", error: `${input.to} must be written by an operator actor (operator:<identity>)` };
  }
  if (input.to === "PAPER_APPROVED") {
    const a = input.approval;
    if (!a) return { ok: false, code: "APPROVAL_REQUIRED", error: "PAPER_APPROVED needs an approval record" };
    if (a.modelVersionId !== input.modelVersionId) return { ok: false, code: "APPROVAL_MISMATCH", error: "approval is for another model" };
    if (a.approvedBy !== input.actor) return { ok: false, code: "APPROVAL_MISMATCH", error: "approval was given by another operator" };
    if (a.subjectHash !== input.artefactHash) return { ok: false, code: "APPROVAL_MISMATCH", error: "approval names another artefact" };
    if (!(a.approvedAt.getTime() <= input.now.getTime() && input.now.getTime() < a.expiresAt.getTime())) {
      return { ok: false, code: "APPROVAL_EXPIRED", error: "approval is not current" };
    }
  } else if (input.approval) {
    return { ok: false, code: "APPROVAL_UNEXPECTED", error: "only PAPER_APPROVED carries an approval" };
  }
  return { ok: true };
}
