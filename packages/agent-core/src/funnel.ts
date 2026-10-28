import type { ReasonCode } from "@odin/shared";
import type { DecisionDraft, ProposedOrder } from "./types.js";

export type FunnelStage =
  | "DISCOVERED"
  | "FILTERED"
  | "SIGNALLED"
  | "RISK_PASSED"
  | "RESERVED"
  | "ORDERED"
  | "FILLED"
  | "REJECTED"
  | "DROPPED";

export type FunnelEvent = {
  cycleId: string;
  pairAddress: string;
  instrumentId?: string | null;
  stage: FunnelStage;
  reasonCodes: ReasonCode[] | string[];
  detail?: Record<string, unknown>;
  at: string;
};

/** Append-only opportunity funnel — durable when persisted by API/worker. */
export function recordFunnelEvent(
  events: FunnelEvent[],
  event: Omit<FunnelEvent, "at"> & { at?: string },
): FunnelEvent[] {
  return [
    ...events,
    {
      ...event,
      at: event.at ?? new Date().toISOString(),
    },
  ];
}

export function summarizeFunnel(events: FunnelEvent[]): Record<FunnelStage, number> {
  const counts: Record<FunnelStage, number> = {
    DISCOVERED: 0,
    FILTERED: 0,
    SIGNALLED: 0,
    RISK_PASSED: 0,
    RESERVED: 0,
    ORDERED: 0,
    FILLED: 0,
    REJECTED: 0,
    DROPPED: 0,
  };
  for (const event of events) counts[event.stage] += 1;
  return counts;
}

/**
 * Derive durable funnel rows from a completed planCycle result.
 * Reason codes stay attached so operators can see why a stage advanced or blocked.
 */
export function funnelEventsFromPlan(input: {
  cycleId: string;
  decisions: DecisionDraft[];
  orders: ProposedOrder[];
  filledClientOrderIds?: string[];
  at?: string;
}): FunnelEvent[] {
  const at = input.at ?? new Date().toISOString();
  let events: FunnelEvent[] = [];
  const filled = new Set(input.filledClientOrderIds ?? []);

  for (const decision of input.decisions) {
    const pairAddress = decision.pairAddress || "";
    if (!pairAddress) continue;
    const base = {
      cycleId: input.cycleId,
      pairAddress,
      instrumentId: pairAddress.includes(":") ? pairAddress : null,
      reasonCodes: decision.reasonCodes,
      at,
      detail: { agent: decision.agent, decision: decision.decision },
    };

    if (decision.agent === "SENTINEL") {
      if (decision.decision === "REJECT" || decision.reasonCodes.includes("DISCOVERY_FILTERED")) {
        events = recordFunnelEvent(events, { ...base, stage: "FILTERED" });
      } else {
        events = recordFunnelEvent(events, { ...base, stage: "DISCOVERED" });
      }
    } else if (decision.agent === "PULSE" && decision.decision === "ACT") {
      events = recordFunnelEvent(events, { ...base, stage: "SIGNALLED" });
    } else if (decision.agent === "ATLAS") {
      if (decision.decision === "REJECT") {
        events = recordFunnelEvent(events, { ...base, stage: "REJECTED" });
      } else if (decision.decision === "PASS" || decision.decision === "ACT") {
        events = recordFunnelEvent(events, { ...base, stage: "RISK_PASSED" });
      }
    } else if (decision.agent === "EXECUTOR" && decision.decision === "REJECT") {
      events = recordFunnelEvent(events, { ...base, stage: "DROPPED" });
    }
  }

  for (const order of input.orders) {
    events = recordFunnelEvent(events, {
      cycleId: input.cycleId,
      pairAddress: order.pairAddress,
      instrumentId: order.pairAddress.includes(":") ? order.pairAddress : null,
      stage: filled.has(order.clientOrderId) ? "FILLED" : "ORDERED",
      reasonCodes: order.reasonCodes,
      at,
      detail: { clientOrderId: order.clientOrderId, side: order.side, intent: order.intent },
    });
  }

  return events;
}
