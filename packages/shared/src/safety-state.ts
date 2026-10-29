/**
 * Account-scoped safety controls independent of DurableAlert acknowledgement (R06).
 * Alert ACK never clears ACTIVE controls — only resolveSafetyState / clean reconcile.
 */

export const SAFETY_STATUS = ["ACTIVE", "RESOLVED"] as const;
export type SafetyStatus = (typeof SAFETY_STATUS)[number];

export const SAFETY_CODES = {
  ENTRIES_SUSPENDED: "ENTRIES_SUSPENDED",
  RECONCILE_ISSUE: "RECONCILE_ISSUE",
  CIRCUIT_BREAKER: "CIRCUIT_BREAKER",
  FLATTEN_INCOMPLETE: "FLATTEN_INCOMPLETE",
  PROTECTION_RECOVERY: "PROTECTION_RECOVERY",
} as const;

export type SafetyCode = (typeof SAFETY_CODES)[keyof typeof SAFETY_CODES];

export type SafetyStateRow = {
  accountId: string;
  code: string;
  status: SafetyStatus;
  detail?: Record<string, unknown> | null;
  activatedAt: Date | string;
  resolvedAt?: Date | string | null;
};

/** True when an ACTIVE ENTRIES_SUSPENDED (or equivalent) blocks new buys. */
export function entriesSuspendedFromSafety(
  rows: Array<{ code: string; status: string }>,
): boolean {
  return rows.some(
    (row) => row.status === "ACTIVE" && row.code === SAFETY_CODES.ENTRIES_SUSPENDED,
  );
}

/** Alert ACK must never be treated as resolving these codes. */
export function alertAckClearsSafetyCode(_code: string): boolean {
  return false;
}
