import { d, MANUAL_INSTANCE_ID, usd } from "@odin/shared";
import { applyFill, type BookState } from "@odin/trading-engine";
import { describe, expect, it } from "vitest";
import {
  lotExcursion,
  lotMark,
  proRataSlices,
  reconcileLotsWithLedger,
  reconstructLots,
  summariseLotAttribution,
  UNRESOLVED_ATTRIBUTION_ID,
  type LedgerRowInput,
  type LotFillInput,
} from "./lot-history.js";

const ACCOUNT = "acct_a09";
const PAIR = "pairA";
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 2, 10, minute, second)).toISOString();

let seq = 0;
function fill(side: "BUY" | "SELL", qty: string, price: string, minute: number, extra: Partial<LotFillInput> = {}): LotFillInput {
  seq += 1;
  const notional = usd(d(qty).mul(d(price)));
  return {
    id: `fill_${String(seq).padStart(4, "0")}`,
    orderId: `ord_${seq}`,
    accountId: ACCOUNT,
    pairAddress: PAIR,
    baseSymbol: "AAA",
    side,
    qty,
    priceUsd: price,
    notionalUsd: notional,
    feeUsd: usd(d(notional).mul("0.003")),
    feeKnown: true,
    slippageBps: "25.000000",
    createdAt: at(minute),
    source: "LOCAL_SIM",
    strategyInstanceId: "inst_a",
    intent: side === "BUY" ? "ENTRY" : "EXIT",
    ownerScope: "STRATEGY",
    reasonCodes: side === "BUY" ? ["ENTRY_SIGNAL"] : ["EXIT_MOMENTUM"],
    strategyVersion: "v1",
    cycleId: `cyc_${minute}`,
    ...extra,
  };
}

/** Run fills through the real paper ledger (trading-engine applyFill) to produce the ledger rows it would book. */
function ledgerFor(fills: readonly LotFillInput[]): LedgerRowInput[] {
  let state: BookState = { cashUsd: "100000000.00000000", positions: [] };
  const rows: LedgerRowInput[] = [];
  for (const item of fills) {
    const applied = applyFill(state, {
      pairAddress: item.pairAddress,
      baseSymbol: item.baseSymbol,
      side: item.side,
      fill: { qty: item.qty, priceUsd: item.priceUsd, notionalUsd: item.notionalUsd, feeUsd: item.feeUsd } as never,
    });
    if (!applied.ok) throw new Error(applied.reason);
    state = applied.state;
    applied.lines
      .filter((line) => line.type === "FEE" || line.type === "REALIZED_PNL")
      .forEach((line, index) => rows.push({ id: `led_${item.id}_${index}`, accountId: item.accountId, type: line.type, amountUsd: line.amountUsd, fillId: item.id, orderId: item.orderId }));
  }
  return rows;
}

describe("lot reconstruction (ASCEND-09)", () => {
  it("opens, adds, reduces, closes and reopens lots on the fill sequence", () => {
    const fills = [
      fill("BUY", "10", "1.00", 0), // entry
      fill("BUY", "5", "1.20", 1), // add
      fill("SELL", "6", "1.30", 2), // partial reduce
      fill("SELL", "9", "1.10", 3, { ownerScope: "PROTECTION", strategyInstanceId: null, reasonCodes: ["STOP_LOSS"], intent: "EXIT" }), // close
      fill("BUY", "3", "1.05", 4), // reopen
    ];
    const history = reconstructLots({ fills, asOf: at(10) });
    expect(history.lots).toHaveLength(2);
    const [first, second] = history.lots;
    expect(first!.events.map((event) => event.kind)).toEqual(["ENTRY", "ADD", "REDUCE", "EXIT"]);
    expect(first!.status).toBe("CLOSED");
    expect(first!.openedAt).toBe(at(0));
    expect(first!.closedAt).toBe(at(3));
    expect(first!.holdingSeconds).toBe(180);
    expect(first!.holdingBasis).toBe("OPEN_TO_CLOSE");
    expect(first!.boughtQty).toBe("15.00000000");
    expect(first!.soldQty).toBe("15.00000000");
    expect(first!.openQty).toBe("0.00000000");
    expect(first!.entryFillId).toBe(fills[0]!.id);
    expect(first!.identityMethod).toBe("FILL_SEQUENCE");
    expect(first!.boundaryMethod).toBe("FILL_SEQUENCE");
    expect(first!.events[2]!.positionQtyBefore).toBe("15.00000000");
    expect(first!.events[2]!.positionQtyAfter).toBe("9.00000000");
    expect(first!.events[3]!.exitReason).toEqual({ code: "STOP_LOSS", source: "REASON_CODE" });
    expect(first!.events[3]!.ownerScope).toBe("PROTECTION");
    expect(first!.events[2]!.exitReason).toEqual({ code: "EXIT_MOMENTUM", source: "REASON_CODE" });
    // Average cost includes fees: (10 + 0.03 + 6 + 0.018) / 15
    expect(first!.events[1]!.avgCostAfterUsd).toBe(usd(d("16.048").div(15)));
    expect(first!.avgEntryPriceUsd).toBe(usd(d("16").div(15)));
    // Realised equals the real ledger's REALIZED_PNL rows.
    const ledger = ledgerFor(fills);
    const ledgerRealized = ledger.filter((row) => row.type === "REALIZED_PNL").reduce((sum, row) => sum.plus(d(row.amountUsd)), d("0"));
    expect(first!.realizedPnlUsd).toBe(usd(ledgerRealized));
    expect(second!.status).toBe("OPEN");
    expect(second!.closedAt).toBeNull();
    expect(second!.events.map((event) => event.kind)).toEqual(["ENTRY"]);
    expect(second!.holdingBasis).toBe("OPEN_TO_ASOF");
    expect(second!.holdingSeconds).toBe(360);
    expect(second!.realizedPnlUsd).toBe("0.00000000");
    expect(second!.avgExitPriceUsd).toBeNull();
  });

  it("labels lots with recorded lifecycle ids and says which source was used", () => {
    const fills = [fill("BUY", "1", "2", 0), fill("SELL", "1", "2", 1), fill("BUY", "2", "2", 2)];
    const history = reconstructLots({
      fills,
      asOf: at(5),
      hints: [
        { source: "PROTECTION_ORDER", accountId: ACCOUNT, pairAddress: PAIR, lifecycleId: "lot_old", at: at(0, 1) },
        { source: "POSITION", accountId: ACCOUNT, pairAddress: PAIR, lifecycleId: "lot_new" },
        { source: "PROTECTION_ORDER", accountId: ACCOUNT, pairAddress: "otherPair", lifecycleId: "lot_x", at: at(0, 1) },
      ],
    });
    expect(history.lots.map((lot) => [lot.lifecycleId, lot.lifecycleIdSource, lot.identityMethod])).toEqual([
      ["lot_old", "PROTECTION_ORDER", "LIFECYCLE_ID"],
      ["lot_new", "POSITION", "LIFECYCLE_ID"],
    ]);
    const conflicted = reconstructLots({
      fills,
      asOf: at(5),
      hints: [
        { source: "TRADE_LOT_SNAPSHOT", accountId: ACCOUNT, pairAddress: PAIR, lifecycleId: "lot_a", entryFillId: fills[2]!.id },
        { source: "POSITION", accountId: ACCOUNT, pairAddress: PAIR, lifecycleId: "lot_b" },
      ],
    });
    expect(conflicted.lots[1]!.lifecycleId).toBe("lot_a");
    expect(conflicted.lots[1]!.flags).toContain("LIFECYCLE_ID_CONFLICT");
    expect(conflicted.lots[0]!.identityMethod).toBe("FILL_SEQUENCE");
  });

  it("attributes a shared lot across strategy instances and the parts sum to the lot exactly", () => {
    const fills = [
      fill("BUY", "10", "1.00", 0, { strategyInstanceId: "inst_a" }),
      fill("BUY", "10", "2.00", 1, { strategyInstanceId: "inst_b" }),
      fill("SELL", "5", "1.50", 2, { strategyInstanceId: "inst_a" }), // single owner
      fill("BUY", "4", "1.60", 3, { ownerScope: "OPERATOR", strategyInstanceId: null, intent: "ENTRY" }),
      fill("SELL", "19", "1.80", 4, { ownerScope: "PROTECTION", strategyInstanceId: null, reasonCodes: ["TAKE_PROFIT"] }), // pro-rata
    ];
    const history = reconstructLots({ fills, asOf: at(10) });
    expect(history.lots).toHaveLength(1);
    const lot = history.lots[0]!;
    const ids = lot.instances.map((row) => row.strategyInstanceId);
    expect(ids).toEqual(["inst_a", "inst_b", MANUAL_INSTANCE_ID].sort());
    const sum = (pick: (row: (typeof lot.instances)[number]) => string) => usd(lot.instances.reduce((total, row) => total.plus(d(pick(row))), d("0")));
    expect(sum((row) => row.realizedPnlUsd)).toBe(lot.realizedPnlUsd);
    expect(sum((row) => row.feesUsd)).toBe(lot.feesUsd);
    const a = lot.instances.find((row) => row.strategyInstanceId === "inst_a")!;
    const b = lot.instances.find((row) => row.strategyInstanceId === "inst_b")!;
    expect(a.boughtQty).toBe("10.00000000");
    expect(a.soldQty).toBe("10.00000000");
    expect(b.soldQty).toBe("10.00000000");
    // Allocation basis: inst_a own cost 1.003/unit, inst_b 2.006/unit — b loses on its own basis.
    expect(d(a.allocationBasisRealizedPnlUsd!).gt(0)).toBe(true);
    expect(d(b.allocationBasisRealizedPnlUsd!).lt(0)).toBe(true);
    // The protection sell was split pro rata 5 : 10 : 4.
    const slices = lot.events[4]!.attribution;
    expect(slices.map((slice) => [slice.strategyInstanceId, slice.qty])).toEqual([
      ["inst_b", "10.00000000"],
      ["inst_a", "5.00000000"],
      [MANUAL_INSTANCE_ID, "4.00000000"],
    ]);
    const summary = summariseLotAttribution(history.lots);
    expect(summary.instancesSumToLots).toBe(true);
    expect(summary.totals.realizedPnlUsd).toBe(lot.realizedPnlUsd);
    expect(summary.instances.find((row) => row.strategyInstanceId === "inst_b")!.closedLots).toBe(1);
  });

  it("reports an exit no allocation owns as UNRESOLVED instead of absorbing it", () => {
    const fills = [
      fill("BUY", "10", "1", 0, { strategyInstanceId: "inst_a" }),
      fill("SELL", "10", "1", 1, { strategyInstanceId: "inst_b" }), // inst_b owns nothing
    ];
    const lot = reconstructLots({ fills, asOf: at(5) }).lots[0]!;
    expect(lot.flags).toContain("ALLOCATION_SHORTFALL");
    expect(lot.flags).toContain("ALLOCATION_RESIDUAL_AT_CLOSE");
    const unresolved = lot.instances.find((row) => row.strategyInstanceId === UNRESOLVED_ATTRIBUTION_ID)!;
    expect(unresolved.soldQty).toBe("10.00000000");
    expect(unresolved.allocationBasisRealizedPnlUsd).toBeNull();
    expect(summariseLotAttribution([lot]).instancesSumToLots).toBe(true);
  });

  it("pro-rata slices match the allocation settlement rule (floor, remainder to the last)", () => {
    const slices = proRataSlices(
      [
        { strategyInstanceId: "x", qty: d("1") },
        { strategyInstanceId: "y", qty: d("2") },
      ],
      d("1"),
    );
    expect(slices.map((slice) => [slice.strategyInstanceId, slice.qty.toFixed(8)])).toEqual([
      ["y", "0.66666666"],
      ["x", "0.33333334"],
    ]);
  });
});

describe("lot reconciliation with the ledger (ASCEND-09)", () => {
  const fills = [
    fill("BUY", "100", "0.37", 0, { strategyInstanceId: "inst_a" }),
    fill("BUY", "33.33333333", "0.41", 1, { strategyInstanceId: "inst_b" }),
    fill("SELL", "50", "0.45", 2, { strategyInstanceId: "inst_a" }),
    fill("SELL", "83.33333333", "0.29", 3, { ownerScope: "NET_CLOSE", strategyInstanceId: null }),
    fill("BUY", "7", "0.31", 4, { strategyInstanceId: "inst_a" }),
  ];
  const ledger = ledgerFor(fills);

  it("matches the REALIZED_PNL and FEE ledger totals exactly", () => {
    const history = reconstructLots({ fills, asOf: at(9) });
    const result = reconcileLotsWithLedger({ accountId: ACCOUNT, history, ledger, positions: [{ pairAddress: PAIR, baseQty: "7.00000000" }] });
    expect(result.status).toBe("RECONCILED");
    expect(result.items).toEqual([]);
    expect(result.realizedPnl.unreconciledUsd).toBe("0.00000000");
    expect(result.fees.unreconciledUsd).toBe("0.00000000");
    expect(result.realizedPnl.lotsTotalUsd).toBe(result.realizedPnl.ledgerTotalUsd);
    expect(d(result.realizedPnl.ledgerTotalUsd).eq(0)).toBe(false);
  });

  it("reports a corrupted ledger as UNRECONCILED with the amount itemised", () => {
    const history = reconstructLots({ fills, asOf: at(9) });
    const tampered = ledger.map((row) => (row.type === "REALIZED_PNL" && row.fillId === fills[2]!.id ? { ...row, amountUsd: usd(d(row.amountUsd).plus("0.25")) } : row));
    const extra = [...tampered, { id: "led_ghost", accountId: ACCOUNT, type: "FEE", amountUsd: "-0.10000000", fillId: null, orderId: null }];
    const result = reconcileLotsWithLedger({ accountId: ACCOUNT, history, ledger: extra });
    expect(result.status).toBe("UNRECONCILED");
    expect(result.realizedPnl.unreconciledUsd).toBe("0.25000000");
    expect(result.fees.unreconciledUsd).toBe("0.10000000");
    expect(result.items.map((item) => item.kind).sort()).toEqual(["FILL_AMOUNT_MISMATCH", "LEDGER_ROW_WITHOUT_FILL"]);
    expect(result.items.find((item) => item.kind === "FILL_AMOUNT_MISMATCH")!.difference).toBe("0.25000000");
  });

  it("flags a missing ledger row, an orphan sell and a position that the fills do not explain", () => {
    const orphan = fill("SELL", "1", "1", 30, { pairAddress: "pairB" });
    const history = reconstructLots({ fills: [...fills, orphan], asOf: at(40) });
    expect(history.orphanFills.map((row) => row.fill.id)).toEqual([orphan.id]);
    const missing = ledger.filter((row) => !(row.type === "FEE" && row.fillId === fills[0]!.id));
    const result = reconcileLotsWithLedger({
      accountId: ACCOUNT,
      history,
      ledger: missing,
      positions: [{ pairAddress: PAIR, baseQty: "8.00000000" }],
    });
    expect(result.status).toBe("UNRECONCILED");
    expect(result.items.map((item) => item.kind).sort()).toEqual(["FILL_WITHOUT_LEDGER_ROW", "FILL_WITHOUT_LEDGER_ROW", "ORPHAN_FILL", "POSITION_QTY_MISMATCH"].sort());
    expect(result.fees.withinTolerance).toBe(false);
  });

  it("compares per-instance attribution with stored StrategyAllocation rows", () => {
    const simple = [fill("BUY", "10", "1", 0, { strategyInstanceId: "inst_a" }), fill("SELL", "10", "1.1", 1, { strategyInstanceId: "inst_a" })];
    const history = reconstructLots({ fills: simple, asOf: at(5) });
    const row = history.lots[0]!.instances[0]!;
    const good = reconcileLotsWithLedger({
      accountId: ACCOUNT,
      history,
      ledger: ledgerFor(simple),
      allocations: [{ strategyInstanceId: "inst_a", pairAddress: PAIR, qty: "0", realizedPnlUsd: row.allocationBasisRealizedPnlUsd!, feesUsd: row.feesUsd, costBasisKnown: true }],
    });
    expect(good.allocationStatus).toBe("MATCH");
    const bad = reconcileLotsWithLedger({
      accountId: ACCOUNT,
      history,
      ledger: ledgerFor(simple),
      allocations: [{ strategyInstanceId: "inst_a", pairAddress: PAIR, qty: "0", realizedPnlUsd: "5", feesUsd: row.feesUsd, costBasisKnown: true }],
    });
    expect(bad.allocationStatus).toBe("MISMATCH");
    expect(bad.status).toBe("RECONCILED"); // the ledger itself still reconciles
  });
});

describe("lot excursions and marks (ASCEND-09)", () => {
  const closed = { pairAddress: PAIR, openedAt: at(0), closedAt: at(10), referencePriceUsd: "100" };

  it("uses only marks received inside [open, close], both ends inclusive", () => {
    const marks = [
      { pairAddress: PAIR, receivedAt: new Date(Date.parse(at(0)) - 1).toISOString(), priceUsd: "500" }, // 1 ms before open
      { pairAddress: PAIR, receivedAt: at(0), priceUsd: "101" }, // at open
      { pairAddress: PAIR, receivedAt: at(5), priceUsd: "95" },
      { pairAddress: PAIR, receivedAt: at(10), priceUsd: "108" }, // at close
      { pairAddress: PAIR, receivedAt: new Date(Date.parse(at(10)) + 1).toISOString(), priceUsd: "1" }, // 1 ms after close
      { pairAddress: "otherPair", receivedAt: at(5), priceUsd: "1000" },
      { pairAddress: PAIR, receivedAt: at(6), priceUsd: null },
    ];
    const excursion = lotExcursion(closed, marks, at(60));
    expect(excursion.observations).toBe(3);
    expect(excursion.mfePct).toBe("8.0000");
    expect(excursion.maePct).toBe("-5.0000");
    expect(excursion.windowEnd).toBe(at(10));
    expect(excursion.windowEndIsAsOf).toBe(false);
  });

  it("ends an OPEN lot's window at asOf and ignores later marks", () => {
    const open = { ...closed, closedAt: null };
    const excursion = lotExcursion(open, [
      { pairAddress: PAIR, receivedAt: at(3), priceUsd: "90" },
      { pairAddress: PAIR, receivedAt: at(30), priceUsd: "200" },
    ], at(20));
    expect(excursion.windowEnd).toBe(at(20));
    expect(excursion.windowEndIsAsOf).toBe(true);
    expect(excursion.mfePct).toBe("-10.0000");
    expect(excursion.observations).toBe(1);
  });

  it("returns null, never zero, when marks are missing", () => {
    const excursion = lotExcursion(closed, [], at(60));
    expect(excursion).toMatchObject({ observations: 0, highUsd: null, lowUsd: null, mfePct: null, maePct: null });
    const lot = reconstructLots({ fills: [fill("BUY", "2", "3", 0)], asOf: at(5) }).lots[0]!;
    expect(lotMark(lot, null)).toEqual({ markUsd: null, markAt: null, unrealizedPnlUsd: null });
    expect(lotMark(lot, { priceUsd: null, receivedAt: at(4) }).unrealizedPnlUsd).toBeNull();
    expect(lotMark(lot, { priceUsd: "3.5", receivedAt: at(4) }).unrealizedPnlUsd).toBe(usd(d("2").mul(d("3.5").minus(d(lot.avgCostUsd)))));
  });
});
