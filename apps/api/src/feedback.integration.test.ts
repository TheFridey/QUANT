/**
 * GENESIS Phase 7 feedback API against a real database. Runs only when DATABASE_URL_TEST names an
 * *odin_test* database. Fills and ledger rows are booked with the real paper ledger arithmetic, an ENTRY
 * snapshot is stored for one lot as the ASCEND-09 writer would, and rejected funnel events feed the
 * hypothetical endpoint. The service must stay scoped to the active account, separate decision-time
 * data from hindsight, keep hypotheticals apart from fills, bound its limits, and write nothing.
 */
import { entryView, viewHash, type PointInTimeView } from "@odin/analytics";
import { d, INTEGRATION_TEST_ADVISORY_LOCK, usd } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import { applyFill, type BookState } from "@odin/trading-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEEDBACK_SUMMARY_MAX_LIMIT, FeedbackService } from "./feedback.service.js";
import type { TerminalService } from "./terminal.service.js";
import { TradeLotsService } from "./trade-lots.service.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const ACCOUNT = "acct_g7_api";
const OTHER = "acct_g7_other";
const PAIR = "pairG7";
const base = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minute: number) => new Date(base + minute * 60_000);

type Spec = { account: string; side: "BUY" | "SELL"; qty: string; price: string; minute: number; reasons?: string[] };

async function book(prisma: PrismaClient, specs: Spec[]) {
  const books = new Map<string, BookState>();
  const fills: Array<{ id: string; orderId: string; cycleId: string; spec: Spec; notional: string; fee: string }> = [];
  let n = 0;
  for (const spec of specs) {
    n += 1;
    const state = books.get(spec.account) ?? { cashUsd: "1000000.00000000", positions: [] };
    const notional = usd(d(spec.qty).mul(spec.price));
    const fee = usd(d(notional).mul("0.003"));
    const applied = applyFill(state, { pairAddress: PAIR, baseSymbol: "G7", side: spec.side, fill: { qty: spec.qty, priceUsd: spec.price, notionalUsd: notional, feeUsd: fee } as never });
    if (!applied.ok) throw new Error(applied.reason);
    books.set(spec.account, applied.state);
    const when = at(spec.minute);
    const cycleId = `cyc_g7_${spec.account}_${n}`;
    const order = await prisma.order.create({
      data: {
        clientOrderId: `coid_g7_${spec.account}_${n}`,
        cycleId,
        accountId: spec.account,
        pairAddress: PAIR,
        baseSymbol: "G7",
        side: spec.side,
        intent: spec.side === "BUY" ? "ENTRY" : "EXIT",
        status: "FILLED",
        qty: spec.qty,
        filledQty: spec.qty,
        reasonCodes: spec.reasons ?? [],
        strategyInstanceId: "inst_g7",
        strategyVersion: "g7-1",
        ownerScope: "STRATEGY",
        createdAt: when,
      },
    });
    const fill = await prisma.fill.create({
      data: { orderId: order.id, pairAddress: PAIR, side: spec.side, qty: spec.qty, priceUsd: spec.price, notionalUsd: notional, feeUsd: fee, slippageBps: "20", liquidityUsd: "2000000", strategyInstanceId: "inst_g7", createdAt: when },
    });
    await prisma.ledgerEntry.createMany({
      data: applied.lines.map((line) => ({ accountId: spec.account, type: line.type, amountUsd: line.amountUsd, affectsCash: line.affectsCash, orderId: order.id, fillId: fill.id, note: line.note, createdAt: when })),
    });
    const next = applied.state.positions.find((row) => row.pairAddress === PAIR)!;
    await prisma.position.upsert({
      where: { accountId_pairAddress: { accountId: spec.account, pairAddress: PAIR } },
      create: { accountId: spec.account, pairAddress: PAIR, baseSymbol: "G7", baseQty: next.baseQty, avgCostUsd: next.avgCostUsd, realizedPnlUsd: next.realizedPnlUsd },
      update: { baseQty: next.baseQty, avgCostUsd: next.avgCostUsd, realizedPnlUsd: next.realizedPnlUsd },
    });
    fills.push({ id: fill.id, orderId: order.id, cycleId, spec, notional, fee });
  }
  return fills;
}

const TABLES = ["Fill", "LedgerEntry", "Order", "Position", "TradeLotSnapshot", "OpportunityFunnelEvent", "MarketObservation", "StrategyAllocation", "PaperAccount"] as const;

async function rowHashes(prisma: PrismaClient) {
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ h: string | null; c: bigint }>>(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS c FROM "${table}" t`);
    out[table] = `${rows[0]!.c}:${rows[0]!.h}`;
  }
  return out;
}

describe.skipIf(!enabled)("GENESIS feedback API (DB)", () => {
  let prisma: PrismaClient;
  let service: FeedbackService;
  let stopLotKey = "";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    // TradeLotSnapshot cannot be truncated (append-only); fixtures use generated fill ids so stale rows never match.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "MarketObservation", "PaperAccount", "ProtectionOrder", "StrategyAllocation", "OpportunityFunnelEvent" RESTART IDENTITY CASCADE`,
    );
    for (const id of [ACCOUNT, OTHER]) await prisma.paperAccount.create({ data: { id, cashUsd: "1000000", startingBalanceUsd: "1000000" } });
    const fills = await book(prisma, [
      { account: ACCOUNT, side: "BUY", qty: "100", price: "1.00", minute: 0 },
      { account: ACCOUNT, side: "SELL", qty: "100", price: "0.95", minute: 30, reasons: ["STOP_LOSS"] },
      { account: ACCOUNT, side: "BUY", qty: "100", price: "1.00", minute: 60 },
      { account: ACCOUNT, side: "SELL", qty: "100", price: "1.10", minute: 90, reasons: ["TAKE_PROFIT"] },
      { account: ACCOUNT, side: "BUY", qty: "10", price: "1.00", minute: 120 },
      { account: OTHER, side: "BUY", qty: "999", price: "2", minute: 0 },
      { account: OTHER, side: "SELL", qty: "999", price: "1", minute: 5, reasons: ["STOP_LOSS"] },
    ]);
    const observation = (minute: number, price: string, id: string, extra: Record<string, unknown> = {}) =>
      prisma.marketObservation.create({
        data: { id, ingestJobId: `job_${id}`, source: "test", chainId: "solana", pairAddress: PAIR, dexId: "x", baseAddress: "b", baseSymbol: "G7", baseName: "G7", quoteAddress: "q", quoteSymbol: "USDC", priceUsd: price, freshness: "FRESH", receivedAt: at(minute), raw: {}, ...extra },
      });
    await observation(-0.5, "1.00", "g7_dec", { liquidityUsd: "2000000", priceChangeM5: "2", priceChangeH1: "1" });
    await observation(5, "1.001", "g7_m5");
    await observation(20, "0.96", "g7_m20");
    await observation(45, "1.02", "g7_m45"); // after lot 1's stop exit: post-exit only
    await observation(70, "1.08", "g7_m70");
    await observation(99, "1.00", "g7_m99"); // pre-decision feature for the rejection at minute 100
    await observation(110, "1.06", "g7_m110"); // hits the 5 % take-profit for the hypothetical

    // ENTRY snapshot for lot 1, built and hashed as the ASCEND-09 writer does.
    const entry = fills[0]!;
    const view: PointInTimeView = entryView({
      accountId: ACCOUNT,
      entryFillId: entry.id,
      openedAt: at(0).toISOString(),
      fill: { id: entry.id, orderId: entry.orderId, pairAddress: PAIR, side: "BUY", qty: "100", priceUsd: "1.00", notionalUsd: entry.notional, feeUsd: entry.fee, feeKnown: true, slippageBps: "20", liquidityUsd: "2000000", source: "LOCAL_SIM", createdAt: at(0).toISOString(), observationId: null },
      order: { id: entry.orderId, clientOrderId: `coid_g7_${ACCOUNT}_1`, cycleId: entry.cycleId, intent: "ENTRY", ownerScope: "STRATEGY", reasonCodes: [], strategyInstanceId: "inst_g7", strategyVersion: "g7-1", executionMode: "PAPER", venue: "PAPER", createdAt: at(-0.1).toISOString(), decisionObservationId: "g7_dec", observationId: "g7_dec", fillObservationId: null },
      positionQtyBefore: "0.00000000",
      positionQtyAfter: "100.00000000",
      realizedPnlUsd: null,
      observations: [
        { id: "g7_dec", pairAddress: PAIR, receivedAt: at(-0.5).toISOString(), eventTime: null, freshness: "FRESH", dataOrigin: null, priceUsd: "1.00", liquidityUsd: "2000000", volume24hUsd: null, priceChangeM5: "2", priceChangeH1: "1", pairCreatedAt: null },
      ],
      decisions: [],
      plan: { plannedAt: at(-0.3).toISOString(), orders: [{ clientOrderId: `coid_g7_${ACCOUNT}_1`, qty: "100", estimatedCostUsd: "100.30000000", estimatedNotionalUsd: "100.00000000" }] },
      configRevisions: [],
      cycle: null,
      strategyInstance: null,
    });
    await prisma.tradeLotSnapshot.create({
      data: { accountId: ACCOUNT, pairAddress: PAIR, entryFillId: entry.id, fillId: entry.id, phase: "ENTRY", eventKind: "ENTRY", asOf: at(0), strategyInstanceId: "inst_g7", strategyVersion: "g7-1", view: view as never, viewHash: viewHash(view), builderVersion: view.builderVersion },
    });
    stopLotKey = entry.id;

    await prisma.opportunityFunnelEvent.createMany({
      data: [
        { accountId: ACCOUNT, cycleId: "cyc_g7_r", pairAddress: PAIR, stage: "REJECTED", reasonCodes: ["RISK_LIMIT"], createdAt: at(100) },
        { accountId: ACCOUNT, cycleId: "cyc_g7_r", pairAddress: PAIR, stage: "FILLED", reasonCodes: [], createdAt: at(100) },
        { accountId: OTHER, cycleId: "cyc_g7_o", pairAddress: PAIR, stage: "REJECTED", reasonCodes: [], createdAt: at(100) },
        // Latest pre-decision observation is g7_m110, 90 minutes old: stale.
        { accountId: ACCOUNT, cycleId: "cyc_g7_s", pairAddress: PAIR, stage: "DROPPED", reasonCodes: [], createdAt: at(200) },
      ],
    });

    const terminal = { activeAccountId: async () => ACCOUNT } as unknown as TerminalService;
    service = new FeedbackService(prisma, terminal, new TradeLotsService(prisma, terminal));
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("summarises the active account's closed lots only, observed fills only", async () => {
    const summary = await service.summary({});
    expect(summary).toMatchObject({ accountId: ACCOUNT, source: "OBSERVED_FILL", closedLotsTotal: 2, lotsEvaluated: 2, openLotsExcluded: 1, truncated: false });
    expect(summary.aggregate.lots).toEqual({ closed: 2, open: 0, withDecisionRecord: 1, withoutDecisionRecord: 1 });
    expect(summary.aggregate.classifications).toMatchObject({ NO_ERROR: 1, EXIT_TIMING: 1 });
    const ledger = await prisma.ledgerEntry.aggregate({ where: { accountId: ACCOUNT, type: "REALIZED_PNL" }, _sum: { amountUsd: true } });
    expect(summary.aggregate.totals.netPnlUsd).toBe(usd(d(ledger._sum.amountUsd!.toString())));
    expect(summary.aggregate.dimensions.exitReason.map((bucket) => bucket.key).sort()).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    expect(summary.aggregate.dimensions.instrument[0]).toMatchObject({ key: PAIR, count: 2, smallSample: true });
  });

  it("bounds the summary limit", async () => {
    const one = await service.summary({ limit: "1" });
    expect(one).toMatchObject({ limit: 1, lotsEvaluated: 1, truncated: true, order: "CLOSED_AT_DESC" });
    expect(one.lots[0]!.primary).toBe("NO_ERROR"); // newest closed lot first
    expect((await service.summary({ limit: "999999" })).limit).toBe(FEEDBACK_SUMMARY_MAX_LIMIT);
  });

  it("explains one lot: stored entry knowledge vs retrospective outcome, with hindsight kept apart", async () => {
    const lot = await service.lot(stopLotKey);
    expect(lot.decisionRecordState).toBe("RECORDED");
    const record = lot.decisionRecord!;
    expect(record.asOf).toBe(at(0).toISOString());
    expect(record.buckets).toEqual({ regime: "RANGE", volatility: "MEDIUM", liquidity: "HIGH" });
    expect(record.expected.feeBasis).toBe("PLAN_COST_MINUS_NOTIONAL");
    const stamps = JSON.stringify(record).match(/\d{4}-\d{2}-\d{2}T[^"]+Z/g) ?? [];
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) expect(Date.parse(stamp)).toBeLessThanOrEqual(Date.parse(record.asOf));
    const retro = lot.retrospective!;
    expect(retro.inTrade.observations).toBe(2); // minutes 5 and 20; the minute-45 mark is after the exit
    expect(retro.postExit).toMatchObject({ basis: "POST_EXIT_HINDSIGHT", recoveredToEntry: true, firstRecoveryAt: at(45).toISOString() });
    expect(retro.classification.primary).toBe("EXIT_TIMING");
    expect(retro.classification.matched.find((m) => m.class === "EXIT_TIMING")).toMatchObject({ dataBasis: "POST_EXIT" });
    await expect(service.lot("missing")).rejects.toThrow("LOT_NOT_FOUND");
  });

  it("returns hypothetical outcomes for this account's rejections only, labelled HYPOTHETICAL", async () => {
    const report = await service.hypothetical({});
    expect(report).toMatchObject({ accountId: ACCOUNT, source: "HYPOTHETICAL", byStatus: { EVALUATED: 1, "NOT_EVALUATED:STALE_PRE_DECISION_PRICE": 1 } });
    expect(report.outcomes).toHaveLength(2);
    const [stale, outcome] = report.outcomes;
    expect(stale).toMatchObject({ status: "NOT_EVALUATED", notEvaluatedReason: "STALE_PRE_DECISION_PRICE" });
    expect(stale!.decisionRecord.features!.observationId).toBe("g7_m110");
    expect(outcome).toMatchObject({ source: "HYPOTHETICAL", labelOrigin: "MARKET_BARS", derivedFromOwnPrediction: false, status: "EVALUATED" });
    expect(outcome!.decisionRecord.features!.observationId).toBe("g7_m99");
    expect(outcome!.retrospective.exit).toMatchObject({ reason: "TAKE_PROFIT", priceUsd: "1.06000000" });
    expect((await service.hypothetical({ limit: "0" })).limit).toBe(1);
  });

  it("writes nothing", async () => {
    const before = await rowHashes(prisma);
    await service.summary({});
    await service.lot(stopLotKey);
    await service.hypothetical({});
    expect(await rowHashes(prisma)).toEqual(before);
  });
});
