import { newId } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import {
  advanceProtectionLeg,
  armOco,
  evaluateOco,
  markProtectionFailed,
  reduceProtectedQty,
  type OcoGroup,
  type PositionDirection,
  type ProtectionOrigin,
} from "./protection.js";

export type DurableProtectionClaim =
  | { ok: true; group: OcoGroup; claimedLegId: string }
  | { ok: false; reason: "RACE_LOST" | "NOT_ARMED" | "GROUP_MISSING" };

/**
 * Persist OCO legs for a position. Idempotent on ocoGroupId.
 */
export async function persistOcoGroup(
  prisma: PrismaClient,
  input: {
    accountId: string;
    group: OcoGroup;
    strategyInstanceId?: string | null;
  },
): Promise<void> {
  const existing = await prisma.protectionOrder.count({ where: { ocoGroupId: input.group.id } });
  if (existing > 0) return;
  for (const leg of input.group.legs) {
    await prisma.protectionOrder.create({
      data: {
        id: leg.id,
        accountId: input.accountId,
        positionKey: input.group.positionKey,
        ocoGroupId: input.group.id,
        kind: leg.kind,
        origin: leg.origin,
        direction: input.group.direction,
        protectedQty: input.group.protectedQty,
        remainingQty: input.group.remainingQty,
        triggerPriceUsd: leg.triggerPriceUsd,
        trailPct: leg.trailPct,
        extremePriceUsd: input.group.extremePriceUsd,
        status: leg.status,
        strategyInstanceId: input.strategyInstanceId ?? null,
      },
    });
  }
}

export async function loadOcoGroup(
  prisma: PrismaClient,
  ocoGroupId: string,
): Promise<OcoGroup | null> {
  const legs = await prisma.protectionOrder.findMany({ where: { ocoGroupId } });
  if (legs.length === 0) return null;
  const first = legs[0]!;
  return {
    id: ocoGroupId,
    positionKey: first.positionKey,
    direction: (first.direction as PositionDirection) || "LONG",
    protectedQty: first.protectedQty.toString(),
    remainingQty: first.remainingQty.toString(),
    extremePriceUsd: first.extremePriceUsd?.toString() ?? null,
    legs: legs.map((leg) => ({
      id: leg.id,
      kind: leg.kind as OcoGroup["legs"][number]["kind"],
      origin: leg.origin as ProtectionOrigin,
      triggerPriceUsd: leg.triggerPriceUsd?.toString() ?? null,
      trailPct: leg.trailPct?.toString() ?? null,
      ocoGroupId: leg.ocoGroupId,
      status: leg.status as OcoGroup["legs"][number]["status"],
    })),
  };
}

/**
 * Transactional claim: evaluate mark, claim TRIGGERED leg with COMPARE status update.
 * Two workers racing → exactly one claim wins.
 */
export async function claimOcoTrigger(
  prisma: PrismaClient,
  input: { ocoGroupId: string; markUsd: string; workerId: string },
): Promise<DurableProtectionClaim> {
  return prisma.$transaction(async (tx) => {
    const legs = await tx.protectionOrder.findMany({
      where: { ocoGroupId: input.ocoGroupId },
    });
    if (legs.length === 0) return { ok: false as const, reason: "GROUP_MISSING" as const };
    const group = await loadOcoGroupFromRows(legs);
    const evaled = evaluateOco(group, input.markUsd);
    if (!evaled.triggered) {
      return { ok: false as const, reason: "NOT_ARMED" as const };
    }
    const claimed = await tx.protectionOrder.updateMany({
      where: { id: evaled.triggered.id, status: "ARMED" },
      data: { status: "TRIGGERED", claimWorkerId: input.workerId },
    });
    if (claimed.count !== 1) {
      return { ok: false as const, reason: "RACE_LOST" as const };
    }
    for (const cancelled of evaled.cancelled) {
      await tx.protectionOrder.updateMany({
        where: { id: cancelled.id, status: "ARMED" },
        data: { status: "CANCELLED" },
      });
    }
    const next = await loadOcoGroupFromRows(
      await tx.protectionOrder.findMany({ where: { ocoGroupId: input.ocoGroupId } }),
    );
    return { ok: true as const, group: next, claimedLegId: evaled.triggered.id };
  });
}

/**
 * Failed synthetic exit → durable unresolved intent + alert payload; do NOT suppress permanently.
 */
export async function recordFailedProtectionExit(
  prisma: PrismaClient,
  input: {
    accountId: string;
    ocoGroupId: string;
    legId: string;
    reason: string;
    retryAfterMs?: number;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.protectionOrder.updateMany({
      where: { id: input.legId },
      data: { status: "FAILED" },
    });
    await tx.protectionIntent.create({
      data: {
        id: newId("protint"),
        accountId: input.accountId,
        ocoGroupId: input.ocoGroupId,
        legId: input.legId,
        status: "UNRESOLVED",
        reason: input.reason,
        retryAfter: new Date(Date.now() + (input.retryAfterMs ?? 5_000)),
        attempts: 1,
      },
    });
    await tx.durableAlert.create({
      data: {
        severity: "ERROR",
        code: "PROTECTION_EXIT_FAILED",
        message: input.reason,
        acked: false,
        payload: {
          ocoGroupId: input.ocoGroupId,
          legId: input.legId,
          unresolved: true,
        },
      },
    });
  });
}

/** Retry unresolved intents whose retryAfter has passed — does not auto-ACK alerts. */
export async function retryUnresolvedProtectionIntents(
  prisma: PrismaClient,
  input: {
    now?: Date;
    attemptExit: (intent: {
      id: string;
      ocoGroupId: string;
      legId: string;
      accountId: string;
    }) => Promise<{ ok: boolean; error?: string }>;
  },
): Promise<{ attempted: number; resolved: number; stillUnresolved: number }> {
  const now = input.now ?? new Date();
  const due = await prisma.protectionIntent.findMany({
    where: { status: "UNRESOLVED", retryAfter: { lte: now } },
    take: 50,
  });
  let resolved = 0;
  let stillUnresolved = 0;
  for (const intent of due) {
    const result = await input.attemptExit({
      id: intent.id,
      ocoGroupId: intent.ocoGroupId,
      legId: intent.legId,
      accountId: intent.accountId,
    });
    if (result.ok) {
      await prisma.protectionIntent.update({
        where: { id: intent.id },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      await prisma.protectionOrder.updateMany({
        where: { id: intent.legId },
        data: { status: "FILLED" },
      });
      resolved += 1;
    } else {
      await prisma.protectionIntent.update({
        where: { id: intent.id },
        data: {
          attempts: intent.attempts + 1,
          retryAfter: new Date(now.getTime() + 5_000 * (intent.attempts + 1)),
          reason: result.error ?? intent.reason,
        },
      });
      stillUnresolved += 1;
    }
  }
  return { attempted: due.length, resolved, stillUnresolved };
}

export function armLongShortOco(input: {
  groupId: string;
  positionKey: string;
  direction: PositionDirection;
  qty: string;
  entryPriceUsd: string;
  stopLossPct: string;
  takeProfitPct: string;
  origin?: ProtectionOrigin;
}): OcoGroup {
  const entry = Number(input.entryPriceUsd);
  const stopPct = Number(input.stopLossPct) / 100;
  const tpPct = Number(input.takeProfitPct) / 100;
  const stop =
    input.direction === "LONG" ? entry * (1 - stopPct) : entry * (1 + stopPct);
  const tp =
    input.direction === "LONG" ? entry * (1 + tpPct) : entry * (1 - tpPct);
  return armOco({
    groupId: input.groupId,
    positionKey: input.positionKey,
    direction: input.direction,
    protectedQty: input.qty,
    stopPriceUsd: stop.toFixed(8),
    takeProfitPriceUsd: tp.toFixed(8),
    origin: input.origin,
    extremePriceUsd: input.entryPriceUsd,
  });
}

async function loadOcoGroupFromRows(
  legs: Array<{
    id: string;
    positionKey: string;
    ocoGroupId: string;
    kind: string;
    origin: string;
    direction: string;
    protectedQty: { toString(): string };
    remainingQty: { toString(): string };
    triggerPriceUsd: { toString(): string } | null;
    trailPct: { toString(): string } | null;
    extremePriceUsd: { toString(): string } | null;
    status: string;
  }>,
): Promise<OcoGroup> {
  const first = legs[0]!;
  return {
    id: first.ocoGroupId,
    positionKey: first.positionKey,
    direction: (first.direction as PositionDirection) || "LONG",
    protectedQty: first.protectedQty.toString(),
    remainingQty: first.remainingQty.toString(),
    extremePriceUsd: first.extremePriceUsd?.toString() ?? null,
    legs: legs.map((leg) => ({
      id: leg.id,
      kind: leg.kind as OcoGroup["legs"][number]["kind"],
      origin: leg.origin as ProtectionOrigin,
      triggerPriceUsd: leg.triggerPriceUsd?.toString() ?? null,
      trailPct: leg.trailPct?.toString() ?? null,
      ocoGroupId: leg.ocoGroupId,
      status: leg.status as OcoGroup["legs"][number]["status"],
    })),
  };
}

export { advanceProtectionLeg, markProtectionFailed, reduceProtectedQty, evaluateOco, armOco };
