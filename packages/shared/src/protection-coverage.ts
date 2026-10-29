import { d } from "./money.js";
import { positionKeysEqual } from "./position-key.js";

/**
 * Derive protection coverage from active current-position stop quantity (R12 / D06).
 * Never treat historical FAILED / terminal rows as "protected".
 * Exact positionKey + lifecycle matching only — no delimiter parsing or suffix fallback.
 * Desired-only venue-native stops are never protected=true.
 */

export const EFFECTIVE_PROTECTION_STATUSES = ["ARMED", "TRIGGERED", "SUBMITTED", "CONFIRMED"] as const;
export type EffectiveProtectionStatus = (typeof EFFECTIVE_PROTECTION_STATUSES)[number];

export type ProtectionCoverageStatus =
  | "PROTECTED"
  | "EXIT_IN_PROGRESS"
  | "FAILED"
  | "UNKNOWN"
  | "UNPROTECTED";

export type ProtectionLegView = {
  positionKey: string;
  lifecycleId?: string | null;
  kind: string;
  origin: string;
  status: string;
  remainingQty: string;
  protectedQty: string;
  ackState?: string | null;
  triggerPriceUsd?: string | null;
  confirmedTriggerPriceUsd?: string | null;
};

export type PositionCoverageInput = {
  positionKey: string;
  lifecycleId?: string | null;
  baseQty: string;
  legs: ProtectionLegView[];
};

export type PositionCoverage = {
  positionKey: string;
  status: ProtectionCoverageStatus;
  protected: boolean;
  effectiveStopQty: string;
  uncoveredQty: string;
  origin: string | null;
  stopTriggerUsd: string | null;
  kinds: string[];
  statuses: string[];
  recoveryNeeded: boolean;
};

function isEffective(status: string): boolean {
  return (EFFECTIVE_PROTECTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Exact identity match. When the position has a known lifecycleId, legs with a
 * different or null lifecycleId are excluded (D06).
 */
function matchesPosition(
  leg: ProtectionLegView,
  positionKey: string,
  lifecycleId?: string | null,
): boolean {
  if (!positionKeysEqual(leg.positionKey, positionKey)) return false;
  if (lifecycleId) {
    if (!leg.lifecycleId || leg.lifecycleId !== lifecycleId) return false;
  }
  return true;
}

/** Venue-native coverage requires acknowledgement — DESIRED_ONLY is never protected. */
function isConfirmedNativeCoverage(leg: ProtectionLegView): boolean {
  if (leg.origin !== "VENUE_NATIVE" && leg.origin !== "BROKER_NATIVE") return true;
  const ack = (leg.ackState ?? "").toUpperCase();
  if (ack === "DESIRED_ONLY" || ack === "SUBMITTED" || ack === "REJECTED" || ack === "UNKNOWN") {
    return false;
  }
  return ack === "ACKED" || ack === "CONFIRMED" || ack === "";
}

function hasUsableTrigger(leg: ProtectionLegView): boolean {
  return (leg.confirmedTriggerPriceUsd ?? leg.triggerPriceUsd) != null;
}

export function derivePositionProtectionCoverage(input: PositionCoverageInput): PositionCoverage {
  const legs = input.legs.filter((leg) => matchesPosition(leg, input.positionKey, input.lifecycleId));
  const stopLegs = legs.filter((leg) => leg.kind === "STOP" || leg.kind === "TRAILING");
  const armedStops = stopLegs.filter(
    (leg) => leg.status === "ARMED" && isConfirmedNativeCoverage(leg) && hasUsableTrigger(leg),
  );
  const exitInProgress = stopLegs.some(
    (leg) =>
      leg.status === "TRIGGERED" || leg.status === "SUBMITTED" || leg.status === "CONFIRMED",
  );
  const failedOnly =
    stopLegs.length > 0 &&
    stopLegs.every(
      (leg) => leg.status === "FAILED" || leg.status === "CANCELLED" || leg.status === "FILLED",
    ) &&
    stopLegs.some((leg) => leg.status === "FAILED");

  let effectiveStopQty = d("0");
  for (const leg of armedStops) {
    const qty = d(leg.remainingQty || leg.protectedQty || "0");
    if (qty.gt(effectiveStopQty)) effectiveStopQty = qty;
  }

  const baseQty = d(input.baseQty);
  const uncovered = baseQty.gt(effectiveStopQty) ? baseQty.minus(effectiveStopQty) : d("0");
  const hasValidArmedStop = armedStops.length > 0 && effectiveStopQty.gt(0);

  let status: ProtectionCoverageStatus = "UNPROTECTED";
  if (hasValidArmedStop && uncovered.lte(0)) status = "PROTECTED";
  else if (exitInProgress) status = "EXIT_IN_PROGRESS";
  else if (failedOnly) status = "FAILED";
  else if (legs.length > 0 && !hasValidArmedStop) status = "UNKNOWN";
  else if (hasValidArmedStop && uncovered.gt(0)) status = "UNKNOWN";

  const bestStop = armedStops[0] ?? stopLegs.find((l) => isEffective(l.status)) ?? null;

  return {
    positionKey: input.positionKey,
    status,
    protected: status === "PROTECTED",
    effectiveStopQty: effectiveStopQty.toFixed(8),
    uncoveredQty: uncovered.toFixed(8),
    origin: bestStop?.origin ?? legs[0]?.origin ?? null,
    stopTriggerUsd: bestStop?.confirmedTriggerPriceUsd ?? bestStop?.triggerPriceUsd ?? null,
    kinds: [
      ...new Set(
        legs.filter((l) => isEffective(l.status) || l.status === "FAILED").map((l) => l.kind),
      ),
    ],
    statuses: [...new Set(legs.map((l) => l.status))],
    recoveryNeeded: status === "FAILED" || status === "UNPROTECTED" || status === "UNKNOWN",
  };
}

/**
 * Aggregate coverage across many legs without truncating active ARMED coverage.
 * Prefer calling with a full account scan (paginate until exhausted) rather than take:100.
 */
export function aggregateProtectionCoverage(
  positions: Array<{ positionKey: string; lifecycleId?: string | null; baseQty: string }>,
  legs: ProtectionLegView[],
): PositionCoverage[] {
  return positions.map((position) =>
    derivePositionProtectionCoverage({
      positionKey: position.positionKey,
      lifecycleId: position.lifecycleId,
      baseQty: position.baseQty,
      legs,
    }),
  );
}
