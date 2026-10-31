import { d } from "@odin/shared";
import type { ReasonCode } from "@odin/shared";
import type { DecisionDraft, IntentOutcome, ProposedOrder } from "./types.js";

/**
 * Audit F1: one immutable plan per cycle. SENTINEL computes it once; PULSE, AEGIS and ATLAS persist
 * projections of it; the executor admits orders against it instead of acting on a fresh plan that
 * no stored decision describes.
 */
export type CyclePlanSnapshot = {
  cycleId: string;
  /** The `now` the plan was computed with. */
  plannedAt: string;
  decisions: DecisionDraft[];
  orders: ProposedOrder[];
  watchlist: unknown[];
  intentOutcomes: unknown[];
};

export type AdmissionResult =
  /** Planned and still admissible at the planned quantity. */
  | "ADMITTED"
  /** Planned, admissible, but the admission re-check sized it smaller; the smaller quantity is used. */
  | "ADMITTED_REDUCED"
  /** Risk-reducing exit that appeared only at admission (e.g. a stop hit between stages). Never delayed. */
  | "ADMISSION_ONLY_EXIT"
  /** An entry the admission re-check produced but the cycle plan never decided. Not executed. */
  | "NOT_IN_PLAN"
  /** Planned, but the admission re-check (freshness, risk, capacity) no longer allows it. Not executed. */
  | "REJECTED_AT_ADMISSION"
  /** A planned exit the re-check no longer produces (e.g. the position was already closed by settlement). */
  | "EXIT_NO_LONGER_NEEDED"
  /** Legacy cycle without a stored plan: admission plan used as before. */
  | "NO_SNAPSHOT";

export type AdmissionRecord = {
  clientOrderId: string;
  pairAddress: string;
  side: ProposedOrder["side"];
  intent: ProposedOrder["intent"];
  result: AdmissionResult;
  plannedQty: string | null;
  admittedQty: string | null;
  reasonCodes: string[];
};

function riskReducing(order: Pick<ProposedOrder, "side" | "intent">): boolean {
  return order.side === "SELL" && order.intent !== "ENTRY";
}

/** Thrown when a stored plan is malformed. The cycle fails closed; the plan is never repaired. */
export class InvalidCyclePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCyclePlanError";
  }
}

function positiveQty(value: unknown): ReturnType<typeof d> | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return null;
  const qty = d(value);
  return qty.gt(0) ? qty : null;
}

/** `value * qty / basisQty`, or undefined when the source estimate is missing. */
function perUnitScaled(value: string | undefined, basisQty: ReturnType<typeof d>, qty: ReturnType<typeof d>): ReturnType<typeof d> | undefined {
  return value === undefined ? undefined : d(value).div(basisQty).mul(qty);
}

/**
 * The reservation estimate for an admitted entry, at the admitted quantity. Priced at the higher of
 * the plan-time and admission-time per-unit estimates, so a price rise between SENTINEL and the
 * executor never under-reserves cash, exposure or risk.
 */
function conservativeEstimate(
  planned: string | undefined,
  plannedQty: ReturnType<typeof d>,
  recheck: string | undefined,
  recheckQty: ReturnType<typeof d>,
  admittedQty: ReturnType<typeof d>,
): string | undefined {
  const fromPlan = perUnitScaled(planned, plannedQty, admittedQty);
  const fromRecheck = perUnitScaled(recheck, recheckQty, admittedQty);
  if (fromPlan === undefined) return fromRecheck?.toFixed(8);
  if (fromRecheck === undefined) return fromPlan.toFixed(8);
  return (fromPlan.gt(fromRecheck) ? fromPlan : fromRecheck).toFixed(8);
}

/** Why the admission re-check dropped a pair: the first non-ACT decision for it, if any. */
function admissionReasons(pairAddress: string, decisions: DecisionDraft[]): string[] {
  const blocking = decisions.find(
    (row) => row.pairAddress === pairAddress && row.decision !== "ACT" && row.decision !== "PASS" && row.agent !== "SENTINEL",
  );
  return blocking ? [...blocking.reasonCodes] : ["ADMISSION_RECHECK_FAILED"];
}

/**
 * Reconcile the executor's admission-time plan with the cycle's stored plan.
 * Entries: only what the stored plan decided, never more than its quantity.
 * Risk-reducing exits: always admitted (tightening entries must never block protection).
 */
export function admitAgainstPlan(
  snapshot: Pick<CyclePlanSnapshot, "orders"> | null,
  admission: { orders: ProposedOrder[]; decisions: DecisionDraft[] },
): { orders: ProposedOrder[]; records: AdmissionRecord[] } {
  const record = (order: ProposedOrder, result: AdmissionResult, plannedQty: string | null, admittedQty: string | null, reasonCodes: string[] = []): AdmissionRecord => ({
    clientOrderId: order.clientOrderId,
    pairAddress: order.pairAddress,
    side: order.side,
    intent: order.intent,
    result,
    plannedQty,
    admittedQty,
    reasonCodes,
  });

  if (snapshot === null) {
    return {
      orders: admission.orders,
      records: admission.orders.map((order) => record(order, "NO_SNAPSHOT", null, order.qty)),
    };
  }

  for (const order of snapshot.orders) {
    if (!positiveQty(order.qty)) {
      throw new InvalidCyclePlanError(`cycle plan order ${String(order.clientOrderId)} has invalid qty ${String(order.qty)}`);
    }
  }
  const planned = new Map(snapshot.orders.map((order) => [order.clientOrderId, order]));
  const admitted: ProposedOrder[] = [];
  const records: AdmissionRecord[] = [];
  const seen = new Set<string>();

  for (const order of admission.orders) {
    const plan = planned.get(order.clientOrderId) ?? null;
    if (plan) seen.add(order.clientOrderId);
    if (riskReducing(order)) {
      admitted.push(order);
      records.push(record(order, plan ? "ADMITTED" : "ADMISSION_ONLY_EXIT", plan?.qty ?? null, order.qty));
      continue;
    }
    if (!plan) {
      records.push(record(order, "NOT_IN_PLAN", null, null, ["NOT_IN_CYCLE_PLAN"]));
      continue;
    }
    const plannedQty = d(plan.qty);
    const recheckQty = positiveQty(order.qty);
    if (!recheckQty) {
      records.push(record(order, "REJECTED_AT_ADMISSION", plan.qty, null, ["ADMISSION_RECHECK_FAILED"]));
      continue;
    }
    const reduced = recheckQty.lt(plannedQty);
    const admittedQty = reduced ? recheckQty : plannedQty;
    admitted.push({
      ...order,
      qty: admittedQty.toFixed(8),
      estimatedCostUsd: conservativeEstimate(plan.estimatedCostUsd, plannedQty, order.estimatedCostUsd, recheckQty, admittedQty),
      estimatedNotionalUsd: conservativeEstimate(plan.estimatedNotionalUsd, plannedQty, order.estimatedNotionalUsd, recheckQty, admittedQty),
    });
    records.push(
      reduced
        ? record(order, "ADMITTED_REDUCED", plan.qty, admittedQty.toFixed(8), ["SIZE_REDUCED_AT_ADMISSION"])
        : record(order, "ADMITTED", plan.qty, admittedQty.toFixed(8)),
    );
  }

  for (const plan of snapshot.orders) {
    if (seen.has(plan.clientOrderId)) continue;
    records.push(
      riskReducing(plan)
        ? record(plan, "EXIT_NO_LONGER_NEEDED", plan.qty, null, ["EXIT_NO_LONGER_NEEDED"])
        : record(plan, "REJECTED_AT_ADMISSION", plan.qty, null, admissionReasons(plan.pairAddress, admission.decisions)),
    );
  }
  return { orders: admitted, records };
}

/** Parse a stored plan. A malformed plan fails the cycle closed; it is never repaired. */
export function parseCyclePlanSnapshot(value: unknown): CyclePlanSnapshot {
  const row = value as Partial<CyclePlanSnapshot> | null;
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.cycleId !== "string" ||
    typeof row.plannedAt !== "string" ||
    !Array.isArray(row.orders) ||
    !Array.isArray(row.decisions) ||
    !Array.isArray(row.watchlist) ||
    !Array.isArray(row.intentOutcomes)
  ) {
    throw new InvalidCyclePlanError("stored cycle plan is malformed");
  }
  for (const order of row.orders) {
    if (!order || typeof order.clientOrderId !== "string" || typeof order.pairAddress !== "string" || !positiveQty(order.qty)) {
      throw new InvalidCyclePlanError(`stored cycle plan order ${String(order?.clientOrderId)} is malformed`);
    }
  }
  return row as CyclePlanSnapshot;
}

const NOT_EXECUTED: ReadonlySet<AdmissionResult> = new Set(["NOT_IN_PLAN", "REJECTED_AT_ADMISSION", "EXIT_NO_LONGER_NEEDED"]);

/**
 * Make the re-check's intent outcomes describe what was actually admitted: an entry dropped at
 * admission is REJECTED (so it neither shows as ADMITTED nor advances the fairness cursor), and an
 * admitted entry carries the admitted quantity and notional.
 */
export function applyAdmissionToOutcomes(
  outcomes: IntentOutcome[],
  admission: { orders: ProposedOrder[]; records: AdmissionRecord[] },
): IntentOutcome[] {
  const records = new Map(admission.records.map((row) => [row.clientOrderId, row]));
  const orders = new Map(admission.orders.map((order) => [order.clientOrderId, order]));
  return outcomes.map((outcome) => {
    if (outcome.status !== "ADMITTED") return outcome;
    const record = records.get(outcome.clientOrderId);
    if (!record || record.result === "NO_SNAPSHOT") return outcome;
    if (NOT_EXECUTED.has(record.result)) {
      return { ...outcome, status: "REJECTED", reason: record.reasonCodes[0] ?? "ADMISSION_RECHECK_FAILED", sizedQty: null, sizedNotionalUsd: null };
    }
    const order = orders.get(outcome.clientOrderId);
    return { ...outcome, sizedQty: record.admittedQty, sizedNotionalUsd: order?.estimatedNotionalUsd ?? outcome.sizedNotionalUsd };
  });
}

/**
 * Make the re-check's EXECUTOR rows match the admission: a pair with no admitted order is REJECT
 * (with the admission reason), and every row carries its pair's admission records.
 */
export function applyAdmissionToDecisions(decisions: DecisionDraft[], records: AdmissionRecord[]): DecisionDraft[] {
  return decisions.map((decision) => {
    if (decision.agent !== "EXECUTOR") return decision;
    const forPair = records.filter((row) => row.pairAddress === decision.pairAddress && row.result !== "NO_SNAPSHOT");
    if (forPair.length === 0) return decision;
    const executed = forPair.filter((row) => !NOT_EXECUTED.has(row.result));
    const output = { ...decision.output, admission: forPair };
    if (decision.decision === "ACT" && executed.length === 0) {
      return { ...decision, decision: "REJECT", reasonCodes: [...new Set(forPair.flatMap((row) => row.reasonCodes))] as ReasonCode[], output };
    }
    return { ...decision, output };
  });
}
