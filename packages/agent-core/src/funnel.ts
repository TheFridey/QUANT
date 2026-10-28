import type { ReasonCode } from "@odin/shared";

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
