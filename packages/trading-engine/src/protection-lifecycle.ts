import { newId } from "@odin/shared";
import type { Prisma, PrismaClient } from "@odin/shared/db";
import {
  advanceProtectionLeg,
  amendProtectionTrigger,
  armOco,
  evaluateOco,
  markProtectionFailed,
  reduceProtectedQty,
  type OcoGroup,
  type PositionDirection,
  type ProtectionOrigin,
} from "./protection.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type DurableProtectionClaim =
  | { ok: true; group: OcoGroup; claimedLegId: string }
  | { ok: false; reason: "RACE_LOST" | "NOT_ARMED" | "GROUP_MISSING" };

/**
 * Persist OCO legs for a position. Idempotent on ocoGroupId.
 */
export async function persistOcoGroup(
  prisma: Db,
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
        confirmedTriggerPriceUsd: leg.confirmedTriggerPriceUsd ?? leg.triggerPriceUsd,
        desiredTriggerPriceUsd: leg.desiredTriggerPriceUsd ?? leg.triggerPriceUsd,
        trailPct: leg.trailPct,
        extremePriceUsd: input.group.extremePriceUsd,
        status: leg.status,
        ackState: leg.ackState ?? (leg.origin === "VENUE_NATIVE" ? "DESIRED_ONLY" : "ACKED"),
        strategyInstanceId: input.strategyInstanceId ?? null,
      },
    });
  }
}

export async function loadOcoGroup(
  prisma: Db,
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
    legs: legs.map((leg) => mapLeg(leg)),
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
  return prisma.$transaction(async (tx) => claimOcoTriggerInTx(tx, input));
}

/** Transactional claim usable inside an existing worker transaction. */
export async function claimOcoTriggerInTx(
  tx: Prisma.TransactionClient,
  input: { ocoGroupId: string; markUsd: string; workerId: string },
): Promise<DurableProtectionClaim> {
  const legs = await tx.protectionOrder.findMany({
    where: { ocoGroupId: input.ocoGroupId },
  });
  if (legs.length === 0) return { ok: false as const, reason: "GROUP_MISSING" as const };
  const group = await loadOcoGroupFromRows(legs);
  const evaled = evaluateOco(group, input.markUsd);
  if (!evaled.triggered) {
    // Another worker already claimed / terminalised the group.
    if (evaled.raceSuppressed) {
      return { ok: false as const, reason: "RACE_LOST" as const };
    }
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
  const group = armOco({
    groupId: input.groupId,
    positionKey: input.positionKey,
    direction: input.direction,
    protectedQty: input.qty,
    stopPriceUsd: stop.toFixed(8),
    takeProfitPriceUsd: tp.toFixed(8),
    origin: input.origin,
    extremePriceUsd: input.entryPriceUsd,
  });
  const origin = input.origin ?? "SYNTHETIC_ENGINE";
  return {
    ...group,
    legs: group.legs.map((leg) => ({
      ...leg,
      confirmedTriggerPriceUsd: origin === "SYNTHETIC_ENGINE" ? leg.triggerPriceUsd : null,
      desiredTriggerPriceUsd: leg.triggerPriceUsd,
      ackState: origin === "SYNTHETIC_ENGINE" ? ("ACKED" as const) : ("DESIRED_ONLY" as const),
    })),
  };
}

/**
 * Persist amendment outcome. Failure keeps confirmedTriggerPriceUsd on the row.
 */
export async function amendProtectionTriggerInTx(
  tx: Prisma.TransactionClient,
  input: {
    ocoGroupId: string;
    legId: string;
    nextTriggerPriceUsd: string;
    outcome: { ok: true } | { ok: false; error: string };
  },
): Promise<{ ok: boolean; keptConfirmed: boolean; error: string | null }> {
  const group = await loadOcoGroup(tx, input.ocoGroupId);
  if (!group) return { ok: false, keptConfirmed: false, error: "GROUP_MISSING" };
  const amended = amendProtectionTrigger(group, input.legId, input.nextTriggerPriceUsd, input.outcome);
  const leg = amended.group.legs.find((item) => item.id === input.legId);
  if (!leg) return { ok: false, keptConfirmed: false, error: "LEG_MISSING" };
  await tx.protectionOrder.updateMany({
    where: { id: input.legId },
    data: {
      triggerPriceUsd: leg.triggerPriceUsd,
      confirmedTriggerPriceUsd: leg.confirmedTriggerPriceUsd ?? leg.triggerPriceUsd,
      desiredTriggerPriceUsd: leg.desiredTriggerPriceUsd ?? input.nextTriggerPriceUsd,
      ackState: leg.ackState ?? "UNKNOWN",
      status: leg.status,
    },
  });
  if (!input.outcome.ok) {
    await tx.protectionIntent.create({
      data: {
        id: newId("protint"),
        accountId: (
          await tx.protectionOrder.findFirst({ where: { id: input.legId }, select: { accountId: true } })
        )?.accountId ?? "primary",
        ocoGroupId: input.ocoGroupId,
        legId: input.legId,
        status: "UNRESOLVED",
        reason: `AMENDMENT_FAILED_KEEP_CONFIRMED:${input.outcome.error}`,
        retryAfter: new Date(Date.now() + 5_000),
        attempts: 1,
      },
    });
  }
  return { ok: input.outcome.ok, keptConfirmed: amended.keptConfirmed, error: amended.error };
}

/**
 * After worker crash: restore ARMED legs from confirmedTriggerPriceUsd when desired diverged,
 * and surface durable UNRESOLVED intents that still need exit retry.
 */
export async function recoverProtectionAfterRestart(
  prisma: PrismaClient,
  input: { accountId: string },
): Promise<{ restoredLegs: number; unresolvedIntents: number }> {
  const legs = await prisma.protectionOrder.findMany({
    where: {
      accountId: input.accountId,
      status: { in: ["ARMED", "FAILED", "TRIGGERED", "SUBMITTED"] },
    },
  });
  let restoredLegs = 0;
  for (const leg of legs) {
    const confirmed = leg.confirmedTriggerPriceUsd?.toString() ?? null;
    const desired = leg.desiredTriggerPriceUsd?.toString() ?? null;
    const live = leg.triggerPriceUsd?.toString() ?? null;
    if (confirmed && desired && confirmed !== desired && live !== confirmed) {
      await prisma.protectionOrder.update({
        where: { id: leg.id },
        data: {
          triggerPriceUsd: confirmed,
          ackState: "ACKED",
        },
      });
      restoredLegs += 1;
    }
    // TRIGGERED/SUBMITTED without fill after crash → FAILED + UNRESOLVED intent if none exists.
    if (leg.status === "TRIGGERED" || leg.status === "SUBMITTED") {
      const existing = await prisma.protectionIntent.findFirst({
        where: { legId: leg.id, status: "UNRESOLVED" },
      });
      if (!existing) {
        await prisma.protectionOrder.update({
          where: { id: leg.id },
          data: { status: "FAILED" },
        });
        await prisma.protectionIntent.create({
          data: {
            id: newId("protint"),
            accountId: input.accountId,
            ocoGroupId: leg.ocoGroupId,
            legId: leg.id,
            status: "UNRESOLVED",
            reason: "WORKER_RESTART_UNRESOLVED",
            retryAfter: new Date(Date.now() + 1_000),
            attempts: 0,
          },
        });
      }
    }
  }
  const unresolvedIntents = await prisma.protectionIntent.count({
    where: { accountId: input.accountId, status: "UNRESOLVED" },
  });
  return { restoredLegs, unresolvedIntents };
}

function mapLeg(leg: {
  id: string;
  kind: string;
  origin: string;
  triggerPriceUsd: { toString(): string } | null;
  confirmedTriggerPriceUsd?: { toString(): string } | null;
  desiredTriggerPriceUsd?: { toString(): string } | null;
  trailPct: { toString(): string } | null;
  ocoGroupId: string;
  status: string;
  ackState?: string | null;
}): OcoGroup["legs"][number] {
  return {
    id: leg.id,
    kind: leg.kind as OcoGroup["legs"][number]["kind"],
    origin: leg.origin as ProtectionOrigin,
    triggerPriceUsd: leg.triggerPriceUsd?.toString() ?? null,
    confirmedTriggerPriceUsd: leg.confirmedTriggerPriceUsd?.toString() ?? null,
    desiredTriggerPriceUsd: leg.desiredTriggerPriceUsd?.toString() ?? null,
    trailPct: leg.trailPct?.toString() ?? null,
    ocoGroupId: leg.ocoGroupId,
    status: leg.status as OcoGroup["legs"][number]["status"],
    ackState: (leg.ackState as OcoGroup["legs"][number]["ackState"]) ?? undefined,
  };
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
    confirmedTriggerPriceUsd?: { toString(): string } | null;
    desiredTriggerPriceUsd?: { toString(): string } | null;
    trailPct: { toString(): string } | null;
    extremePriceUsd: { toString(): string } | null;
    status: string;
    ackState?: string | null;
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
    legs: legs.map((leg) => mapLeg(leg)),
  };
}

export {
  advanceProtectionLeg,
  amendProtectionTrigger,
  markProtectionFailed,
  reduceProtectedQty,
  evaluateOco,
  armOco,
};
