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
 * Dedupe funnel rows by cycleId|pairAddress|stage (last write wins).
 * Prevents double-counting when workers retry persistFunnel for the same cycle.
 */
export function uniqueFunnelEvents(events: FunnelEvent[]): FunnelEvent[] {
  const byKey = new Map<string, FunnelEvent>();
  for (const event of events) {
    const key = `${event.cycleId}|${event.pairAddress}|${event.stage}`;
    byKey.set(key, event);
  }
  return [...byKey.values()];
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

/**
 * §9 throughput / capacity visibility — funnel metrics without a mandatory trade quota.
 * Explains zero-trade days via decisive block reasons.
 */
export type FunnelThroughputMetrics = {
  discovered: number;
  signalled: number;
  riskPassed: number;
  ordered: number;
  filled: number;
  rejected: number;
  dropped: number;
  uniquePairs: number;
  uniqueInstances: number;
  decisiveBlocks: Array<{ reason: string; count: number }>;
  /** Capacity remaining after settle (caller supplies). */
  capacityRemainingEntries: number | null;
};

export function funnelThroughputMetrics(input: {
  events: FunnelEvent[];
  capacityRemainingEntries?: number | null;
}): FunnelThroughputMetrics {
  const summary = summarizeFunnel(input.events);
  const pairs = new Set(input.events.map((e) => e.pairAddress).filter(Boolean));
  const instances = new Set(
    input.events
      .map((e) => (e.detail as { strategyInstanceId?: string } | undefined)?.strategyInstanceId)
      .filter((id): id is string => Boolean(id)),
  );
  const blockCounts = new Map<string, number>();
  for (const event of input.events) {
    if (event.stage !== "REJECTED" && event.stage !== "DROPPED" && event.stage !== "FILTERED") continue;
    for (const reason of event.reasonCodes) {
      blockCounts.set(reason, (blockCounts.get(reason) ?? 0) + 1);
    }
  }
  const decisiveBlocks = [...blockCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 12);
  return {
    discovered: summary.DISCOVERED,
    signalled: summary.SIGNALLED,
    riskPassed: summary.RISK_PASSED,
    ordered: summary.ORDERED,
    filled: summary.FILLED,
    rejected: summary.REJECTED,
    dropped: summary.DROPPED,
    uniquePairs: pairs.size,
    uniqueInstances: instances.size,
    decisiveBlocks,
    capacityRemainingEntries: input.capacityRemainingEntries ?? null,
  };
}
