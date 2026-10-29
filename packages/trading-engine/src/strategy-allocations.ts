import { d, newId } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";

export type StrategyAllocationStore = Pick<PrismaClient, "strategyAllocation" | "position">;

export type AllocationView = {
  id: string;
  accountId: string;
  strategyInstanceId: string;
  instrumentId: string;
  pairAddress: string;
  lifecycleId: string | null;
  qty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
  committedCapitalUsd: string;
  pendingCapitalUsd: string;
};

/**
 * Apply a fill to an internal strategy allocation (§8/§9).
 * Venue net Position may aggregate multiple instances; closing another instance's
 * allocation is refused unless forceNetClose (account flatten).
 * IDs use newId("alloc") — never truncated collision-prone strings.
 */
export async function applyAllocationFill(
  prisma: StrategyAllocationStore,
  input: {
    accountId: string;
    strategyInstanceId: string;
    instrumentId: string;
    pairAddress: string;
    lifecycleId?: string | null;
    side: "BUY" | "SELL";
    qty: string;
    priceUsd: string;
    feeUsd?: string;
    /** Account-level flatten may close any allocation. */
    forceNetClose?: boolean;
  },
): Promise<{ ok: true; allocation: AllocationView } | { ok: false; reason: string }> {
  const qty = d(input.qty);
  if (!qty.gt(0)) return { ok: false, reason: "NON_POSITIVE_QTY" };

  const existing = await prisma.strategyAllocation.findUnique({
    where: {
      accountId_strategyInstanceId_pairAddress: {
        accountId: input.accountId,
        strategyInstanceId: input.strategyInstanceId,
        pairAddress: input.pairAddress,
      },
    },
  });

  if (input.side === "BUY") {
    const prevQty = existing ? d(existing.qty.toString()) : d("0");
    const prevCost = existing ? d(existing.avgCostUsd.toString()) : d("0");
    const notional = qty.mul(d(input.priceUsd));
    const fee = d(input.feeUsd ?? "0");
    const nextQty = prevQty.plus(qty);
    const nextAvg = nextQty.eq(0)
      ? d("0")
      : prevQty.mul(prevCost).plus(notional.plus(fee)).div(nextQty);
    const row = await prisma.strategyAllocation.upsert({
      where: {
        accountId_strategyInstanceId_pairAddress: {
          accountId: input.accountId,
          strategyInstanceId: input.strategyInstanceId,
          pairAddress: input.pairAddress,
        },
      },
      create: {
        id: newId("alloc"),
        accountId: input.accountId,
        strategyInstanceId: input.strategyInstanceId,
        instrumentId: input.instrumentId,
        pairAddress: input.pairAddress,
        lifecycleId: input.lifecycleId ?? null,
        qty: nextQty.toFixed(8),
        avgCostUsd: nextAvg.toFixed(8),
        realizedPnlUsd: "0",
        committedCapitalUsd: notional.plus(fee).toFixed(8),
        pendingCapitalUsd: "0",
      },
      update: {
        qty: nextQty.toFixed(8),
        avgCostUsd: nextAvg.toFixed(8),
        lifecycleId: input.lifecycleId ?? existing?.lifecycleId ?? null,
        committedCapitalUsd: d(existing?.committedCapitalUsd.toString() ?? "0")
          .plus(notional.plus(fee))
          .toFixed(8),
        pendingCapitalUsd: "0",
      },
    });
    return { ok: true, allocation: mapAllocation(row) };
  }

  if (!existing || d(existing.qty.toString()).lte(0)) {
    if (input.forceNetClose) {
      return { ok: true, allocation: emptyAllocation(input) };
    }
    return { ok: false, reason: "ALLOCATION_NOT_OWNED" };
  }
  const held = d(existing.qty.toString());
  if (qty.gt(held) && !input.forceNetClose) {
    return { ok: false, reason: "SELL_EXCEEDS_ALLOCATION" };
  }
  const sellQty = qty.gt(held) ? held : qty;
  const avg = d(existing.avgCostUsd.toString());
  const proceeds = sellQty.mul(d(input.priceUsd));
  const costBasis = sellQty.mul(avg);
  const fee = d(input.feeUsd ?? "0");
  const realized = proceeds.minus(costBasis).minus(fee);
  const nextQty = held.minus(sellQty);
  const row = await prisma.strategyAllocation.update({
    where: { id: existing.id },
    data: {
      qty: nextQty.toFixed(8),
      realizedPnlUsd: d(existing.realizedPnlUsd.toString()).plus(realized).toFixed(8),
      committedCapitalUsd: nextQty.eq(0)
        ? "0"
        : d(existing.committedCapitalUsd.toString()).minus(costBasis).toFixed(8),
      lifecycleId: nextQty.eq(0) ? null : existing.lifecycleId,
    },
  });
  return { ok: true, allocation: mapAllocation(row) };
}

/** Sum of instance allocations for a symbol must reconcile toward venue net. */
export function netAllocationQty(allocations: Array<{ qty: string }>): string {
  return allocations.reduce((sum, row) => sum.plus(d(row.qty)), d("0")).toFixed(8);
}

/**
 * Refuse closing another instance's allocation when reducing.
 * Returns the max qty this instance may sell.
 */
export function maxCloseableAllocationQty(input: {
  instanceQty: string;
  requestedQty: string;
}): { ok: true; qty: string } | { ok: false; reason: "SELL_EXCEEDS_ALLOCATION" } {
  const held = d(input.instanceQty);
  const want = d(input.requestedQty);
  if (want.lte(0)) return { ok: false, reason: "SELL_EXCEEDS_ALLOCATION" };
  if (want.gt(held)) return { ok: false, reason: "SELL_EXCEEDS_ALLOCATION" };
  return { ok: true, qty: want.toFixed(8) };
}

/**
 * Detect allocation vs venue-net drift. Repair suggestions are audited — never silent rewrite.
 */
export function allocationVenueDrift(input: {
  venueQty: string;
  allocations: Array<{ qty: string; strategyInstanceId: string }>;
}): { ok: true } | { ok: false; driftQty: string; allocationNet: string } {
  const allocationNet = netAllocationQty(input.allocations);
  const venue = d(input.venueQty);
  const net = d(allocationNet);
  if (venue.eq(net)) return { ok: true };
  return {
    ok: false,
    driftQty: venue.minus(net).toFixed(8),
    allocationNet,
  };
}

/**
 * Audited repair: scale or clear unattributed remainder into an explicit UNATTRIBUTED bucket id.
 * Does not rewrite fill history.
 */
export async function repairAllocationDrift(
  prisma: StrategyAllocationStore,
  input: {
    accountId: string;
    pairAddress: string;
    instrumentId: string;
    venueQty: string;
    unattributedInstanceId?: string;
  },
): Promise<
  | { ok: true; repaired: false }
  | { ok: true; repaired: true; unattributedQty: string; audit: string }
  | { ok: false; reason: string }
> {
  const rows = await prisma.strategyAllocation.findMany({
    where: { accountId: input.accountId, pairAddress: input.pairAddress },
  });
  const drift = allocationVenueDrift({
    venueQty: input.venueQty,
    allocations: rows.map((r) => ({ qty: r.qty.toString(), strategyInstanceId: r.strategyInstanceId })),
  });
  if (drift.ok) return { ok: true, repaired: false };

  const unattributedId = input.unattributedInstanceId ?? "stratinst_unattributed";
  const remainder = d(input.venueQty).minus(d(drift.allocationNet));
  if (remainder.lte(0)) {
    return {
      ok: true,
      repaired: true,
      unattributedQty: "0",
      audit: `ALLOCATION_OVER_VENUE drift=${drift.driftQty} — operator must investigate; no silent wipe`,
    };
  }

  await applyAllocationFill(prisma, {
    accountId: input.accountId,
    strategyInstanceId: unattributedId,
    instrumentId: input.instrumentId,
    pairAddress: input.pairAddress,
    side: "BUY",
    qty: remainder.toFixed(8),
    priceUsd: "0",
    feeUsd: "0",
  });

  return {
    ok: true,
    repaired: true,
    unattributedQty: remainder.toFixed(8),
    audit: `UNATTRIBUTED_ALLOCATION_REPAIR qty=${remainder.toFixed(8)} pair=${input.pairAddress}`,
  };
}

function mapAllocation(row: {
  id: string;
  accountId: string;
  strategyInstanceId: string;
  instrumentId: string;
  pairAddress: string;
  lifecycleId: string | null;
  qty: { toString(): string };
  avgCostUsd: { toString(): string };
  realizedPnlUsd: { toString(): string };
  committedCapitalUsd: { toString(): string };
  pendingCapitalUsd: { toString(): string };
}): AllocationView {
  return {
    id: row.id,
    accountId: row.accountId,
    strategyInstanceId: row.strategyInstanceId,
    instrumentId: row.instrumentId,
    pairAddress: row.pairAddress,
    lifecycleId: row.lifecycleId,
    qty: row.qty.toString(),
    avgCostUsd: row.avgCostUsd.toString(),
    realizedPnlUsd: row.realizedPnlUsd.toString(),
    committedCapitalUsd: row.committedCapitalUsd.toString(),
    pendingCapitalUsd: row.pendingCapitalUsd.toString(),
  };
}

function emptyAllocation(input: {
  accountId: string;
  strategyInstanceId: string;
  instrumentId: string;
  pairAddress: string;
}): AllocationView {
  return {
    id: `alloc_empty_${input.strategyInstanceId}`,
    accountId: input.accountId,
    strategyInstanceId: input.strategyInstanceId,
    instrumentId: input.instrumentId,
    pairAddress: input.pairAddress,
    lifecycleId: null,
    qty: "0",
    avgCostUsd: "0",
    realizedPnlUsd: "0",
    committedCapitalUsd: "0",
    pendingCapitalUsd: "0",
  };
}
