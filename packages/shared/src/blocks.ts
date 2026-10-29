import type { ReasonCode } from "./reasons.js";

/**
 * Hard blocks vs advisories (B29).
 * Hard blocks must reject admission; advisories never alone authorize risk.
 */
export const HARD_BLOCK_REASONS = new Set<ReasonCode>([
  "DATA_STALE",
  "DATA_REPLAY",
  "DATA_DEMO",
  "ENGINE_HALTED",
  "PAUSE_NEW_ENTRIES",
  "ENTRIES_SUSPENDED",
  "EMERGENCY_STOP",
  "DAILY_LOSS_LIMIT",
  "DAILY_PNL_UNAVAILABLE",
  "MAX_POSITIONS",
  "MARK_UNAVAILABLE",
  "VALUATION_NOT_LIVE",
  "AGGREGATE_EXPOSURE",
  "TOTAL_DRAWDOWN_LIMIT",
  "CIRCUIT_BREAKER",
  "SECURITY_BLOCK",
  "SECURITY_UNKNOWN",
  "INDEX_NO_EXECUTION",
  "RESEARCH_ONLY",
  "NO_EXECUTION",
  "PRODUCT_SEMANTICS_UNSUPPORTED",
  "FIXTURE_ISOLATION",
  "PROVIDER_NOT_READY",
  "MISSING_CREDENTIALS",
  "RESERVATION_REJECTED",
  "BLOCKED_EXTERNAL",
]);

export const ADVISORY_REASONS = new Set<ReasonCode>([
  "ADVISORY_ONLY",
  "MANIPULATION_WARNING",
  "SECURITY_REVIEW",
  "DATA_DELAYED",
  "DATA_DELAYED_EXIT_ALLOWED",
  "SAMPLE_SIZE_LOW",
]);

export function isHardBlock(code: string): boolean {
  return HARD_BLOCK_REASONS.has(code as ReasonCode);
}

export function isAdvisory(code: string): boolean {
  return ADVISORY_REASONS.has(code as ReasonCode);
}

/** UNKNOWN security is never PASS — treated as hard block for Solana entries. */
export function securityAllowsEntry(category: string | null | undefined): boolean {
  if (!category) return false;
  if (category === "PASS") return true;
  if (category === "UNKNOWN" || category === "BLOCK" || category === "REVIEW") return false;
  return false;
}

export function classifyReasonCodes(codes: string[]): {
  hardBlocks: string[];
  advisories: string[];
  other: string[];
} {
  const hardBlocks: string[] = [];
  const advisories: string[] = [];
  const other: string[] = [];
  for (const code of codes) {
    if (isHardBlock(code)) hardBlocks.push(code);
    else if (isAdvisory(code)) advisories.push(code);
    else other.push(code);
  }
  return { hardBlocks, advisories, other };
}
