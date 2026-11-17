import { describe, expect, it } from "vitest";
import {
  AURUM_GOLD_ONLY_PROFILE as PROFILE,
  AURUM_ORDER_ACTIONS,
  assessAurumOrderScope,
  aurumInstrumentRole,
  type AurumProfile,
} from "./aurum-scope.js";
import { SEED_INSTRUMENTS } from "./instruments.js";
import { AURUM_GENERIC_GOLD_DFB_V1 } from "./spread-bet.js";
import { actionValidFor, nextSpreadPositionState } from "./spread-bet-lifecycle.js";

const ACTIVE: AurumProfile = { ...PROFILE, active: true };
const GOLD = { accountId: "aurum", instrumentId: "commodity:XAUUSD", productId: AURUM_GENERIC_GOLD_DFB_V1.id };

describe("AURUM GOLD_ONLY scope (unwired)", () => {
  it("ships inactive, bound to the generic gold product and a non-legacy account", () => {
    expect(PROFILE.active).toBe(false);
    expect(PROFILE.tradeableProductId).toBe(AURUM_GENERIC_GOLD_DFB_V1.id);
    expect(PROFILE.accountId).not.toBe("primary");
  });

  it("only the gold reference instrument is TRADEABLE; every other seeded instrument is not", () => {
    for (const instrument of SEED_INSTRUMENTS) {
      const role = aurumInstrumentRole(ACTIVE, instrument.id);
      expect(role === "TRADEABLE").toBe(instrument.id === "commodity:XAUUSD");
    }
    expect(aurumInstrumentRole(ACTIVE, "So11111111111111111111111111111111111111112")).toBe("DISABLED");
    expect(aurumInstrumentRole(ACTIVE, "COMMODITY:XAUUSD")).toBe("DISABLED");
    expect(aurumInstrumentRole(ACTIVE, "commodity:XAUUSD ")).toBe("DISABLED");
    expect(aurumInstrumentRole(ACTIVE, null)).toBe("DISABLED");
    expect(aurumInstrumentRole(ACTIVE, "__proto__")).toBe("DISABLED");
  });

  it("admits gold opening actions only when active", () => {
    expect(assessAurumOrderScope({ profile: ACTIVE, ...GOLD, action: "OPEN_LONG" })).toEqual({ allowed: true });
    expect(assessAurumOrderScope({ profile: ACTIVE, ...GOLD, action: "OPEN_SHORT" })).toEqual({ allowed: true });
    expect(assessAurumOrderScope({ profile: PROFILE, ...GOLD, action: "OPEN_LONG" })).toEqual({ allowed: false, reasons: ["AURUM_PROFILE_INACTIVE"] });
  });

  it("keeps exits and cancels available while inactive", () => {
    for (const action of ["REDUCE_LONG", "REDUCE_SHORT", "CLOSE_LONG", "CLOSE_SHORT", "CANCEL_ORDER"]) {
      expect(assessAurumOrderScope({ profile: PROFILE, ...GOLD, action })).toEqual({ allowed: true });
    }
  });

  it("negative: crypto, FX, ETF, energy and index instruments cannot produce AURUM orders for any action", () => {
    const others = [
      "solana:spot:universe",
      "So11111111111111111111111111111111111111112",
      "fx:EURUSD",
      "fx:GBPUSD",
      "fx:USDJPY",
      "etf:SPY",
      "etf:QQQ",
      "commodity:WTI",
      "index:SPX",
      "index:NDX",
      "index:FTSE",
      "index:DJI",
      "",
    ];
    for (const instrumentId of others) {
      for (const action of AURUM_ORDER_ACTIONS) {
        const r = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, instrumentId, action });
        expect(r.allowed).toBe(false);
        if (!r.allowed) expect(r.reasons).toContain("INSTRUMENT_NOT_TRADEABLE");
      }
    }
  });

  it("refuses the legacy account, other accounts, other products and unknown actions", () => {
    const legacy = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, accountId: "primary", action: "OPEN_LONG" });
    expect(legacy.allowed === false && legacy.reasons).toContain("LEGACY_ACCOUNT_REFUSED");
    const replay = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, accountId: "primary:REPLAY", action: "CLOSE_LONG" });
    expect(replay.allowed === false && replay.reasons).toContain("LEGACY_ACCOUNT_REFUSED");
    const other = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, accountId: "aurum-2", action: "OPEN_LONG" });
    expect(other.allowed === false && other.reasons).toContain("ACCOUNT_NOT_AURUM");
    const product = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, productId: "ig-spot-gold", action: "OPEN_LONG" });
    expect(product.allowed === false && product.reasons).toContain("PRODUCT_NOT_TRADEABLE");
    const sell = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, action: "SELL" });
    expect(sell.allowed === false && sell.reasons).toContain("UNKNOWN_ACTION");
  });

  it("an invalid profile refuses everything (no second tradeable, no legacy account, gold only)", () => {
    const bad = (over: Partial<AurumProfile>) => assessAurumOrderScope({ profile: { ...ACTIVE, ...over }, ...GOLD, action: "CLOSE_LONG" });
    expect(bad({ tradeableInstrumentId: "fx:EURUSD" })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ accountId: "primary" })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ roles: { "fx:EURUSD": "TRADEABLE" as never } })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ roles: { "commodity:XAUUSD": "OBSERVATIONAL_ONLY" } })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ active: "yes" as never })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    // Safety review: product must be a registered gold product; legacy id variants and null roles refuse.
    expect(bad({ tradeableProductId: "some-eurusd-product" })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ accountId: "PRIMARY" })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ accountId: " primary" })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    expect(bad({ roles: null as never })).toEqual({ allowed: false, reasons: ["INVALID_PROFILE"] });
    const upper = assessAurumOrderScope({ profile: ACTIVE, ...GOLD, accountId: "Primary", action: "CLOSE_LONG" });
    expect(upper.allowed === false && upper.reasons).toContain("LEGACY_ACCOUNT_REFUSED");
    expect(actionValidFor("SELL" as never, { direction: "SHORT", state: "OPEN" })).toEqual({ ok: false, reason: "UNKNOWN_ACTION" });
  });
});

describe("spread-bet position lifecycle", () => {
  it("follows the formal table and never leaves a terminal state", () => {
    expect(nextSpreadPositionState("PENDING_ENTRY", { type: "ENTRY_FILLED" })).toEqual({ ok: true, state: "OPEN" });
    expect(nextSpreadPositionState("PENDING_ENTRY", { type: "ENTRY_EXPIRED" })).toEqual({ ok: true, state: "CANCELLED" });
    expect(nextSpreadPositionState("OPEN", { type: "EXIT_REQUESTED" })).toEqual({ ok: true, state: "EXIT_PENDING" });
    expect(nextSpreadPositionState("EXIT_PENDING", { type: "EXIT_FILLED", remainingStake: "ZERO" })).toEqual({ ok: true, state: "CLOSED" });
    expect(nextSpreadPositionState("EXIT_PENDING", { type: "EXIT_FILLED", remainingStake: "PARTIAL" })).toEqual({ ok: true, state: "PARTIALLY_CLOSED" });
    expect(nextSpreadPositionState("EXIT_PENDING", { type: "EXIT_CANCELLED", remainingStake: "FULL" })).toEqual({ ok: true, state: "OPEN" });
    expect(nextSpreadPositionState("OPEN", { type: "ENTRY_FILLED" })).toEqual({ ok: false, reason: "ILLEGAL_TRANSITION" });
    for (const s of ["CLOSED", "CANCELLED", "REJECTED"] as const) {
      expect(nextSpreadPositionState(s, { type: "ENTRY_FILLED" })).toEqual({ ok: false, reason: "TERMINAL_STATE" });
    }
  });

  it("separates direction from action: no pyramiding, no wrong-direction reduce, one exit at a time", () => {
    expect(actionValidFor("OPEN_LONG", null)).toEqual({ ok: true });
    expect(actionValidFor("OPEN_SHORT", { direction: "LONG", state: "OPEN" })).toEqual({ ok: false, reason: "POSITION_ALREADY_OPEN" });
    expect(actionValidFor("OPEN_LONG", { direction: "LONG", state: "PENDING_ENTRY" })).toEqual({ ok: false, reason: "POSITION_ALREADY_OPEN" });
    expect(actionValidFor("CLOSE_SHORT", { direction: "LONG", state: "OPEN" })).toEqual({ ok: false, reason: "DIRECTION_MISMATCH" });
    expect(actionValidFor("REDUCE_LONG", { direction: "LONG", state: "PARTIALLY_CLOSED" })).toEqual({ ok: true });
    expect(actionValidFor("CLOSE_LONG", { direction: "LONG", state: "EXIT_PENDING" })).toEqual({ ok: false, reason: "EXIT_ALREADY_PENDING" });
    expect(actionValidFor("CLOSE_LONG", null)).toEqual({ ok: false, reason: "NO_OPEN_POSITION" });
    expect(actionValidFor("OPEN_LONG", { direction: "LONG", state: "CLOSED" })).toEqual({ ok: true });
  });
});
