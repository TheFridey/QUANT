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
 * Flatten exits (ACCOUNT_FLATTEN scope or FLATTEN intent) mean "be flat now" and are not capped. A flat
 * pair cancels every pending SELL (ASCEND-00 F5, unchanged). Unstamped (legacy) rows keep today's
 * behaviour, apart from the lot-id fence when a lot id was stamped.
 */

export type PositionLotState = {
  qty: string;
  lotId: string | null;
  cumBoughtQty: string;
};

export type ExitStamp = {
  lotId: string | null;
  boughtQtyAtBooking: string | null;
};

export type ExitFenceInput = {
  qty: string;
  ownerScope: string | null;
  intent: string;
  stamp: ExitStamp;
};

export type ExitFenceDecision =
  | { action: "PROCEED"; qty: string }
  | { action: "CAP"; qty: string; reason: "EXIT_CAPPED_TO_BOOKED_LOT" }
  | { action: "CANCEL"; reason: "EXIT_SUPERSEDED" | "EXIT_LIFECYCLE_MISMATCH" };

export function isFlattenExit(order: { ownerScope: string | null; intent: string }): boolean {
  return order.ownerScope === "ACCOUNT_FLATTEN" || order.intent === "FLATTEN";
}

/** Stamp to write on a pending SELL at booking (under the account lock). Null fields when the pair is flat. */
export function exitStampFor(position: PositionLotState | null): ExitStamp {
  if (!position || !d(position.qty).gt(0)) return { lotId: null, boughtQtyAtBooking: null };
  return { lotId: position.lotId, boughtQtyAtBooking: d(position.cumBoughtQty).toFixed(8) };
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
export function exitFence(order: ExitFenceInput, position: PositionLotState | null): ExitFenceDecision {
  const orderQty = d(order.qty);
  // ASCEND-00 F5: nothing left to sell.
  if (!position || !d(position.qty).gt(0)) return { action: "CANCEL", reason: "EXIT_SUPERSEDED" };
  if (isFlattenExit(order)) return { action: "PROCEED", qty: orderQty.toFixed(8) };
  // Redundant lot-id fence: a different open lot means the booked lot closed.
  if (order.stamp.lotId && position.lotId && order.stamp.lotId !== position.lotId) {
    return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
  }
  if (order.stamp.boughtQtyAtBooking === null) return { action: "PROCEED", qty: orderQty.toFixed(8) };
  const added = d(position.cumBoughtQty).minus(d(order.stamp.boughtQtyAtBooking));
  // The counter never decreases; a negative difference means the stamp or counter is inconsistent. Fail
  // safe for the new units: do not sell (the lot keeps its own protection; the planner re-plans).
  if (added.lt(0)) return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
  const allowed = d(position.qty).minus(added);
  if (!allowed.gt(0)) return { action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" };
  if (allowed.lt(orderQty)) {
    // Quantities are quantised to 8 dp and rounded down, as everywhere in the ledger.
    return { action: "CAP", qty: allowed.toDecimalPlaces(8, 1).toFixed(8), reason: "EXIT_CAPPED_TO_BOOKED_LOT" };
  }
  return { action: "PROCEED", qty: orderQty.toFixed(8) };
}
