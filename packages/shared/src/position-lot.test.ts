import { describe, expect, it } from "vitest";
import { d } from "./money.js";
import { exitFence, exitStampFor, isFlattenExit, nextCumBoughtQty, type PositionLotState } from "./position-lot.js";

const pos = (qty: string, cumBoughtQty: string, lotId: string | null = "lot_A"): PositionLotState => ({ qty, cumBoughtQty, lotId });
const sell = (qty: string, stampCum: string | null, stampLot: string | null = "lot_A", scope = "NET_CLOSE", intent = "EXIT") => ({
  qty,
  ownerScope: scope,
  intent,
  stamp: { lotId: stampLot, boughtQtyAtBooking: stampCum },
});

describe("PCR-1 lot fence: lifecycle cases", () => {
  it("unchanged position: the exit proceeds in full", () => {
    expect(exitFence(sell("2", "2"), pos("2", "2"))).toEqual({ action: "PROCEED", qty: "2.00000000" });
  });

  it("flat pair: cancelled as superseded (F5), even for flatten exits", () => {
    expect(exitFence(sell("1", "1"), pos("0", "1", null))).toEqual({ action: "CANCEL", reason: "EXIT_SUPERSEDED" });
    expect(exitFence(sell("1", "1", "lot_A", "ACCOUNT_FLATTEN", "FLATTEN"), null)).toEqual({ action: "CANCEL", reason: "EXIT_SUPERSEDED" });
  });

  it("closed and reopened (new lot id): cancelled, by both the counter and the lot id", () => {
    // Booked at cum 1; closed; reopened with 1 → cum 2, new lot.
    expect(exitFence(sell("1", "1"), pos("1", "2", "lot_B"))).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
    // Even if the lot id were (wrongly) reused, the counter alone cancels it.
    expect(exitFence(sell("1", "1"), pos("1", "2", "lot_A"))).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
  });

  it("reduced then increased in the same lot (F-PCR1-b): capped to the surviving booked units", () => {
    // Booked to sell 2 at cum 2. Another exit sold 1 (qty 1). An add of 1 (qty 2, cum 3). Only 1 booked unit survives.
    expect(exitFence(sell("2", "2"), pos("2", "3"))).toEqual({ action: "CAP", qty: "1.00000000", reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
  });

  it("added without a reduction: the booked quantity still fits and proceeds", () => {
    expect(exitFence(sell("1", "1"), pos("3", "3"))).toEqual({ action: "PROCEED", qty: "1.00000000" });
  });

  it("reduced below the booked quantity, no add: capped to what survives (instead of a SELL_EXCEEDS_POSITION reject)", () => {
    expect(exitFence(sell("2", "2"), pos("1", "2"))).toEqual({ action: "CAP", qty: "1.00000000", reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
  });

  it("everything booked was sold by others, then re-bought in the same lot: cancelled", () => {
    // Booked 2 at cum 2; others sold 2 (... in one lot only if partial fills kept it open; model the counter).
    expect(exitFence(sell("2", "2"), pos("2", "4"))).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
  });

  it("flatten exits are never capped or fenced while the pair is open", () => {
    expect(exitFence(sell("2", "2", "lot_A", "ACCOUNT_FLATTEN", "FLATTEN"), pos("5", "9", "lot_Z"))).toEqual({ action: "PROCEED", qty: "2.00000000" });
    expect(isFlattenExit({ ownerScope: "OPERATOR", intent: "FLATTEN" })).toBe(true);
    expect(isFlattenExit({ ownerScope: "NET_CLOSE", intent: "EXIT" })).toBe(false);
  });

  it("legacy unstamped rows proceed unchanged; a lot-only stamp still fences a different lot", () => {
    expect(exitFence(sell("1", null, null), pos("1", "5", "lot_Z"))).toEqual({ action: "PROCEED", qty: "1.00000000" });
    expect(exitFence(sell("1", null, "lot_A"), pos("1", "5", "lot_Z"))).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
    expect(exitFence(sell("1", null, "lot_A"), pos("1", "5", "lot_A"))).toEqual({ action: "PROCEED", qty: "1.00000000" });
  });

  it("an inconsistent counter (decreased) fails safe: the exit does not run", () => {
    expect(exitFence(sell("1", "5"), pos("1", "4"))).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
  });

  it("caps round down to 8 dp", () => {
    expect(exitFence(sell("1", "0.000000001"), pos("0.5", "0.400000005"))).toEqual({ action: "CAP", qty: "0.09999999", reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
  });

  it("stamping and counter updates", () => {
    expect(exitStampFor(null)).toEqual({ lotId: null, boughtQtyAtBooking: null, allocationBoughtQtyAtBooking: null });
    expect(exitStampFor(pos("0", "3", null))).toEqual({ lotId: null, boughtQtyAtBooking: null, allocationBoughtQtyAtBooking: null });
    expect(exitStampFor(pos("2", "3"))).toEqual({ lotId: "lot_A", boughtQtyAtBooking: "3.00000000", allocationBoughtQtyAtBooking: null });
    expect(exitStampFor(pos("2", "3"), { qty: "1", cumBoughtQty: "4" })).toEqual({ lotId: "lot_A", boughtQtyAtBooking: "3.00000000", allocationBoughtQtyAtBooking: "4.00000000" });
    expect(nextCumBoughtQty("3", "BUY", "1.5")).toBe("4.50000000");
    expect(nextCumBoughtQty("3", "SELL", "1.5")).toBe("3.00000000");
    expect(() => nextCumBoughtQty("3", "BUY", "-1")).toThrow();
  });
});

/**
 * Property test against an independent model. The model tracks individual units (each BUY creates tagged
 * units; SELLs consume oldest first) and, for each pending exit, which units were held when it was booked.
 * At settlement, the exit may sell at most the booked units still held. The fence must agree exactly, and
 * applying it must never sell a unit bought after the exit's booking.
 */
describe("PCR-1 lot fence: property test against a FIFO unit model", () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("matches the model over 3,000 random event sequences", () => {
    const random = rng(20261102);
    let checks = 0;
    for (let run = 0; run < 3000; run++) {
      // Integer units keep the model exact; the fence works in decimals.
      let units: number[] = []; // birth sequence of each held unit, FIFO order
      let birth = 0;
      let cum = 0;
      let lot = 0;
      let lotId: string | null = null;
      const pending: Array<{ qty: number; stampCum: number; stampLot: string | null; booked: Set<number> }> = [];
      for (let step = 0; step < 25; step++) {
        const r = random();
        if (r < 0.35) {
          const q = 1 + Math.floor(random() * 3);
          if (units.length === 0) lotId = `lot_${++lot}`;
          for (let i = 0; i < q; i++) units.push(++birth);
          cum += q;
        } else if (r < 0.6 && units.length > 0) {
          // Another exit or protection reduces (oldest first).
          const q = 1 + Math.floor(random() * units.length);
          units = units.slice(q);
          if (units.length === 0) lotId = null;
        } else if (r < 0.8 && units.length > 0) {
          const q = 1 + Math.floor(random() * units.length);
          pending.push({ qty: q, stampCum: cum, stampLot: lotId, booked: new Set(units) });
        } else if (pending.length > 0) {
          const exit = pending.shift()!;
          const survivingBooked = units.filter((u) => exit.booked.has(u)).length;
          const decision = exitFence(
            { qty: String(exit.qty), ownerScope: "NET_CLOSE", intent: "EXIT", stamp: { lotId: exit.stampLot, boughtQtyAtBooking: String(exit.stampCum) } },
            { qty: String(units.length), cumBoughtQty: String(cum), lotId },
          );
          checks += 1;
          if (units.length === 0) {
            expect(decision).toEqual({ action: "CANCEL", reason: "EXIT_SUPERSEDED" });
            continue;
          }
          const sellable = decision.action === "CANCEL" ? 0 : Number(decision.qty);
          // Exact agreement with the model: cancel when no booked unit survives, cap at the survivors when
          // they are fewer than the order, otherwise the full order.
          if (survivingBooked === 0) expect(decision).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
          else if (survivingBooked < exit.qty) expect(decision).toEqual({ action: "CAP", qty: d(String(survivingBooked)).toFixed(8), reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
          else expect(decision).toEqual({ action: "PROCEED", qty: d(String(exit.qty)).toFixed(8) });
          // Settle it: FIFO consumption of what the fence allowed (bounded by what is held).
          const sold = Math.min(sellable, units.length);
          // Every unit sold must have been held at booking.
          expect(units.slice(0, sold).every((u) => exit.booked.has(u))).toBe(true);
          units = units.slice(sold);
          if (units.length === 0) lotId = null;
        }
      }
    }
    expect(checks).toBeGreaterThan(5_000);
  });

  it("allowed quantity equals the surviving booked units exactly (closed form)", () => {
    const random = rng(7);
    for (let i = 0; i < 2000; i++) {
      const booked = 1 + Math.floor(random() * 10);
      const reducedSince = Math.floor(random() * 12);
      const addedSince = Math.floor(random() * 6);
      const held = Math.max(0, booked - reducedSince) + addedSince;
      if (held === 0) continue;
      const decision = exitFence(
        { qty: String(booked), ownerScope: "OPERATOR", intent: "OPERATOR", stamp: { lotId: null, boughtQtyAtBooking: "100" } },
        { qty: String(held), cumBoughtQty: String(100 + addedSince), lotId: null },
      );
      const surviving = Math.max(0, booked - reducedSince);
      if (surviving === 0) expect(decision.action).toBe("CANCEL");
      else if (surviving < booked) expect(decision).toEqual({ action: "CAP", qty: d(String(surviving)).toFixed(8), reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
      else expect(decision).toEqual({ action: "PROCEED", qty: d(String(booked)).toFixed(8) });
    }
  });
});

describe("PCR-1 v3: STRATEGY exits are fenced per owner", () => {
  const strategySell = (qty: string, allocStamp: string, pairStamp = "2") => ({
    qty,
    ownerScope: "STRATEGY",
    intent: "EXIT",
    stamp: { lotId: "lot_A", boughtQtyAtBooking: pairStamp, allocationBoughtQtyAtBooking: allocStamp },
  });

  it("review MEDIUM: another owner's buys and sells never cancel B's exit", () => {
    // A holds 1, B holds 1 (pair cum 2). B books an exit for its 1 (B's cum 1). A buys 5 and sells 6.
    // The pair: qty 1, cum 7 (pair FIFO alone would cancel). B's allocation: qty 1, cum 1 (untouched).
    expect(exitFence(strategySell("1", "1"), pos("1", "7"), { qty: "1", cumBoughtQty: "1" })).toEqual({ action: "PROCEED", qty: "1.00000000" });
  });

  it("an owner's own re-buy after a pro-rata reduction is never sold by its old exit", () => {
    // A booked 1 (A cum 1). A net close sold A's unit (A qty 0), then A re-entered with 1 (A qty 1, cum 2).
    expect(exitFence(strategySell("1", "1"), pos("2", "4"), { qty: "1", cumBoughtQty: "2" })).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
    // A booked 2 (A cum 2); 1 sold pro rata (A qty 1); A bought 1 (A qty 2, cum 3): only 1 booked unit survives.
    expect(exitFence(strategySell("2", "2"), pos("3", "5"), { qty: "2", cumBoughtQty: "3" })).toEqual({ action: "CAP", qty: "1.00000000", reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
  });

  it("a STRATEGY exit whose owner holds nothing is cancelled; one without an owner stamp falls back to pair level", () => {
    expect(exitFence(strategySell("1", "1"), pos("1", "2"), { qty: "0", cumBoughtQty: "1" })).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
    expect(exitFence(strategySell("1", "1"), pos("1", "2"), null)).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
    const pairOnly = { qty: "1", ownerScope: "STRATEGY", intent: "EXIT", stamp: { lotId: "lot_A", boughtQtyAtBooking: "2", allocationBoughtQtyAtBooking: null } };
    expect(exitFence(pairOnly, pos("2", "3"), { qty: "1", cumBoughtQty: "9" })).toEqual({ action: "PROCEED", qty: "1.00000000" });
  });

  it("flatten is capped at the quantity held instead of being rejected", () => {
    expect(exitFence(sell("3", "3", "lot_A", "ACCOUNT_FLATTEN", "FLATTEN"), pos("1", "3"))).toEqual({ action: "CAP", qty: "1.00000000", reason: "EXIT_CAPPED_TO_POSITION" });
  });

  it("property: per-owner decisions match each owner's own FIFO model, whatever the other owner does", () => {
    let s = 99;
    const random = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    let checks = 0;
    for (let run = 0; run < 2000; run++) {
      const owners = ["A", "B"].map(() => ({ units: [] as number[], cum: 0 }));
      let birth = 0;
      let pairCum = 0;
      const pending: Array<{ owner: number; qty: number; stamp: number; booked: Set<number> }> = [];
      for (let step = 0; step < 30; step++) {
        const o = Math.floor(random() * 2);
        const owner = owners[o]!;
        const r = random();
        if (r < 0.35) {
          const q = 1 + Math.floor(random() * 3);
          for (let i = 0; i < q; i++) owner.units.push(++birth);
          owner.cum += q;
          pairCum += q;
        } else if (r < 0.55 && owner.units.length > 0) {
          owner.units = owner.units.slice(1 + Math.floor(random() * owner.units.length));
        } else if (r < 0.75 && owner.units.length > 0) {
          pending.push({ owner: o, qty: 1 + Math.floor(random() * owner.units.length), stamp: owner.cum, booked: new Set(owner.units) });
        } else if (pending.length > 0) {
          const exit = pending.shift()!;
          const held = owners[exit.owner]!;
          const pairQty = owners[0]!.units.length + owners[1]!.units.length;
          if (pairQty === 0) continue;
          const surviving = held.units.filter((u) => exit.booked.has(u)).length;
          const decision = exitFence(
            { qty: String(exit.qty), ownerScope: "STRATEGY", intent: "EXIT", stamp: { lotId: null, boughtQtyAtBooking: "0", allocationBoughtQtyAtBooking: String(exit.stamp) } },
            { qty: String(pairQty), cumBoughtQty: String(pairCum), lotId: null },
            { qty: String(held.units.length), cumBoughtQty: String(held.cum) },
          );
          checks += 1;
          if (surviving === 0) expect(decision).toEqual({ action: "CANCEL", reason: "EXIT_LIFECYCLE_MISMATCH" });
          else if (surviving < exit.qty) expect(decision).toEqual({ action: "CAP", qty: d(String(surviving)).toFixed(8), reason: "EXIT_CAPPED_TO_BOOKED_LOT" });
          else expect(decision).toEqual({ action: "PROCEED", qty: d(String(exit.qty)).toFixed(8) });
          const sold = decision.action === "CANCEL" ? 0 : Number(decision.qty);
          expect(held.units.slice(0, sold).every((u) => exit.booked.has(u))).toBe(true);
          held.units = held.units.slice(sold);
        }
      }
    }
    expect(checks).toBeGreaterThan(3_000);
  });
});
