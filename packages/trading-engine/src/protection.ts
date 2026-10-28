import { d } from "@odin/shared";

export type ProtectionKind = "STOP" | "TAKE_PROFIT" | "TRAILING" | "TIME" | "BREAKEVEN";
export type ProtectionOrigin = "SYNTHETIC_ENGINE" | "VENUE_NATIVE";

export type ProtectionLeg = {
  id: string;
  kind: ProtectionKind;
  origin: ProtectionOrigin;
  triggerPriceUsd: string | null;
  /** For trailing: distance pct from peak. */
  trailPct: string | null;
  ocoGroupId: string;
  status: "ARMED" | "TRIGGERED" | "CANCELLED" | "FILLED";
};

export type OcoGroup = {
  id: string;
  positionKey: string;
  legs: ProtectionLeg[];
};

/**
 * OCO (one-cancels-other): when one leg triggers/fills, siblings cancel.
 * Prevents double-close or accidental reverse from racing stop/target.
 */
export function armOco(input: {
  groupId: string;
  positionKey: string;
  stopPriceUsd: string;
  takeProfitPriceUsd: string;
  origin?: ProtectionOrigin;
}): OcoGroup {
  const origin = input.origin ?? "SYNTHETIC_ENGINE";
  return {
    id: input.groupId,
    positionKey: input.positionKey,
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

/**
 * Evaluate mark against armed OCO legs. At most one leg may trigger;
 * siblings cancel. A second concurrent trigger is race-suppressed.
 */
export function evaluateOco(group: OcoGroup, markUsd: string): OcoEval {
  if (group.legs.some((leg) => leg.status === "TRIGGERED" || leg.status === "FILLED")) {
    return { triggered: null, cancelled: [], group, raceSuppressed: true };
  }
  const mark = d(markUsd);
  const armed = group.legs.filter((leg) => leg.status === "ARMED");
  const hits: ProtectionLeg[] = [];
  for (const leg of armed) {
    if (!leg.triggerPriceUsd) continue;
    if (leg.kind === "STOP" && mark.lte(leg.triggerPriceUsd)) hits.push(leg);
    if (leg.kind === "TAKE_PROFIT" && mark.gte(leg.triggerPriceUsd)) hits.push(leg);
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

/** Breakeven stop: move stop to entry (+ optional buffer) once mark reaches trigger. */
export function applyBreakeven(input: {
  entryPriceUsd: string;
  markUsd: string;
  activateAtPct: string;
  bufferPct?: string;
}): { armed: boolean; stopPriceUsd: string } {
  const entry = d(input.entryPriceUsd);
  if (entry.lte(0)) return { armed: false, stopPriceUsd: input.entryPriceUsd };
  const gainPct = d(input.markUsd).minus(entry).div(entry).mul(100);
  if (gainPct.lt(input.activateAtPct)) return { armed: false, stopPriceUsd: input.entryPriceUsd };
  const buffer = d(input.bufferPct ?? "0").div(100);
  return { armed: true, stopPriceUsd: entry.mul(d("1").plus(buffer)).toFixed(8) };
}
