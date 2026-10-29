import { d, newId, usd } from "@odin/shared";
import type { Prisma, PrismaClient } from "@odin/shared/db";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Position/lot lifecycle helpers (R01).
 * Opening qty mints a lifecycleId; flat clears it. Protection + open meta scope to this id.
 */

export function protectionGroupId(accountId: string, pairAddress: string, lifecycleId: string): string {
  return `oco_${accountId}_${pairAddress}_${lifecycleId}`;
}

export async function ensurePositionLifecycleOnOpen(
  db: Db,
  input: {
    accountId: string;
    pairAddress: string;
    /** Qty after this fill. */
    nextBaseQty: string;
    /** Qty before this fill (optional — inferred from current row when omitted). */
    priorBaseQty?: string | null;
  },
): Promise<string | null> {
  const next = d(input.nextBaseQty);
  const position = await db.position.findUnique({
    where: {
      accountId_pairAddress: { accountId: input.accountId, pairAddress: input.pairAddress },
    },
  });
  const prior = input.priorBaseQty != null ? d(input.priorBaseQty) : d(position?.baseQty.toString() ?? "0");

  if (next.lte(0)) {
    if (position?.lifecycleId) {
      await db.position.update({
        where: { accountId_pairAddress: { accountId: input.accountId, pairAddress: input.pairAddress } },
        data: { lifecycleId: null },
      });
      // Cancel any remaining ARMED legs for the closing lifecycle.
      await db.protectionOrder.updateMany({
        where: {
          accountId: input.accountId,
          lifecycleId: position.lifecycleId,
          status: "ARMED",
        },
        data: { status: "CANCELLED", remainingQty: 0 },
      });
    }
    return null;
  }

  if (prior.lte(0) || !position?.lifecycleId) {
    const lifecycleId = newId("lot");
    await db.position.update({
      where: { accountId_pairAddress: { accountId: input.accountId, pairAddress: input.pairAddress } },
      data: { lifecycleId },
    });
    return lifecycleId;
  }
  return position.lifecycleId;
}

export async function reduceProtectionForFill(
  db: Db,
  input: {
    accountId: string;
    pairAddress: string;
    lifecycleId: string | null;
    reduceQty: string;
  },
): Promise<void> {
  if (!input.lifecycleId) return;
  const reduce = d(input.reduceQty);
  if (reduce.lte(0)) return;
  const legs = await db.protectionOrder.findMany({
    where: {
      accountId: input.accountId,
      lifecycleId: input.lifecycleId,
      status: "ARMED",
    },
  });
  for (const leg of legs) {
    const remaining = d(leg.remainingQty.toString()).minus(reduce);
    if (remaining.lte(0)) {
      await db.protectionOrder.update({
        where: { id: leg.id },
        data: { remainingQty: 0, status: "CANCELLED" },
      });
    } else {
      await db.protectionOrder.update({
        where: { id: leg.id },
        data: { remainingQty: usd(remaining) },
      });
    }
  }
}

/**
 * Opening meta scoped to current lifecycle / account — never first BUY ever for the pair.
 */
export async function positionOpenMetaForLifecycle(
  db: Db,
  input: {
    accountId: string;
    pairAddress: string;
    lifecycleId: string | null;
    currentMarkUsd: string | null;
  },
): Promise<{ openedAt: string | null; peakMarkUsd: string | null }> {
  if (!input.lifecycleId) {
    return { openedAt: null, peakMarkUsd: input.currentMarkUsd };
  }
  const openingBuy = await db.order.findFirst({
    where: {
      accountId: input.accountId,
      pairAddress: input.pairAddress,
      side: "BUY",
      status: "FILLED",
      // Approximate lifecycle window: fills after position last went flat are hard;
      // prefer fills that share protection lifecycle via contemporaneous protection rows.
    },
    orderBy: { createdAt: "desc" },
    include: { fills: { orderBy: { createdAt: "asc" }, take: 1 } },
  });

  // Prefer earliest fill among orders created while this lifecycle's protection existed.
  const lifecycleStart = await db.protectionOrder.findFirst({
    where: { accountId: input.accountId, lifecycleId: input.lifecycleId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  const since =
    lifecycleStart?.createdAt ??
    openingBuy?.createdAt ??
    null;

  if (!since) {
    return { openedAt: null, peakMarkUsd: input.currentMarkUsd };
  }

  const firstFill = await db.fill.findFirst({
    where: {
      pairAddress: input.pairAddress,
      side: "BUY",
      createdAt: { gte: since },
      order: { accountId: input.accountId },
    },
    orderBy: { createdAt: "asc" },
  });

  const openedAt = firstFill?.createdAt.toISOString() ?? since.toISOString();
  let peak = input.currentMarkUsd ? d(input.currentMarkUsd) : null;
  const highs = await db.marketObservation.findMany({
    where: {
      pairAddress: input.pairAddress,
      receivedAt: { gte: new Date(openedAt) },
      priceUsd: { not: null },
    },
    orderBy: { priceUsd: "desc" },
    take: 1,
  });
  const high = highs[0]?.priceUsd?.toString();
  if (high) peak = peak ? (peak.gt(high) ? peak : d(high)) : d(high);
  if (firstFill) {
    const entry = d(firstFill.priceUsd.toString());
    peak = peak ? (peak.gt(entry) ? peak : entry) : entry;
  }
  return { openedAt, peakMarkUsd: peak ? usd(peak) : null };
}
