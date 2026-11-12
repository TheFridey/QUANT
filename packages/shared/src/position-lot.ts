import { d } from "./money.js";

/**
 * PCR-1 (APEX): position-lot identity for pending exits.
 *
 * A pending exit is booked against the units held when it was booked. Later events may close the lot,
 * reopen the pair, reduce it, or add to it before the exit settles. An exit must never sell units acquired
 * after it was booked.
 *
 * Identity is a monotonic counter, not only a lot id. `Position.cumBoughtQty` only ever increases, by the
 * quantity of every quantity-increasing fill (open, add, reopen), and never resets, even across lots. It is
 * updated in the same account-locked transaction that applies the fill. A pending SELL stamps the counter
 * at booking (`Order.positionBoughtQtyAtBooking`), in the same account-locked transaction that writes it.
 * At settlement:
 *
 *   addedSinceBooking = cumBoughtQty(now) − stamp           (≥ 0, by monotonicity)
 *   allowed           = qty(now) − addedSinceBooking
 *
 * Treating units as consumed first-in first-out, `allowed` is exactly the number of units held at booking
 * that are still held (booked qty − reductions since booking). So an exit capped at `allowed` can only sell
 * units it was booked against: a reopened lot gives allowed ≤ 0, and an add after a reduction caps the exit
 * at the surviving booked units. The lot id is kept as an attribution stamp and a second, redundant fence.
 *
 * Ownership: STRATEGY exits apply the same rule to the owning instance's StrategyAllocation, which carries
 * its own monotonic counter, so FIFO runs within the owner. Another instance's trades never cancel or cap
 * them, and the owner's own re-buys after a reduction are never sold by an old exit. Pair-level exits
 * (NET_CLOSE, PROTECTION, OPERATOR, LEGACY) use FIFO across the pair, which is conservative: in a
 * multi-owner pair it can cancel a pair-level exit that an ownership-aware reading would allow. The
 * planner re-plans the next cycle and protection stays armed.
 *
 * Flatten exits (ACCOUNT_FLATTEN scope or FLATTEN intent) mean "be flat now". They are not fenced, but are
 * capped at the quantity held. A flat
 * pair cancels every pending SELL (ASCEND-00 F5, unchanged). Unstamped (legacy) rows keep today's
 * behaviour, apart from the lot-id fence when a lot id was stamped.
 */

export type PositionLotState = {
  qty: string;
  lotId: string | null;
  cumBoughtQty: string;
};

/** The owning instance's allocation for a STRATEGY exit (qty held by that owner, and its own counter). */
export type AllocationLotState = {
  qty: string;
  cumBoughtQty: string;
};

export type ExitStamp = {
  lotId: string | null;
  boughtQtyAtBooking: string | null;
  /** STRATEGY exits only: the owner's StrategyAllocation.cumBoughtQty at booking. */
  allocationBoughtQtyAtBooking?: string | null;
};

export type ExitFenceInput = {
  qty: string;
  ownerScope: string | null;
  intent: string;
  stamp: ExitStamp;
};

export type ExitFenceDecision =
  | { action: "PROCEED"; qty: string }
  | { action: "CAP"; qty: string; reason: "EXIT_CAPPED_TO_BOOKED_LOT" | "EXIT_CAPPED_TO_POSITION" }
  | { action: "CANCEL"; reason: "EXIT_SUPERSEDED" | "EXIT_LIFECYCLE_MISMATCH" };

export function isFlattenExit(order: { ownerScope: string | null; intent: string }): boolean {
  return order.ownerScope === "ACCOUNT_FLATTEN" || order.intent === "FLATTEN";
}

/**
 * Stamp to write on a pending SELL at booking (under the account lock). Null fields when the pair is flat.
 * Pass the owner's allocation for STRATEGY exits; other scopes are fenced at pair level.
 */
export function exitStampFor(position: PositionLotState | null, allocation?: AllocationLotState | null): ExitStamp {
  if (!position || !d(position.qty).gt(0)) return { lotId: null, boughtQtyAtBooking: null, allocationBoughtQtyAtBooking: null };
  return {
    lotId: position.lotId,
    boughtQtyAtBooking: d(position.cumBoughtQty).toFixed(8),
    allocationBoughtQtyAtBooking: allocation ? d(allocation.cumBoughtQty).toFixed(8) : null,
  };
}

/** The FIFO-surviving booked units: held now minus everything bought since the stamp. */
function fenceByCounter(held: string, cumNow: string, stamp: string, orderQty: ReturnType<typeof d>): ExitFenceDecision {
  const added = d(cumNow).minus(d(stamp));
  // A counter never decreases; a negative difference means the stamp or counter is inconsistent. Fail
  // safe for the new units: do not sell (the lot keeps its own protection; the planner re-plans).
  if (added.lt(0)) return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
  const allowed = d(held).minus(added);
  if (!allowed.gt(0)) return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
  if (allowed.lt(orderQty)) {
    // Quantities are quantised to 8 dp and rounded down, as everywhere in the ledger.
    return { action: "CAP", qty: allowed.toDecimalPlaces(8, 1).toFixed(8), reason: "EXIT_CAPPED_TO_BOOKED_LOT" };
  }
  return { action: "PROCEED", qty: orderQty.toFixed(8) };
}

/** New counter value after a fill. Only quantity-increasing (BUY) fills move it. */
export function nextCumBoughtQty(cumBoughtQty: string, side: "BUY" | "SELL", fillQty: string): string {
  const fill = d(fillQty);
  if (fill.lt(0)) throw new Error("nextCumBoughtQty: negative fill quantity");
  return side === "BUY" ? d(cumBoughtQty).plus(fill).toFixed(8) : d(cumBoughtQty).toFixed(8);
}

/**
 * Decide what a pending SELL may do at settlement. Pure; the caller holds the account lock and applies the
 * decision (cancel and release, or reduce the order quantity and release the excess reservation).
 */
export function exitFence(
  order: ExitFenceInput,
  position: PositionLotState | null,
  allocation?: AllocationLotState | null,
): ExitFenceDecision {
  const orderQty = d(order.qty);
  // ASCEND-00 F5: nothing left to sell.
  if (!position || !d(position.qty).gt(0)) return { action: "CANCEL", reason: "EXIT_SUPERSEDED" };
  // Flatten means "be flat now": never fenced, but never more than is held (an oversized flatten was
  // previously rejected as SELL_EXCEEDS_POSITION after a partial reduction).
  if (isFlattenExit(order)) {
    return orderQty.gt(d(position.qty))
      ? { action: "CAP", qty: d(position.qty).toFixed(8), reason: "EXIT_CAPPED_TO_POSITION" }
      : { action: "PROCEED", qty: orderQty.toFixed(8) };
  }
  // Redundant lot-id fence: a different open lot means the booked lot closed.
  if (order.stamp.lotId && position.lotId && order.stamp.lotId !== position.lotId) {
    return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
  }
  // STRATEGY exits are fenced per owner: units are first-in first-out within the owning instance's
  // allocation, so other instances' buys and sells never cancel or cap them, and the owner's own re-buys
  // after a reduction are never sold by an old exit.
  const ownerStamp = order.stamp.allocationBoughtQtyAtBooking ?? null;
  if (order.ownerScope === "STRATEGY" && ownerStamp !== null) {
    if (!allocation || !d(allocation.qty).gt(0)) return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
    const owner = fenceByCounter(allocation.qty, allocation.cumBoughtQty, ownerStamp, orderQty);
    // Never more than the pair holds (an over-attributed allocation would otherwise be rejected later).
    if (owner.action !== "CANCEL" && d(owner.qty).gt(d(position.qty))) {
      return { action: "CAP", qty: d(position.qty).toFixed(8), reason: "EXIT_CAPPED_TO_POSITION" };
    }
    return owner;
  }
  // Pair-level exits (NET_CLOSE, PROTECTION, OPERATOR, LEGACY): first-in first-out across the pair.
  if (order.stamp.boughtQtyAtBooking === null) return { action: "PROCEED", qty: orderQty.toFixed(8) };
  return fenceByCounter(position.qty, position.cumBoughtQty, order.stamp.boughtQtyAtBooking, orderQty);
}
