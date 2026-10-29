import type { ReasonCode } from "@odin/shared";

/**
 * Risk control hierarchy (B26).
 * Higher rank wins for operator diagnostics and breaker composition.
 * ACK of DurableAlert never clears a higher-rank hard control.
 */

export const RISK_CONTROL_RANKS = {
  EMERGENCY_STOP: 100,
  CIRCUIT_BREAKER: 90,
  ENTRIES_SUSPENDED: 80,
  FLATTEN_INCOMPLETE: 70,
  DAILY_LOSS_LIMIT: 60,
  TOTAL_DRAWDOWN_LIMIT: 55,
  AGGREGATE_EXPOSURE: 50,
  PAUSE_NEW_ENTRIES: 40,
  SESSION_CLOSED: 30,
  DATA_STALE: 20,
  ADVISORY: 10,
} as const;

export type RiskControlKind = keyof typeof RISK_CONTROL_RANKS;

export type ActiveRiskControl = {
  kind: RiskControlKind;
  rank: number;
  reasonCodes: ReasonCode[];
  /** Hard controls block BUY entries; advisories do not. */
  hard: boolean;
  detail?: string;
};

export type RiskHierarchySnapshot = {
  controls: ActiveRiskControl[];
  /** Highest-rank active hard control, if any. */
  dominantHard: ActiveRiskControl | null;
  /** True when any hard control blocks new BUY entries. */
  blocksNewEntries: boolean;
  /** Circuit breaker independently open (may coexist with lower ranks). */
  circuitBreakerOpen: boolean;
  /** Alert ACK must not clear these kinds. */
  ackDoesNotClear: RiskControlKind[];
};

export function evaluateRiskHierarchy(input: {
  engineStatus: "RUNNING" | "PAUSED" | "STOPPED" | "EMERGENCY_STOP" | string;
  circuitBreakerOpen: boolean;
  circuitBreakerReasons?: ReasonCode[];
  entriesSuspended: boolean;
  pauseNewEntries: boolean;
  flattenIncomplete?: boolean;
  dailyLossBreached?: boolean;
  drawdownBreached?: boolean;
  aggregateExposureBreached?: boolean;
  sessionClosedForEntry?: boolean;
  dataStale?: boolean;
}): RiskHierarchySnapshot {
  const controls: ActiveRiskControl[] = [];

  if (input.engineStatus === "EMERGENCY_STOP") {
    controls.push({
      kind: "EMERGENCY_STOP",
      rank: RISK_CONTROL_RANKS.EMERGENCY_STOP,
      reasonCodes: ["EMERGENCY_STOP"],
      hard: true,
      detail: "Only FLATTEN intents may proceed",
    });
  }
  if (input.circuitBreakerOpen) {
    controls.push({
      kind: "CIRCUIT_BREAKER",
      rank: RISK_CONTROL_RANKS.CIRCUIT_BREAKER,
      reasonCodes: ["CIRCUIT_BREAKER", ...(input.circuitBreakerReasons ?? [])],
      hard: true,
      detail: "Independent portfolio breaker — alert ACK does not reset",
    });
  }
  if (input.entriesSuspended) {
    controls.push({
      kind: "ENTRIES_SUSPENDED",
      rank: RISK_CONTROL_RANKS.ENTRIES_SUSPENDED,
      reasonCodes: ["ENTRIES_SUSPENDED"],
      hard: true,
      detail: "Reconcile/unknown exposure suspension — ACK ≠ resolve",
    });
  }
  if (input.flattenIncomplete) {
    controls.push({
      kind: "FLATTEN_INCOMPLETE",
      rank: RISK_CONTROL_RANKS.FLATTEN_INCOMPLETE,
      reasonCodes: ["FLATTEN_INCOMPLETE"],
      hard: true,
    });
  }
  if (input.dailyLossBreached) {
    controls.push({
      kind: "DAILY_LOSS_LIMIT",
      rank: RISK_CONTROL_RANKS.DAILY_LOSS_LIMIT,
      reasonCodes: ["DAILY_LOSS_LIMIT"],
      hard: true,
    });
  }
  if (input.drawdownBreached) {
    controls.push({
      kind: "TOTAL_DRAWDOWN_LIMIT",
      rank: RISK_CONTROL_RANKS.TOTAL_DRAWDOWN_LIMIT,
      reasonCodes: ["TOTAL_DRAWDOWN_LIMIT"],
      hard: true,
    });
  }
  if (input.aggregateExposureBreached) {
    controls.push({
      kind: "AGGREGATE_EXPOSURE",
      rank: RISK_CONTROL_RANKS.AGGREGATE_EXPOSURE,
      reasonCodes: ["AGGREGATE_EXPOSURE"],
      hard: true,
    });
  }
  if (input.pauseNewEntries) {
    controls.push({
      kind: "PAUSE_NEW_ENTRIES",
      rank: RISK_CONTROL_RANKS.PAUSE_NEW_ENTRIES,
      reasonCodes: ["PAUSE_NEW_ENTRIES"],
      hard: true,
      detail: "Operator pause — exits still allowed",
    });
  }
  if (input.sessionClosedForEntry) {
    controls.push({
      kind: "SESSION_CLOSED",
      rank: RISK_CONTROL_RANKS.SESSION_CLOSED,
      reasonCodes: ["SESSION_CLOSED"],
      hard: true,
    });
  }
  if (input.dataStale) {
    controls.push({
      kind: "DATA_STALE",
      rank: RISK_CONTROL_RANKS.DATA_STALE,
      reasonCodes: ["DATA_STALE"],
      hard: true,
    });
  }

  controls.sort((a, b) => b.rank - a.rank);
  const hard = controls.filter((c) => c.hard);
  const dominantHard = hard[0] ?? null;
  return {
    controls,
    dominantHard,
    blocksNewEntries: dominantHard !== null,
    circuitBreakerOpen: input.circuitBreakerOpen,
    ackDoesNotClear: ["EMERGENCY_STOP", "CIRCUIT_BREAKER", "ENTRIES_SUSPENDED", "FLATTEN_INCOMPLETE"],
  };
}

/** True when acknowledging a DurableAlert must not clear this control kind. */
export function alertAckClearsControl(kind: RiskControlKind): boolean {
  return (
    kind !== "EMERGENCY_STOP" &&
    kind !== "CIRCUIT_BREAKER" &&
    kind !== "ENTRIES_SUSPENDED" &&
    kind !== "FLATTEN_INCOMPLETE"
  );
}
