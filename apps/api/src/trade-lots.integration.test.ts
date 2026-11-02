/**
 * ASCEND-09 lot history API against a real database. Fills and ledger rows are booked with the real
 * paper ledger arithmetic (trading-engine applyFill), then the read-only service must reconcile them,
 * stay scoped to the active account, and report a corrupted ledger as UNRECONCILED.
 */
import { d, INTEGRATION_TEST_ADVISORY_LOCK, usd } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import { applyFill, type BookState } from "@odin/trading-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TerminalService } from "./terminal.service.js";
import { TradeLotsService } from "./trade-lots.service.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const ACCOUNT = "acct_a09_api";
const OTHER = "acct_a09_other";
const PAIR = "pairA09";
const base = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minute: number) => new Date(base + minute * 60_000);

type Spec = { account: string; side: "BUY" | "SELL"; qty: string; price: string; minute: number; instance: string | null; scope: string; reasons?: string[] };

async function book(prisma: PrismaClient, specs: Spec[]) {
  const books = new Map<string, BookState>();
  let n = 0;
  for (const spec of specs) {
    n += 1;
    const state = books.get(spec.account) ?? { cashUsd: "1000000.00000000", positions: [] };
    const notional = usd(d(spec.qty).mul(spec.price));
    const fee = usd(d(notional).mul("0.003"));
    const applied = applyFill(state, { pairAddress: PAIR, baseSymbol: "A09", side: spec.side, fill: { qty: spec.qty, priceUsd: spec.price, notionalUsd: notional, feeUsd: fee } as never });
    if (!applied.ok) throw new Error(applied.reason);
    books.set(spec.account, applied.state);
    const when = at(spec.minute);
    const order = await prisma.order.create({
      data: {
        clientOrderId: `coid_a09_${spec.account}_${n}`,
        cycleId: `cyc_a09_${n}`,
        accountId: spec.account,
        pairAddress: PAIR,
        baseSymbol: "A09",
        side: spec.side,
        intent: spec.side === "BUY" ? "ENTRY" : "EXIT",
        status: "FILLED",
        qty: spec.qty,
        filledQty: spec.qty,
        reasonCodes: spec.reasons ?? [],
        strategyInstanceId: spec.instance,
        ownerScope: spec.scope,
        createdAt: when,
      },
    });
    const fill = await prisma.fill.create({
      data: { orderId: order.id, pairAddress: PAIR, side: spec.side, qty: spec.qty, priceUsd: spec.price, notionalUsd: notional, feeUsd: fee, slippageBps: "20", liquidityUsd: "100000", strategyInstanceId: spec.instance, createdAt: when },
    });
    await prisma.ledgerEntry.createMany({
      data: applied.lines.map((line) => ({ accountId: spec.account, type: line.type, amountUsd: line.amountUsd, affectsCash: line.affectsCash, orderId: order.id, fillId: fill.id, note: line.note, createdAt: when })),
    });
    const next = applied.state.positions.find((row) => row.pairAddress === PAIR)!;
    await prisma.position.upsert({
      where: { accountId_pairAddress: { accountId: spec.account, pairAddress: PAIR } },
      create: { accountId: spec.account, pairAddress: PAIR, baseSymbol: "A09", baseQty: next.baseQty, avgCostUsd: next.avgCostUsd, realizedPnlUsd: next.realizedPnlUsd },
      update: { baseQty: next.baseQty, avgCostUsd: next.avgCostUsd, realizedPnlUsd: next.realizedPnlUsd },
    });
  }
}

describe.skipIf(!enabled)("ASCEND-09 lot history API (DB)", () => {
  let prisma: PrismaClient;
  let service: TradeLotsService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "MarketObservation", "PaperAccount", "ProtectionOrder", "StrategyAllocation", "TradeLotSnapshot" RESTART IDENTITY CASCADE`,
    );
    for (const id of [ACCOUNT, OTHER]) {
      await prisma.paperAccount.create({ data: { id, cashUsd: "1000000", startingBalanceUsd: "1000000" } });
    }
    await book(prisma, [
      { account: ACCOUNT, side: "BUY", qty: "100", price: "1.10", minute: 0, instance: "inst_a", scope: "STRATEGY" },
      { account: ACCOUNT, side: "BUY", qty: "50", price: "1.30", minute: 1, instance: "inst_b", scope: "STRATEGY" },
      { account: ACCOUNT, side: "SELL", qty: "40", price: "1.25", minute: 2, instance: "inst_a", scope: "STRATEGY", reasons: ["EXIT_MOMENTUM"] },
      { account: ACCOUNT, side: "SELL", qty: "110", price: "1.05", minute: 3, instance: null, scope: "PROTECTION", reasons: ["STOP_LOSS"] },
      { account: ACCOUNT, side: "BUY", qty: "20", price: "1.00", minute: 4, instance: "inst_a", scope: "STRATEGY" },
      { account: OTHER, side: "BUY", qty: "999", price: "2", minute: 0, instance: "inst_z", scope: "STRATEGY" },
    ]);
    const mark = (minute: number, price: string | null, id: string) =>
      prisma.marketObservation.create({
        data: { id, ingestJobId: `job_${id}`, source: "test", chainId: "solana", pairAddress: PAIR, dexId: "x", baseAddress: "b", baseSymbol: "A09", baseName: "A09", quoteAddress: "q", quoteSymbol: "USDC", priceUsd: price, freshness: "FRESH", receivedAt: at(minute), raw: {} },
      });
    await mark(0, "1.10", "m0");
    await mark(1.5, "1.40", "m1");
    await mark(2.5, "0.95", "m2");
    await mark(3.5, "5.00", "m3"); // between lots: belongs to neither
    const terminal = { activeAccountId: async () => ACCOUNT } as unknown as TerminalService;
    service = new TradeLotsService(prisma, terminal);
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("lists the active account's lots only, newest first, with OPEN lots labelled", async () => {
    const list = await service.listLots({});
    expect(list.accountId).toBe(ACCOUNT);
    expect(list.total).toBe(2);
    expect(list.lots.map((lot) => lot.status)).toEqual(["OPEN", "CLOSED"]);
    expect(list.lots[0]!.label).toBe("OPEN");
    expect(list.lots.every((lot) => lot.accountId === ACCOUNT)).toBe(true);
    const closed = list.lots[1]!;
    expect(closed.excursion).toMatchObject({ observations: 3, highUsd: "1.40000000", lowUsd: "0.95000000" });
    // The open lot has no mark after it opened except m3 (before it): its window uses marks since minute 4 only.
    expect(list.lots[0]!.excursion.observations).toBe(0);
    expect(list.lots[0]!.excursion.mfePct).toBeNull();
    // Latest mark (m3, 5.00) exists, so the open lot is valued; it is never zero-filled.
    expect(list.lots[0]!.valuation.markUsd).toBe("5.00000000");
  });

  it("returns one lot's timeline with its events in order", async () => {
    const list = await service.listLots({ status: "CLOSED" });
    const timeline = await service.lotTimeline(list.lots[0]!.lotKey);
    expect(timeline.lot.events.map((event) => event.kind)).toEqual(["ENTRY", "ADD", "REDUCE", "EXIT"]);
    expect(timeline.lot.events[3]!.exitReason).toEqual({ code: "STOP_LOSS", source: "REASON_CODE" });
    expect(timeline.entryViewState).toBe("NOT_RECORDED_YET");
    await expect(service.lotTimeline("missing")).rejects.toThrow("LOT_NOT_FOUND");
  });

  it("reconciles attribution with the ledger exactly", async () => {
    const report = await service.attribution();
    expect(report.status).toBe("RECONCILED");
    expect(report.reconciliation.items).toEqual([]);
    expect(report.reconciliation.realizedPnl.unreconciledUsd).toBe("0.00000000");
    expect(report.reconciliation.fees.unreconciledUsd).toBe("0.00000000");
    const ledger = await prisma.ledgerEntry.aggregate({ where: { accountId: ACCOUNT, type: "REALIZED_PNL" }, _sum: { amountUsd: true } });
    expect(report.reconciliation.realizedPnl.ledgerTotalUsd).toBe(usd(d(ledger._sum.amountUsd!.toString())));
    expect(report.attribution.instancesSumToLots).toBe(true);
    expect(report.attribution.instances.map((row) => row.strategyInstanceId)).toEqual(["inst_a", "inst_b"]);
    expect(report.attribution.instances.some((row) => row.strategyInstanceId === "inst_z")).toBe(false);
  });

  it("reports a corrupted ledger as UNRECONCILED and never absorbs the difference", async () => {
    const row = await prisma.ledgerEntry.findFirstOrThrow({ where: { accountId: ACCOUNT, type: "REALIZED_PNL" } });
    await prisma.ledgerEntry.update({ where: { id: row.id }, data: { amountUsd: d(row.amountUsd.toString()).plus("1.23").toFixed(8) } });
    await prisma.ledgerEntry.create({ data: { accountId: ACCOUNT, type: "REALIZED_PNL", amountUsd: "0.5", affectsCash: false, note: "corrupt: no fill" } });
    const report = await service.attribution();
    expect(report.status).toBe("UNRECONCILED");
    expect(report.reconciliation.realizedPnl.unreconciledUsd).toBe("1.73000000");
    expect(report.reconciliation.items.map((item) => item.kind).sort()).toEqual(["FILL_AMOUNT_MISMATCH", "LEDGER_ROW_WITHOUT_FILL"]);
    // Lot totals still come from the fills, not from the corrupted rows.
    expect(report.attribution.totals.realizedPnlUsd).toBe(report.reconciliation.realizedPnl.lotsTotalUsd);
  });
});
