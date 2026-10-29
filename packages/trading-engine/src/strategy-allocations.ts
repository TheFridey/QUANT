import { d, MANUAL_INSTANCE_ID, newId, UNATTRIBUTED_INSTANCE_ID } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";

export type StrategyAllocationStore = Pick<PrismaClient, "strategyAllocation" | "position" | "recoveryCase">;

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
  reservedExitQty: string;
  feesUsd: string;
  ownership: string;
  costBasisKnown: boolean;
};

export type AllocationFillResult =
  | { ok: true; allocation: AllocationView }
  | { ok: false; reason: string };

/**
 * Apply a fill to one strategy allocation.
 * Venue net Position may aggregate multiple instances; closing another instance's
 * allocation is refused unless forceNetClose (account flatten / net distribution slice).
 *
 * pendingCapitalUsd is a display mirror only — never cleared on BUY (that was F02-adjacent
 * corruption). Callers that hold RiskReservation remainingCashUsd own the authority.
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
    /** Account-level flatten / pro-rata slice may close any allocation. */
    forceNetClose?: boolean;
    ownership?: "STRATEGY" | "UNATTRIBUTED" | "LEGACY" | "MANUAL";
    costBasisKnown?: boolean;
    /** When true, reduce reservedExitQty by the filled sell qty (clamped ≥ 0). */
    releaseExitReservation?: boolean;
  },
): Promise<AllocationFillResult> {
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
    const costBasisKnown = input.costBasisKnown ?? existing?.costBasisKnown ?? true;
    // Unknown cost basis (unattributed remainder) must never invent a strategy average.
    const nextAvg =
      !costBasisKnown || nextQty.eq(0)
        ? d("0")
        : prevQty.mul(prevCost).plus(notional.plus(fee)).div(nextQty);
    const ownership =
      input.ownership ??
      (existing?.ownership as AllocationView["ownership"] | undefined) ??
      (input.strategyInstanceId === UNATTRIBUTED_INSTANCE_ID
        ? "UNATTRIBUTED"
        : input.strategyInstanceId === MANUAL_INSTANCE_ID
          ? "MANUAL"
          : "STRATEGY");
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
        committedCapitalUsd: costBasisKnown ? notional.plus(fee).toFixed(8) : "0",
        // Display mirror — do not invent pending; RiskReservation is authority.
        pendingCapitalUsd: existing?.pendingCapitalUsd.toString() ?? "0",
        reservedExitQty: "0",
        feesUsd: fee.toFixed(8),
        ownership,
        costBasisKnown,
      },
      update: {
        qty: nextQty.toFixed(8),
        avgCostUsd: nextAvg.toFixed(8),
        lifecycleId: input.lifecycleId ?? existing?.lifecycleId ?? null,
        committedCapitalUsd: costBasisKnown
          ? d(existing?.committedCapitalUsd.toString() ?? "0")
              .plus(notional.plus(fee))
              .toFixed(8)
          : (existing?.committedCapitalUsd.toString() ?? "0"),
        feesUsd: d(existing?.feesUsd.toString() ?? "0").plus(fee).toFixed(8),
        ownership,
        costBasisKnown,
        // Explicitly leave pendingCapitalUsd alone (do NOT write "0").
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
  const realized = existing.costBasisKnown ? proceeds.minus(costBasis).minus(fee) : d("0");
  const nextQty = held.minus(sellQty);
  let nextReserved = d(existing.reservedExitQty.toString());
  if (input.releaseExitReservation) {
    nextReserved = nextReserved.minus(sellQty);
    if (nextReserved.lt(0)) nextReserved = d("0");
  }
  const row = await prisma.strategyAllocation.update({
    where: { id: existing.id },
    data: {
      qty: nextQty.toFixed(8),
      realizedPnlUsd: d(existing.realizedPnlUsd.toString()).plus(realized).toFixed(8),
      committedCapitalUsd: nextQty.eq(0)
        ? "0"
        : d(existing.committedCapitalUsd.toString()).minus(costBasis).toFixed(8),
      lifecycleId: nextQty.eq(0) ? null : existing.lifecycleId,
      reservedExitQty: nextReserved.toFixed(8),
      feesUsd: d(existing.feesUsd.toString()).plus(fee).toFixed(8),
    },
  });
  return { ok: true, allocation: mapAllocation(row) };
}

/** Increase reservedExitQty for an in-flight STRATEGY exit (pending order). */
export async function reserveExitQty(
  prisma: Pick<PrismaClient, "strategyAllocation">,
  input: {
    accountId: string;
    strategyInstanceId: string;
    pairAddress: string;
    qty: string;
  },
): Promise<{ ok: true; reservedExitQty: string } | { ok: false; reason: string }> {
  const existing = await prisma.strategyAllocation.findUnique({
    where: {
      accountId_strategyInstanceId_pairAddress: {
        accountId: input.accountId,
        strategyInstanceId: input.strategyInstanceId,
        pairAddress: input.pairAddress,
      },
    },
  });
  if (!existing) return { ok: false, reason: "ALLOCATION_NOT_OWNED" };
  const available = d(existing.qty.toString()).minus(d(existing.reservedExitQty.toString()));
  if (d(input.qty).gt(available)) return { ok: false, reason: "EXIT_QTY_RESERVED" };
  const next = d(existing.reservedExitQty.toString()).plus(d(input.qty));
  const row = await prisma.strategyAllocation.update({
    where: { id: existing.id },
    data: { reservedExitQty: next.toFixed(8) },
  });
  return { ok: true, reservedExitQty: row.reservedExitQty.toString() };
}

/** Release reserved exit qty on cancel/expire/reject (clamped ≥ 0). */
export async function releaseExitQty(
  prisma: Pick<PrismaClient, "strategyAllocation">,
  input: {
    accountId: string;
    strategyInstanceId: string;
    pairAddress: string;
    qty: string;
  },
): Promise<{ ok: true; reservedExitQty: string } | { ok: false; reason: string }> {
  const existing = await prisma.strategyAllocation.findUnique({
    where: {
      accountId_strategyInstanceId_pairAddress: {
        accountId: input.accountId,
        strategyInstanceId: input.strategyInstanceId,
        pairAddress: input.pairAddress,
      },
    },
  });
  if (!existing) return { ok: false, reason: "ALLOCATION_NOT_OWNED" };
  let next = d(existing.reservedExitQty.toString()).minus(d(input.qty));
  if (next.lt(0)) next = d("0");
  const row = await prisma.strategyAllocation.update({
    where: { id: existing.id },
    data: { reservedExitQty: next.toFixed(8) },
  });
  return { ok: true, reservedExitQty: row.reservedExitQty.toString() };
}

/**
 * Pro-rata distribution of a net-close qty across allocations (8 dp).
 * Remainder goes to the largest holder so the sum equals fillQty exactly.
 */
export function distributeProRata(
  allocations: Array<{ strategyInstanceId: string; qty: string }>,
  fillQty: string,
): Array<{ strategyInstanceId: string; qty: string }> {
  const total = allocations.reduce((sum, row) => sum.plus(d(row.qty)), d("0"));
  const want = d(fillQty);
  if (total.lte(0) || want.lte(0)) return [];
  const slices = allocations
    .filter((row) => d(row.qty).gt(0))
    .map((row) => ({
      strategyInstanceId: row.strategyInstanceId,
      qty: d(row.qty).mul(want).div(total),
      held: d(row.qty),
    }))
    .sort((a, b) => b.held.cmp(a.held) || a.strategyInstanceId.localeCompare(b.strategyInstanceId));
  // Floor to 8 dp, then assign remainder to largest.
  let assigned = d("0");
  const floored = slices.map((slice, index) => {
    if (index === slices.length - 1) {
      const rem = want.minus(assigned);
      return { strategyInstanceId: slice.strategyInstanceId, qty: rem.toFixed(8) };
    }
    const q = slice.qty.toDecimalPlaces(8, 1); // ROUND_DOWN
    assigned = assigned.plus(q);
    return { strategyInstanceId: slice.strategyInstanceId, qty: q.toFixed(8) };
  });
  return floored.filter((s) => d(s.qty).gt(0));
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
 * Audited repair for under-attribution only.
 * Over-attribution is NEVER silently wiped: returns repaired:false so callers open a RecoveryCase.
 * Under-attribution books the remainder into UNATTRIBUTED with costBasisKnown=false
 * (never invents a zero-cost strategy average that looks like performance).
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
  | { ok: true; repaired: false; reason?: string }
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

  const remainder = d(input.venueQty).minus(d(drift.allocationNet));
  if (remainder.lte(0)) {
    // Over-attribution: do not fabricate a wipe or claim repaired.
    return {
      ok: true,
      repaired: false,
      reason: `ALLOCATION_OVER_VENUE drift=${drift.driftQty} — operator must investigate; no silent wipe`,
    };
  }

  const unattributedId = input.unattributedInstanceId ?? UNATTRIBUTED_INSTANCE_ID;
  const applied = await applyAllocationFill(prisma, {
    accountId: input.accountId,
    strategyInstanceId: unattributedId,
    instrumentId: input.instrumentId,
    pairAddress: input.pairAddress,
    side: "BUY",
    qty: remainder.toFixed(8),
    priceUsd: "0",
    feeUsd: "0",
    ownership: "UNATTRIBUTED",
    costBasisKnown: false,
  });
  if (!applied.ok) return { ok: false, reason: applied.reason };

  return {
    ok: true,
    repaired: true,
    unattributedQty: remainder.toFixed(8),
    audit: `UNATTRIBUTED_ALLOCATION_REPAIR qty=${remainder.toFixed(8)} pair=${input.pairAddress} costBasisKnown=false`,
  };
}

export type OwnerScope =
  | "STRATEGY"
  | "OPERATOR"
  | "PROTECTION"
  | "ACCOUNT_FLATTEN"
  | "NET_CLOSE"
  | "LEGACY";

export type SettlementOrderRef = {
  side: "BUY" | "SELL";
  intent: string;
  pairAddress: string;
  instrumentId?: string | null;
  strategyInstanceId?: string | null;
  ownerScope?: OwnerScope | string | null;
  clientOrderId?: string;
};

/**
 * Settle a fill against allocations according to Order.ownerScope (Stages J–M).
 *
 * BUY STRATEGY → that instance.
 * BUY OPERATOR → stratinst_manual (ownership MANUAL).
 * BUY LEGACY → stratinst_unattributed (costBasisKnown false when unknown).
 * SELL STRATEGY → that instance only (caller must pre-validate for local; external may create RecoveryCase).
 * SELL NET_CLOSE / PROTECTION / ACCOUNT_FLATTEN / OPERATOR-net → pro-rata across all holders.
 */
export async function settleFillByOwnerScope(
  prisma: StrategyAllocationStore,
  input: {
    accountId: string;
    order: SettlementOrderRef;
    fillQty: string;
    priceUsd: string;
    feeUsd: string;
    lifecycleId: string | null;
    /** When true (external confirmed fill), book anyway and open RecoveryCase on shortfall. */
    externalConfirmed?: boolean;
  },
): Promise<{ ok: true; recoveryOpened?: boolean } | { ok: false; reason: string; recoveryOpened?: boolean }> {
  const scope = (input.order.ownerScope ?? (input.order.strategyInstanceId ? "STRATEGY" : "LEGACY")) as OwnerScope;
  const instrumentId = input.order.instrumentId ?? input.order.pairAddress;
  const fee = d(input.feeUsd);

  if (input.order.side === "BUY") {
    let strategyInstanceId: string;
    let ownership: "STRATEGY" | "UNATTRIBUTED" | "LEGACY" | "MANUAL";
    let costBasisKnown = true;
    if (scope === "STRATEGY" && input.order.strategyInstanceId) {
      strategyInstanceId = input.order.strategyInstanceId;
      ownership = "STRATEGY";
    } else if (scope === "OPERATOR") {
      strategyInstanceId = MANUAL_INSTANCE_ID;
      ownership = "MANUAL";
    } else {
      strategyInstanceId = UNATTRIBUTED_INSTANCE_ID;
      ownership = "UNATTRIBUTED";
      costBasisKnown = false;
    }
    const applied = await applyAllocationFill(prisma, {
      accountId: input.accountId,
      strategyInstanceId,
      instrumentId,
      pairAddress: input.order.pairAddress,
      lifecycleId: input.lifecycleId,
      side: "BUY",
      qty: input.fillQty,
      priceUsd: input.priceUsd,
      feeUsd: input.feeUsd,
      ownership,
      costBasisKnown,
    });
    return applied.ok ? { ok: true } : { ok: false, reason: applied.reason };
  }

  // SELL
  const distributes =
    scope === "NET_CLOSE" ||
    scope === "PROTECTION" ||
    scope === "ACCOUNT_FLATTEN" ||
    (scope === "OPERATOR" && !input.order.strategyInstanceId) ||
    input.order.intent === "FLATTEN";

  if (distributes) {
    const rows = await prisma.strategyAllocation.findMany({
      where: { accountId: input.accountId, pairAddress: input.order.pairAddress, qty: { gt: 0 } },
    });
    const slices = distributeProRata(
      rows.map((r) => ({ strategyInstanceId: r.strategyInstanceId, qty: r.qty.toString() })),
      input.fillQty,
    );
    if (slices.length === 0) {
      // Unattributed net close of a position with no allocation rows — book remainder as unattributed reduction (noop).
      if (input.externalConfirmed) {
        await openRecovery(prisma, {
          accountId: input.accountId,
          kind: "ALLOCATION_SETTLEMENT",
          pairAddress: input.order.pairAddress,
          clientOrderId: input.order.clientOrderId,
          detail: { reason: "NO_ALLOCATIONS_FOR_NET_CLOSE", fillQty: input.fillQty },
        });
        return { ok: true, /* booked venue; recovery opened */ };
      }
      return { ok: false, reason: "NO_ALLOCATIONS_FOR_NET_CLOSE" };
    }
    let feeLeft = fee;
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]!;
      const sliceFee =
        i === slices.length - 1
          ? feeLeft
          : fee.mul(d(slice.qty)).div(d(input.fillQty)).toDecimalPlaces(8, 1);
      feeLeft = feeLeft.minus(sliceFee);
      const applied = await applyAllocationFill(prisma, {
        accountId: input.accountId,
        strategyInstanceId: slice.strategyInstanceId,
        instrumentId,
        pairAddress: input.order.pairAddress,
        lifecycleId: input.lifecycleId,
        side: "SELL",
        qty: slice.qty,
        priceUsd: input.priceUsd,
        feeUsd: sliceFee.toFixed(8),
        forceNetClose: true,
        releaseExitReservation: true,
      });
      if (!applied.ok) {
        await openRecovery(prisma, {
          accountId: input.accountId,
          kind: "ALLOCATION_SETTLEMENT",
          pairAddress: input.order.pairAddress,
          strategyInstanceId: slice.strategyInstanceId,
          clientOrderId: input.order.clientOrderId,
          detail: { reason: applied.reason, sliceQty: slice.qty, fillQty: input.fillQty },
        });
      }
    }
    return { ok: true };
  }

  // STRATEGY (or OPERATOR ALLOCATION) sell — single owner.
  const strategyInstanceId = input.order.strategyInstanceId;
  if (!strategyInstanceId) {
    if (input.externalConfirmed) {
      // Confirmed broker fill with no owner: book to unattributed reduction via force, open recovery.
      await openRecovery(prisma, {
        accountId: input.accountId,
        kind: "ALLOCATION_SETTLEMENT",
        pairAddress: input.order.pairAddress,
        clientOrderId: input.order.clientOrderId,
        detail: { reason: "SELL_WITHOUT_OWNER", fillQty: input.fillQty, scope },
      });
      return { ok: true };
    }
    return { ok: false, reason: "ALLOCATION_NOT_OWNED" };
  }

  const applied = await applyAllocationFill(prisma, {
    accountId: input.accountId,
    strategyInstanceId,
    instrumentId,
    pairAddress: input.order.pairAddress,
    lifecycleId: input.lifecycleId,
    side: "SELL",
    qty: input.fillQty,
    priceUsd: input.priceUsd,
    feeUsd: input.feeUsd,
    forceNetClose: false,
    releaseExitReservation: true,
  });
  if (applied.ok) return { ok: true };

  if (input.externalConfirmed) {
    // Never discard a confirmed broker fill — reduce what we can, RecoveryCase for excess.
    const existing = await prisma.strategyAllocation.findUnique({
      where: {
        accountId_strategyInstanceId_pairAddress: {
          accountId: input.accountId,
          strategyInstanceId,
          pairAddress: input.order.pairAddress,
        },
      },
    });
    const held = existing ? d(existing.qty.toString()) : d("0");
    if (held.gt(0)) {
      await applyAllocationFill(prisma, {
        accountId: input.accountId,
        strategyInstanceId,
        instrumentId,
        pairAddress: input.order.pairAddress,
        lifecycleId: input.lifecycleId,
        side: "SELL",
        qty: held.toFixed(8),
        priceUsd: input.priceUsd,
        feeUsd: input.feeUsd,
        forceNetClose: true,
        releaseExitReservation: true,
      });
    }
    await openRecovery(prisma, {
      accountId: input.accountId,
      kind: "ALLOCATION_SETTLEMENT",
      pairAddress: input.order.pairAddress,
      strategyInstanceId,
      clientOrderId: input.order.clientOrderId,
      detail: {
        reason: applied.reason,
        fillQty: input.fillQty,
        ownedQty: held.toFixed(8),
        excessQty: d(input.fillQty).minus(held).toFixed(8),
      },
    });
    return { ok: true, recoveryOpened: true };
  }
  return { ok: false, reason: applied.reason };
}

async function openRecovery(
  prisma: StrategyAllocationStore,
  input: {
    accountId: string;
    kind: string;
    pairAddress?: string;
    strategyInstanceId?: string;
    clientOrderId?: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  if (!("recoveryCase" in prisma) || !prisma.recoveryCase) return;
  const dedupeKey = [
    input.kind,
    input.accountId,
    input.pairAddress ?? "",
    input.strategyInstanceId ?? "",
    input.clientOrderId ?? "",
    String(input.detail.reason ?? ""),
  ].join("|");
  await prisma.recoveryCase.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      accountId: input.accountId,
      kind: input.kind,
      severity: "ERROR",
      pairAddress: input.pairAddress ?? null,
      strategyInstanceId: input.strategyInstanceId ?? null,
      clientOrderId: input.clientOrderId ?? null,
      detail: input.detail as object,
      status: "OPEN",
    },
    update: {
      detail: input.detail as object,
      attempts: { increment: 1 },
    },
  });
}

/**
 * Instance capital still available for admission:
 * budget − filled committed − HELD RiskReservation remainingCashUsd for this instance.
 */
export async function instanceAvailableUsd(
  prisma: Pick<PrismaClient, "strategyAllocation" | "riskReservation" | "strategyInstance">,
  input: { accountId: string; strategyInstanceId: string },
): Promise<string> {
  const instance = await prisma.strategyInstance.findUnique({ where: { id: input.strategyInstanceId } });
  const budget = d(instance?.budgetUsd.toString() ?? "0");
  const filled = await prisma.strategyAllocation.aggregate({
    where: { accountId: input.accountId, strategyInstanceId: input.strategyInstanceId },
    _sum: { committedCapitalUsd: true },
  });
  const held = await prisma.riskReservation.aggregate({
    where: {
      accountId: input.accountId,
      strategyInstanceId: input.strategyInstanceId,
      status: "HELD",
    },
    _sum: { remainingCashUsd: true },
  });
  const available = budget
    .minus(d(filled._sum.committedCapitalUsd?.toString() ?? "0"))
    .minus(d(held._sum.remainingCashUsd?.toString() ?? "0"));
  return (available.gt(0) ? available : d("0")).toFixed(8);
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
  reservedExitQty?: { toString(): string };
  feesUsd?: { toString(): string };
  ownership?: string;
  costBasisKnown?: boolean;
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
    reservedExitQty: row.reservedExitQty?.toString() ?? "0",
    feesUsd: row.feesUsd?.toString() ?? "0",
    ownership: row.ownership ?? "STRATEGY",
    costBasisKnown: row.costBasisKnown ?? true,
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
    reservedExitQty: "0",
    feesUsd: "0",
    ownership: "STRATEGY",
    costBasisKnown: true,
  };
}
