export type AlertSeverity = "INFO" | "WARN" | "CRITICAL";

export type DurableAlertDraft = {
  severity: AlertSeverity;
  code: string;
  message: string;
  payload?: Record<string, unknown>;
};

export const ALERT_CODES = {
  ENTRIES_SUSPENDED: "ENTRIES_SUSPENDED",
  LIVE_GATE_REFUSED: "LIVE_GATE_REFUSED",
  CIRCUIT_BREAKER: "CIRCUIT_BREAKER",
  CONFIG_INVALID: "CONFIG_INVALID",
  FLATTEN_INCOMPLETE: "FLATTEN_INCOMPLETE",
  RECONCILE_ISSUE: "RECONCILE_ISSUE",
  PROTECTION_UNRESOLVED: "PROTECTION_UNRESOLVED",
  SESSION_CLOSED: "SESSION_CLOSED",
  PROVIDER_NOT_READY: "PROVIDER_NOT_READY",
} as const;

export function entriesSuspendedAlert(detail: Record<string, unknown>): DurableAlertDraft {
  return {
    severity: "CRITICAL",
    code: ALERT_CODES.ENTRIES_SUSPENDED,
    message: "New entries suspended after reconcile unknown exposure or qty mismatch",
    payload: detail,
  };
}

export function reconcileIssueAlert(detail: Record<string, unknown>): DurableAlertDraft {
  return {
    severity: "WARN",
    code: ALERT_CODES.RECONCILE_ISSUE,
    message: "Reconcile reported durable ledger/broker mismatch",
    payload: detail,
  };
}

export function liveGateAlert(reason: string, mode: string): DurableAlertDraft {
  return {
    severity: "CRITICAL",
    code: ALERT_CODES.LIVE_GATE_REFUSED,
    message: `Execution refused: ${reason}`,
    payload: { mode, reason },
  };
}

export function circuitBreakerAlert(detail: Record<string, unknown>): DurableAlertDraft {
  return {
    severity: "CRITICAL",
    code: ALERT_CODES.CIRCUIT_BREAKER,
    message: "Independent portfolio circuit breaker is open — ACK does not reset breaker state",
    payload: detail,
  };
}

export function protectionUnresolvedAlert(detail: Record<string, unknown>): DurableAlertDraft {
  return {
    severity: "WARN",
    code: ALERT_CODES.PROTECTION_UNRESOLVED,
    message: "Durable protection intent remains UNRESOLVED — ACK of this alert does not clear the intent",
    payload: detail,
  };
}

export function providerNotReadyAlert(providerId: string, readiness: string): DurableAlertDraft {
  return {
    severity: "INFO",
    code: ALERT_CODES.PROVIDER_NOT_READY,
    message: `Provider ${providerId} readiness=${readiness} — no invented market levels`,
    payload: { providerId, readiness },
  };
}

/** Codes that imply account-wide entry suspension while unacked. */
export function isEntrySuspensionCode(code: string): boolean {
  return code === ALERT_CODES.ENTRIES_SUSPENDED;
}

/** Codes whose DurableAlert ACK must never clear the underlying safety control. */
export function alertAckDoesNotClearSafety(code: string): boolean {
  return (
    code === ALERT_CODES.ENTRIES_SUSPENDED ||
    code === ALERT_CODES.CIRCUIT_BREAKER ||
    code === ALERT_CODES.FLATTEN_INCOMPLETE ||
    code === ALERT_CODES.PROTECTION_UNRESOLVED ||
    code === ALERT_CODES.LIVE_GATE_REFUSED
  );
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { CRITICAL: 30, WARN: 20, INFO: 10 };

/** Sort open alerts for ops: severity desc, then newest first. */
export function sortAlertsForOps<T extends { severity: string; createdAt: string | Date }>(alerts: T[]): T[] {
  return [...alerts].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity as AlertSeverity] ?? 0;
    const sb = SEVERITY_RANK[b.severity as AlertSeverity] ?? 0;
    if (sb !== sa) return sb - sa;
    const ta = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : a.createdAt.getTime();
    const tb = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : b.createdAt.getTime();
    return tb - ta;
  });
}
