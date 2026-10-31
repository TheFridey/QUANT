import { d } from "@odin/shared";
import type { DecisionDraft, ProposedOrder } from "./types.js";

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

function scale(value: string | undefined, ratio: ReturnType<typeof d>): string | undefined {
  return value === undefined ? undefined : d(value).mul(ratio).toFixed(8);
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
    const recheckQty = d(order.qty);
    if (recheckQty.gte(plannedQty)) {
      admitted.push({ ...order, qty: plannedQty.toFixed(8), estimatedCostUsd: plan.estimatedCostUsd ?? order.estimatedCostUsd, estimatedNotionalUsd: plan.estimatedNotionalUsd ?? order.estimatedNotionalUsd });
      records.push(record(order, "ADMITTED", plan.qty, plannedQty.toFixed(8)));
    } else {
      const ratio = plannedQty.gt(0) ? recheckQty.div(plannedQty) : d("0");
      admitted.push({
        ...order,
        estimatedCostUsd: scale(plan.estimatedCostUsd, ratio) ?? order.estimatedCostUsd,
        estimatedNotionalUsd: scale(plan.estimatedNotionalUsd, ratio) ?? order.estimatedNotionalUsd,
      });
      records.push(record(order, "ADMITTED_REDUCED", plan.qty, order.qty, ["SIZE_REDUCED_AT_ADMISSION"]));
    }
  }

  for (const plan of snapshot.orders) {
    if (seen.has(plan.clientOrderId)) continue;
    records.push(record(plan, "REJECTED_AT_ADMISSION", plan.qty, null, admissionReasons(plan.pairAddress, admission.decisions)));
  }
  return { orders: admitted, records };
}
