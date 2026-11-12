import { Decimal } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { economicExits, exitRootKey } from "./economic-trades.js";
import { performanceReport } from "./performance.js";

/** OPERATION INTEGRITY F11: trade statistics count economic exits, never fill chunks; totals are unchanged. */
const valuation = { cashUsd: "1000", equityUsd: "1000", unrealizedPnlUsd: "0", realizedPnlUsd: "0", marksComplete: true, positions: [], valuation: "LIVE", states: [] } as never;
let seq = 0;
const entry = (orderId: string | null, amountUsd: string) => ({ id: `le${(seq += 1)}`, amountUsd, orderId });
const orders = (pairs: Record<string, string>) => new Map(Object.entries(pairs));
const report = (pnl: string[]) => performanceReport({ valuation, startingBalanceUsd: "1000", feesUsd: "0", closedTradePnlUsd: pnl });
const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0)).toFixed(8);

describe("economic exit identity (F11)", () => {
  it("strips every trailing remainder suffix and nothing else", () => {
    expect(exitRootKey("coid_1")).toBe("coid_1");
    expect(exitRootKey("coid_1:rem1")).toBe("coid_1");
    expect(exitRootKey("coid_1:rem12:rem3")).toBe("coid_1");
    expect(exitRootKey("position:pairX")).toBe("position:pairX");
    expect(exitRootKey("rem:remx")).toBe("rem:remx");
  });

  it("one exit split across several fill chunks is one trade", () => {
    const e = [entry("o1", "4"), entry("o2", "3"), entry("o3", "2")];
    const s = economicExits(e, orders({ o1: "X:rem1:rem1", o2: "X:rem1", o3: "X" }));
    expect(s).toMatchObject({ chunks: 3, economicTrades: 1, unlinkedEntries: 0 });
    expect(s.trades[0]).toMatchObject({ pnlUsd: "9.00000000", chunks: 3, linked: true });
    expect(report(s.trades.map((t) => t.pnlUsd))).toMatchObject({ closedTrades: 1, wins: 1, losses: 0 });
    // Old behaviour, for the record: three "trades".
    expect(report(e.map((x) => x.amountUsd)).closedTrades).toBe(3);
  });

  it("a winning exit with a losing chunk is one win; a losing exit with a winning chunk is one loss", () => {
    const win = economicExits([entry("a", "-1"), entry("b", "5")], orders({ a: "W:rem1", b: "W" }));
    expect(report(win.trades.map((t) => t.pnlUsd))).toMatchObject({ wins: 1, losses: 0, avgWinUsd: "4.00000000" });
    const loss = economicExits([entry("c", "2"), entry("d", "-6")], orders({ c: "L:rem1", d: "L" }));
    expect(report(loss.trades.map((t) => t.pnlUsd))).toMatchObject({ wins: 0, losses: 1, avgLossUsd: "4.00000000" });
  });

  it("distinct exits from one position (scale-outs, stop then exit, close then reopen) stay distinct", () => {
    const s = economicExits([entry("s1", "2"), entry("s2", "-1"), entry("s3", "3"), entry("s3r", "1")], orders({ s1: "scaleout_1", s2: "stop_2", s3: "after_reopen_3", s3r: "after_reopen_3:rem1" }));
    expect(s.economicTrades).toBe(3);
    expect(s.trades.map((t) => t.pnlUsd)).toEqual(["2.00000000", "-1.00000000", "4.00000000"]);
  });

  it("missing lineage: an entry without an order is its own trade and is counted as unlinked", () => {
    const s = economicExits([entry(null, "1"), entry("gone", "2"), entry(null, "3")], orders({}));
    expect(s).toMatchObject({ chunks: 3, economicTrades: 3, unlinkedEntries: 3 });
    expect(s.trades.every((t) => !t.linked)).toBe(true);
  });

  it("total realised P&L is identical before and after grouping, and fees are untouched", () => {
    const e = [entry("1", "10.12345678"), entry("2", "-3.00000001"), entry("3", "0.5"), entry(null, "-7.1"), entry("4", "2")];
    const s = economicExits(e, orders({ "1": "A", "2": "A:rem1", "3": "B", "4": "B:rem1:rem2" }));
    expect(s.totalRealizedUsd).toBe(sum(e.map((x) => x.amountUsd)));
    expect(sum(s.trades.map((t) => t.pnlUsd))).toBe(s.totalRealizedUsd);
    const before = report(e.map((x) => x.amountUsd));
    const after = report(s.trades.map((t) => t.pnlUsd));
    expect(after.feesUsd).toBe(before.feesUsd);
    expect(after.returnPct).toBe(before.returnPct);
    // expectancy × trades = net realised, in both bases.
    expect(new Decimal(after.expectancyUsd!).mul(after.closedTrades).toFixed(6)).toBe(new Decimal(s.totalRealizedUsd).toFixed(6));
  });

  it("strategy allocation: chunks of different owners' exits are never merged (different root orders)", () => {
    const s = economicExits([entry("i1", "1"), entry("i2", "1"), entry("i1r", "1")], orders({ i1: "inst1_exit", i2: "inst2_exit", i1r: "inst1_exit:rem1" }));
    expect(s.trades.map((t) => [t.key, t.chunks])).toEqual([["exit:inst1_exit", 2], ["exit:inst2_exit", 1]]);
  });

  it("golden comparison: one exit filled at once versus the same exit in chunks give the same trade statistics", () => {
    const once = report(economicExits([entry("g", "6")], orders({ g: "G" })).trades.map((t) => t.pnlUsd));
    const chunked = report(economicExits([entry("g3", "1"), entry("g2", "2"), entry("g1", "3")], orders({ g1: "G", g2: "G:rem1", g3: "G:rem1:rem1" })).trades.map((t) => t.pnlUsd));
    expect(chunked).toEqual(once);
  });
});
