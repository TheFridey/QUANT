import { d } from "@odin/shared";

export type ProtectionKind = "STOP" | "TAKE_PROFIT" | "TRAILING" | "TIME" | "BREAKEVEN";
export type ProtectionOrigin = "SYNTHETIC_ENGINE" | "VENUE_NATIVE";
export type PositionDirection = "LONG" | "SHORT";

export type ProtectionLeg = {
  id: string;
  kind: ProtectionKind;
  origin: ProtectionOrigin;
  /** Trigger price (absolute). For trailing, updated from peak/trough. */
  triggerPriceUsd: string | null;
  /** For trailing: distance pct from peak (long) or trough (short). */
  trailPct: string | null;
  ocoGroupId: string;
  status: "ARMED" | "TRIGGERED" | "SUBMITTED" | "CONFIRMED" | "CANCELLED" | "FILLED" | "FAILED";
};

export type OcoGroup = {
  id: string;
  positionKey: string;
  direction: PositionDirection;
  protectedQty: string;
  remainingQty: string;
  legs: ProtectionLeg[];
  /** Peak (long) or trough (short) for trailing. */
  extremePriceUsd: string | null;
};

/**
 * OCO (one-cancels-other): when one leg triggers/fills, siblings cancel.
 * Supports long and short: stop is adverse, take-profit is favorable.
 */
export function armOco(input: {
  groupId: string;
  positionKey: string;
  direction: PositionDirection;
  protectedQty: string;
  stopPriceUsd: string;
  takeProfitPriceUsd: string;
  origin?: ProtectionOrigin;
  extremePriceUsd?: string | null;
}): OcoGroup {
  const origin = input.origin ?? "SYNTHETIC_ENGINE";
  return {
    id: input.groupId,
    positionKey: input.positionKey,
    direction: input.direction,
    protectedQty: input.protectedQty,
    remainingQty: input.protectedQty,
    extremePriceUsd: input.extremePriceUsd ?? null,
    legs: [
      {
        id: `${input.groupId}:STOP`,
        kind: "STOP",
        origin,
        triggerPriceUsd: input.stopPriceUsd,
        trailPct: null,
        ocoGroupId: input.groupId,
        status: "ARMED",
      },
      {
        id: `${input.groupId}:TAKE_PROFIT`,
        kind: "TAKE_PROFIT",
        origin,
        triggerPriceUsd: input.takeProfitPriceUsd,
        trailPct: null,
        ocoGroupId: input.groupId,
        status: "ARMED",
      },
    ],
  };
}

export type OcoEval = {
  triggered: ProtectionLeg | null;
  cancelled: ProtectionLeg[];
  group: OcoGroup;
  /** True when a second trigger was ignored because the group already resolved. */
  raceSuppressed: boolean;
};

function stopHit(direction: PositionDirection, mark: ReturnType<typeof d>, trigger: string): boolean {
  return direction === "LONG" ? mark.lte(trigger) : mark.gte(trigger);
}

function takeProfitHit(direction: PositionDirection, mark: ReturnType<typeof d>, trigger: string): boolean {
  return direction === "LONG" ? mark.gte(trigger) : mark.lte(trigger);
}

/**
 * Evaluate mark against armed OCO legs. At most one leg may trigger;
 * siblings cancel. A second concurrent trigger is race-suppressed.
 * Trigger ≠ execution — caller must submit exit and advance to SUBMITTED/CONFIRMED/FILLED/FAILED.
 */
export function evaluateOco(group: OcoGroup, markUsd: string): OcoEval {
  const terminal = new Set(["TRIGGERED", "SUBMITTED", "CONFIRMED", "FILLED", "FAILED"]);
  if (group.legs.some((leg) => terminal.has(leg.status))) {
    return { triggered: null, cancelled: [], group, raceSuppressed: true };
  }
  const mark = d(markUsd);
  const armed = group.legs.filter((leg) => leg.status === "ARMED");
  const hits: ProtectionLeg[] = [];
  for (const leg of armed) {
    if (!leg.triggerPriceUsd) continue;
    if (leg.kind === "STOP" && stopHit(group.direction, mark, leg.triggerPriceUsd)) hits.push(leg);
    if (leg.kind === "TAKE_PROFIT" && takeProfitHit(group.direction, mark, leg.triggerPriceUsd)) hits.push(leg);
  }
  if (hits.length === 0) return { triggered: null, cancelled: [], group, raceSuppressed: false };

  // Deterministic winner: STOP before TAKE_PROFIT if both trip on same mark (gap-through).
  hits.sort((a, b) => (a.kind === "STOP" && b.kind !== "STOP" ? -1 : a.kind === b.kind ? 0 : 1));
  const winner = hits[0]!;
  const cancelled: ProtectionLeg[] = [];
  const nextLegs = group.legs.map((leg) => {
    if (leg.id === winner.id) return { ...leg, status: "TRIGGERED" as const };
    if (leg.status === "ARMED") {
      const cancelledLeg = { ...leg, status: "CANCELLED" as const };
      cancelled.push(cancelledLeg);
      return cancelledLeg;
    }
    return leg;
  });
  return {
    triggered: { ...winner, status: "TRIGGERED" },
    cancelled,
    group: { ...group, legs: nextLegs },
    raceSuppressed: hits.length > 1,
  };
}

/** Mark a triggered leg as failed synthetic exit — remains unresolved for retry. */
export function markProtectionFailed(group: OcoGroup, legId: string): OcoGroup {
  return {
    ...group,
    legs: group.legs.map((leg) => (leg.id === legId ? { ...leg, status: "FAILED" as const } : leg)),
  };
}

/** Advance TRIGGERED → SUBMITTED → CONFIRMED → FILLED. */
export function advanceProtectionLeg(
  group: OcoGroup,
  legId: string,
  status: "SUBMITTED" | "CONFIRMED" | "FILLED",
): OcoGroup {
  return {
    ...group,
    legs: group.legs.map((leg) => (leg.id === legId ? { ...leg, status } : leg)),
    remainingQty: status === "FILLED" ? "0.00000000" : group.remainingQty,
  };
}

/** Reduce protected qty after partial close; cancel OCO if remaining is zero. */
export function reduceProtectedQty(group: OcoGroup, closedQty: string): OcoGroup {
  const remaining = d(group.remainingQty).minus(closedQty);
  if (remaining.lte(0)) {
    return {
      ...group,
      remainingQty: "0.00000000",
      legs: group.legs.map((leg) =>
        leg.status === "ARMED" ? { ...leg, status: "CANCELLED" as const } : leg,
      ),
    };
  }
  return { ...group, remainingQty: remaining.toFixed(8) };
}

/** Breakeven stop: long moves stop up to entry; short moves stop down to entry. */
export function applyBreakeven(input: {
  direction: PositionDirection;
  entryPriceUsd: string;
  markUsd: string;
  activateAtPct: string;
  bufferPct?: string;
}): { armed: boolean; stopPriceUsd: string } {
  const entry = d(input.entryPriceUsd);
  if (entry.lte(0)) return { armed: false, stopPriceUsd: input.entryPriceUsd };
  const mark = d(input.markUsd);
  const gainPct =
    input.direction === "LONG"
      ? mark.minus(entry).div(entry).mul(100)
      : entry.minus(mark).div(entry).mul(100);
  if (gainPct.lt(input.activateAtPct)) return { armed: false, stopPriceUsd: input.entryPriceUsd };
  const buffer = d(input.bufferPct ?? "0").div(100);
  const stop =
    input.direction === "LONG" ? entry.mul(d("1").plus(buffer)) : entry.mul(d("1").minus(buffer));
  return { armed: true, stopPriceUsd: stop.toFixed(8) };
}

/** Update trailing extreme and stop from mark. */
export function updateTrailing(input: {
  direction: PositionDirection;
  markUsd: string;
  extremePriceUsd: string | null;
  trailPct: string;
}): { extremePriceUsd: string; stopPriceUsd: string } {
  const mark = d(input.markUsd);
  const trail = d(input.trailPct).div(100);
  let extreme = input.extremePriceUsd ? d(input.extremePriceUsd) : mark;
  if (input.direction === "LONG") {
    if (mark.gt(extreme)) extreme = mark;
    return {
      extremePriceUsd: extreme.toFixed(8),
      stopPriceUsd: extreme.mul(d("1").minus(trail)).toFixed(8),
    };
  }
  if (mark.lt(extreme)) extreme = mark;
  return {
    extremePriceUsd: extreme.toFixed(8),
    stopPriceUsd: extreme.mul(d("1").plus(trail)).toFixed(8),
  };
}
