import { describe, expect, it } from "vitest";
import {
  AURUM_GENERIC_GOLD_DFB_V1 as SPEC,
  bookGbp,
  deriveSpreadBetQuote,
  entryPrice,
  exitPrice,
  marginGbp,
  notionalGbp,
  pnlGbp,
  sizeStake,
  stopFillPrice,
  validateProductSpec,
  type ReferenceQuote,
  type SpreadBetProductSpec,
} from "./spread-bet.js";

const ref = (bid: string, ask: string, over: Partial<ReferenceQuote> = {}): ReferenceQuote => ({
  kind: "REFERENCE_MARKET_QUOTE",
  quoteId: "q1",
  instrumentId: "commodity:XAUUSD",
  provider: "oanda_practice",
  bid,
  ask,
  eventTime: "2026-11-17T10:00:00.000Z",
  ...over,
});

function quote(bid: string, ask: string, scenario: "BASELINE" | "ELEVATED" | "SEVERE" = "BASELINE") {
  const r = deriveSpreadBetQuote(SPEC, ref(bid, ask), scenario);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

const pnl = (direction: "LONG" | "SHORT", stakeGbp: string, entry: string, exit: string) => {
  const r = pnlGbp({ spec: SPEC, direction, stakeGbp, entry, exit });
  if (!r.ok) throw new Error(r.reason);
  return bookGbp(r.value);
};

describe("spread-bet product spec", () => {
  it("the generic profile is valid and labelled a simulation, not broker parity", () => {
    expect(validateProductSpec(SPEC).ok).toBe(true);
    expect(SPEC.provenance).toBe("GENERIC_SIMULATION");
    expect(SPEC.accountCurrency).toBe("GBP");
    expect(Object.isFrozen(SPEC)).toBe(true);
  });

  it("refuses inconsistent specs", () => {
    const bad = (over: Partial<SpreadBetProductSpec>) => validateProductSpec({ ...SPEC, ...over }).ok;
    expect(bad({ pointSize: "0" })).toBe(false);
    expect(bad({ minStakeGbp: "0.505" })).toBe(false); // not a multiple of the increment
    expect(bad({ maxStakeGbp: "0.1" })).toBe(false);
    expect(bad({ marginRate: "0" })).toBe(false);
    expect(bad({ marginRate: "1.5" })).toBe(false);
    expect(bad({ spreadPoints: { BASELINE: "2", ELEVATED: "1", SEVERE: "4" } })).toBe(false);
    expect(bad({ pointSize: "NaN" })).toBe(false);
    expect(bad({ provenance: "BROKER_DOCUMENTED" })).toBe(false); // no source, no verification date
  });
});

describe("simulated spread-bet quote", () => {
  it("widens to the scenario spread around the reference mid and labels itself simulated", () => {
    const q = quote("2650.10", "2650.40");
    expect(q).toMatchObject({ kind: "SIMULATED_SPREAD_BET_QUOTE", bid: "2649.95", ask: "2650.55", spreadPoints: "0.6", derivedFromQuoteId: "q1" });
    expect(q.disclosure).toMatch(/Not a broker quote/);
  });

  it("never narrows a reference spread wider than the scenario", () => {
    const q = quote("2650.00", "2652.00");
    expect(q.bid).toBe("2650.00");
    expect(q.ask).toBe("2652.00");
  });

  it("elevated and severe scenarios are wider", () => {
    expect(Number(quote("2650.10", "2650.40", "ELEVATED").spreadPoints)).toBe(1.5);
    expect(Number(quote("2650.10", "2650.40", "SEVERE").spreadPoints)).toBe(4);
  });

  it("rejects crossed, locked, one-sided, non-positive, wrong-instrument and bad-time quotes", () => {
    expect(deriveSpreadBetQuote(SPEC, ref("2650.4", "2650.1"), "BASELINE")).toEqual({ ok: false, reason: "CROSSED_OR_LOCKED" });
    expect(deriveSpreadBetQuote(SPEC, ref("2650.1", "2650.1"), "BASELINE")).toEqual({ ok: false, reason: "CROSSED_OR_LOCKED" });
    expect(deriveSpreadBetQuote(SPEC, ref("", "2650.1"), "BASELINE")).toEqual({ ok: false, reason: "INVALID_PRICE" });
    expect(deriveSpreadBetQuote(SPEC, ref("0", "2650.1"), "BASELINE")).toEqual({ ok: false, reason: "INVALID_PRICE" });
    expect(deriveSpreadBetQuote(SPEC, ref("1.1", "1.2", { instrumentId: "fx:EURUSD" }), "BASELINE")).toEqual({ ok: false, reason: "WRONG_INSTRUMENT" });
    expect(deriveSpreadBetQuote(SPEC, ref("2650.1", "2650.4", { eventTime: "nope" }), "BASELINE")).toEqual({ ok: false, reason: "INVALID_EVENT_TIME" });
  });
});

describe("spread-bet P&L (GBP per $1 point)", () => {
  const open = quote("2650.10", "2650.40"); // 2649.95 / 2650.55
  const up = quote("2660.10", "2660.40"); // 2659.95 / 2660.55
  const down = quote("2640.10", "2640.40"); // 2639.95 / 2640.55

  it("LONG opens at ask and closes at bid; SHORT opens at bid and closes at ask", () => {
    expect(entryPrice("LONG", open)).toBe("2650.55");
    expect(exitPrice("LONG", open)).toBe("2649.95");
    expect(entryPrice("SHORT", open)).toBe("2649.95");
    expect(exitPrice("SHORT", open)).toBe("2650.55");
  });

  it("long profit, long loss, short profit, short loss", () => {
    expect(pnl("LONG", "2", entryPrice("LONG", open), exitPrice("LONG", up))).toBe("18.80");
    expect(pnl("LONG", "2", entryPrice("LONG", open), exitPrice("LONG", down))).toBe("-21.20");
    expect(pnl("SHORT", "2", entryPrice("SHORT", open), exitPrice("SHORT", down))).toBe("18.80");
    expect(pnl("SHORT", "2", entryPrice("SHORT", open), exitPrice("SHORT", up))).toBe("-21.20");
  });

  it("a flat market loses exactly one spread per round trip and the spread is not deducted twice", () => {
    expect(pnl("LONG", "2", entryPrice("LONG", open), exitPrice("LONG", open))).toBe("-1.20");
    expect(pnl("SHORT", "2", entryPrice("SHORT", open), exitPrice("SHORT", open))).toBe("-1.20");
  });

  it("round-trip identity: long + short between the same quotes = −(entry spread + exit spread) × stake", () => {
    for (let i = 0; i < 200; i++) {
      const a = 1800 + ((i * 37) % 900) + (i % 7) / 10;
      const b = 1800 + ((i * 53) % 900) + (i % 5) / 10;
      const q1 = quote(a.toFixed(2), (a + 0.3).toFixed(2));
      const q2 = quote(b.toFixed(2), (b + 0.3).toFixed(2));
      const long = pnlGbp({ spec: SPEC, direction: "LONG", stakeGbp: "1.37", entry: q1.ask, exit: q2.bid });
      const short = pnlGbp({ spec: SPEC, direction: "SHORT", stakeGbp: "1.37", entry: q1.bid, exit: q2.ask });
      if (!long.ok || !short.ok) throw new Error("pnl");
      const spreads = (Number(q1.ask) - Number(q1.bid) + Number(q2.ask) - Number(q2.bid)) * 1.37;
      expect(long.value.plus(short.value).toNumber()).toBeCloseTo(-spreads, 8);
    }
  });

  it("books to pennies rounding toward negative infinity", () => {
    const gain = pnlGbp({ spec: SPEC, direction: "LONG", stakeGbp: "0.33", entry: "2650.00", exit: "2650.01" });
    expect(gain.ok && bookGbp(gain.value)).toBe("0.00");
    const loss = pnlGbp({ spec: SPEC, direction: "LONG", stakeGbp: "0.33", entry: "2650.01", exit: "2650.00" });
    expect(loss.ok && bookGbp(loss.value)).toBe("-0.01");
  });

  it("point-size conversion: a $0.10 point multiplies the P&L by ten", () => {
    const tenth = { ...SPEC, id: "t", pointSize: "0.1" };
    const r = pnlGbp({ spec: tenth, direction: "LONG", stakeGbp: "1", entry: "2650.00", exit: "2651.00" });
    expect(r.ok && bookGbp(r.value)).toBe("10.00");
  });

  it("refuses non-positive or non-numeric inputs", () => {
    expect(pnlGbp({ spec: SPEC, direction: "LONG", stakeGbp: "0", entry: "1", exit: "2" }).ok).toBe(false);
    expect(pnlGbp({ spec: SPEC, direction: "LONG", stakeGbp: "1", entry: "x", exit: "2" }).ok).toBe(false);
  });
});

describe("margin", () => {
  it("reserves notional × margin rate, rounded up; notional is not a cash outlay", () => {
    expect(notionalGbp(SPEC, "2", "2650.55").toFixed(2)).toBe("5301.10");
    expect(marginGbp(SPEC, "2", "2650.55")).toBe("265.06"); // 265.055 rounded up
  });
});

describe("stake sizing", () => {
  const base = {
    spec: SPEC,
    direction: "LONG" as const,
    equityGbp: "10000",
    riskFraction: "0.005",
    entry: "2650.55",
    closingSide: "2649.95",
    stop: "2640.55",
    slippageAllowancePoints: "2",
    availableMarginGbp: "10000",
    usedMarginGbp: "0",
    maxMarginUtilisation: "0.3",
  };

  it("sizes from permitted risk / (stop distance + slippage), rounded down to the increment", () => {
    const r = sizeStake(base);
    expect(r).toEqual({
      ok: true,
      value: {
        stakeGbp: "4.16",
        stopDistancePoints: "10",
        estimatedLossAtStopGbp: "49.92",
        marginGbp: "551.32",
        permittedRiskGbp: "50.00",
        cappedAtMaxStake: false,
        disclosure: "Estimated loss at stop is not a maximum loss: ordinary stops can gap.",
      },
    });
    if (r.ok) expect(Number(r.value.estimatedLossAtStopGbp)).toBeLessThanOrEqual(Number(r.value.permittedRiskGbp));
  });

  it("short sizing mirrors long", () => {
    const r = sizeStake({ ...base, direction: "SHORT", entry: "2649.95", closingSide: "2650.55", stop: "2659.95" });
    expect(r.ok && r.value.stakeGbp).toBe("4.16");
  });

  it("rejects when the minimum stake would exceed permitted risk, never rounding up", () => {
    expect(sizeStake({ ...base, stop: "2450.55" })).toEqual({ ok: false, reason: "MIN_STAKE_EXCEEDS_RISK" });
  });

  it("caps at the maximum stake (lower risk), flagged", () => {
    const r = sizeStake({ ...base, stop: "2649.55", slippageAllowancePoints: "0" });
    expect(r.ok && r.value).toMatchObject({ stakeGbp: "5", cappedAtMaxStake: true });
  });

  it("P4: cappedAtMaxStake reflects the final stake when penny rounding takes it below the maximum", () => {
    // Permitted 50.004 (booked 50.00); loss per £ 10.0005 points: raw stake 5.00015 > max 5, but 5 × 10.0005 =
    // 50.0025 books to 50.01 > 50.00, so the rounding loop reduces the stake to 4.99.
    const r = sizeStake({ ...base, equityGbp: "10000.8", slippageAllowancePoints: "0.0005" });
    expect(r.ok && r.value).toMatchObject({ stakeGbp: "4.99", cappedAtMaxStake: false, permittedRiskGbp: "50.00" });
    if (r.ok) expect(Number(r.value.estimatedLossAtStopGbp)).toBeLessThanOrEqual(50);
  });

  it("edge cases: invalid prices, negative inputs, extreme volatility and exhausted margin are refusals", () => {
    for (const bad of ["NaN", "Infinity", "-1", "0", "", "abc"]) {
      expect(sizeStake({ ...base, entry: bad }).ok).toBe(false);
      expect(sizeStake({ ...base, equityGbp: bad }).ok).toBe(false);
      expect(sizeStake({ ...base, stop: bad }).ok).toBe(false);
    }
    expect(sizeStake({ ...base, availableMarginGbp: "-1" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(sizeStake({ ...base, usedMarginGbp: "-5" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(sizeStake({ ...base, slippageAllowancePoints: "-0.1" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    // Extreme volatility: a 500-point stop leaves less than the minimum stake: refused, never rounded up.
    expect(sizeStake({ ...base, stop: "2150.55" })).toEqual({ ok: false, reason: "MIN_STAKE_EXCEEDS_RISK" });
    // Exhausted margin.
    expect(sizeStake({ ...base, availableMarginGbp: "0" })).toEqual({ ok: false, reason: "INSUFFICIENT_MARGIN" });
    expect(sizeStake({ ...base, usedMarginGbp: "2999", maxMarginUtilisation: "0.3" })).toEqual({ ok: false, reason: "MARGIN_UTILISATION_LIMIT" });
  });

  it("refuses insufficient margin and margin utilisation above the ceiling", () => {
    expect(sizeStake({ ...base, availableMarginGbp: "100" })).toEqual({ ok: false, reason: "INSUFFICIENT_MARGIN" });
    expect(sizeStake({ ...base, usedMarginGbp: "2800" })).toEqual({ ok: false, reason: "MARGIN_UTILISATION_LIMIT" });
  });

  it("refuses stops on the wrong side, sub-point stops and out-of-range risk fractions", () => {
    expect(sizeStake({ ...base, stop: "2660" })).toEqual({ ok: false, reason: "STOP_ON_WRONG_SIDE" });
    expect(sizeStake({ ...base, direction: "SHORT", entry: "2649.95", closingSide: "2650.55", stop: "2640" })).toEqual({ ok: false, reason: "STOP_ON_WRONG_SIDE" });
    expect(sizeStake({ ...base, stop: "2649.90" })).toEqual({ ok: false, reason: "STOP_DISTANCE_TOO_SMALL" });
    expect(sizeStake({ ...base, stop: "2650.00" })).toEqual({ ok: false, reason: "STOP_INSIDE_SPREAD" });
    expect(sizeStake({ ...base, riskFraction: "0.05" })).toEqual({ ok: false, reason: "INVALID_RISK_FRACTION" });
    expect(sizeStake({ ...base, riskFraction: "0" })).toEqual({ ok: false, reason: "INVALID_RISK_FRACTION" });
    expect(sizeStake({ ...base, equityGbp: "NaN" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(sizeStake({ ...base, maxMarginUtilisation: "2" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
  });
});

describe("safety review fixes", () => {
  const base = {
    spec: SPEC,
    equityGbp: "10000",
    riskFraction: "0.005",
    slippageAllowancePoints: "0",
    availableMarginGbp: "10000",
    usedMarginGbp: "0",
    maxMarginUtilisation: "0.3",
  };

  it("refuses a stop inside the spread (it would fill through at once)", () => {
    // SEVERE: ask 2004, bid 2000. A LONG stop at 2002 is below the ask but above the bid.
    expect(sizeStake({ ...base, direction: "LONG", entry: "2004", closingSide: "2000", stop: "2002" })).toEqual({ ok: false, reason: "STOP_INSIDE_SPREAD" });
    expect(sizeStake({ ...base, direction: "SHORT", entry: "2000", closingSide: "2004", stop: "2002" })).toEqual({ ok: false, reason: "STOP_INSIDE_SPREAD" });
    expect(sizeStake({ ...base, direction: "LONG", entry: "2004", closingSide: "2005", stop: "1990" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
  });

  it("rejects an unknown direction instead of treating it as SHORT", () => {
    const q = { bid: "1", ask: "2" };
    expect(() => entryPrice("long" as never, q)).toThrow("INVALID_DIRECTION");
    expect(() => exitPrice("" as never, q)).toThrow("INVALID_DIRECTION");
    expect(() => stopFillPrice("long" as never, "1", "1")).toThrow("INVALID_DIRECTION");
    expect(pnlGbp({ spec: SPEC, direction: "long" as never, stakeGbp: "1", entry: "1", exit: "2" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(sizeStake({ ...base, direction: "long" as never, entry: "2004", closingSide: "2000", stop: "1990" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
  });

  it("the booked loss estimate never exceeds the booked permitted risk", () => {
    let sized = 0;
    for (let i = 0; i < 300; i++) {
      const stopPts = 3 + (i % 47) + (i % 13) / 7;
      const r = sizeStake({
        ...base,
        riskFraction: (0.0025 + (i % 9) * 0.0003).toFixed(5),
        equityGbp: (9000 + i * 7.31).toFixed(2),
        direction: "LONG",
        entry: "2650.55",
        closingSide: "2649.95",
        stop: (2650.55 - stopPts).toFixed(2),
        slippageAllowancePoints: String(i % 4),
      });
      if (r.ok) {
        sized++;
        expect(Number(r.value.estimatedLossAtStopGbp)).toBeLessThanOrEqual(Number(r.value.permittedRiskGbp));
      }
    }
    expect(sized).toBeGreaterThan(100);
  });

  it("refuses an unknown scenario and a max stake off the increment", () => {
    expect(deriveSpreadBetQuote(SPEC, ref("2650.1", "2650.4"), "EXTREME" as never)).toEqual({ ok: false, reason: "INVALID_SCENARIO" });
    expect(deriveSpreadBetQuote(SPEC, ref("2650.1", "2650.4"), "__proto__" as never)).toEqual({ ok: false, reason: "INVALID_SCENARIO" });
    expect(validateProductSpec({ ...SPEC, maxStakeGbp: "5.005" }).ok).toBe(false);
  });
});

describe("stop gaps", () => {
  it("an ordinary stop fills at the gapped price, not the stop level", () => {
    expect(stopFillPrice("LONG", "2640", "2630.25")).toBe("2630.25");
    expect(stopFillPrice("LONG", "2640", "2641")).toBeNull();
    expect(stopFillPrice("SHORT", "2660", "2671.5")).toBe("2671.5");
    expect(stopFillPrice("SHORT", "2660", "2659")).toBeNull();
  });
});
