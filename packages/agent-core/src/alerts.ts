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

/** Codes that imply account-wide entry suspension while unacked. */
export function isEntrySuspensionCode(code: string): boolean {
  return code === ALERT_CODES.ENTRIES_SUSPENDED;
}
