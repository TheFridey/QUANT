/**
 * Account-scoped safety controls independent of DurableAlert acknowledgement (R06 / D05).
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

/**
 * Codes that block new risk expansion (ENTRY / OPERATOR buys).
 * Exits, protection retry, and flatten remain available.
 */
export const ENTRY_BLOCKING_SAFETY_CODES: readonly SafetyCode[] = [
  SAFETY_CODES.ENTRIES_SUSPENDED,
  SAFETY_CODES.PROTECTION_RECOVERY,
  SAFETY_CODES.RECONCILE_ISSUE,
  SAFETY_CODES.CIRCUIT_BREAKER,
  SAFETY_CODES.FLATTEN_INCOMPLETE,
];

/** True when an ACTIVE safety control blocks new buys / risk expansion (D05). */
export function entriesSuspendedFromSafety(
  rows: Array<{ code: string; status: string }>,
): boolean {
  return rows.some(
    (row) =>
      row.status === "ACTIVE" &&
      (ENTRY_BLOCKING_SAFETY_CODES as readonly string[]).includes(row.code),
  );
}

/** Alert ACK must never be treated as resolving these codes. */
export function alertAckClearsSafetyCode(_code: string): boolean {
  return false;
}
