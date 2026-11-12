import { DEFAULT_STRATEGY, buildPositionKey, d, type ExecutionContext } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { commitProposedOrder, lockAccount } from "@odin/trading-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { retryProtectionExits } from "./protect.js";
import { settlePendingPaperOrders } from "./settle.js";

/**
 * PCR-1 regression (APEX). A pending SELL is created for one position lot. If that lot is closed by
 * another path (typically protection in the same cycle) and a new lot is opened on the same pair before
 * the SELL settles, the SELL must not reduce the new lot.
 *
 * Reachable today: entry de-duplication is per strategy instance and pair, and operator tickets may buy a
 * held pair, so a pending BUY submitted before the stale SELL settles first (settle runs in submittedAt
 * order) and reopens the pair. The existing F5 guard only cancels a SELL while the pair is flat.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const env = "MARKET_DATA_PAPER";

describe.skipIf(!enabled)("PCR-1: pending exits are fenced to their position lot", () => {
  let prisma: PrismaClient;
  const host = {
    dataMode: "live",
    buildReservationBudget: vi.fn().mockResolvedValue({}),
    armProtectionForFill: vi.fn(),
  } as unknown as Parameters<typeof settlePendingPaperOrders>[0];
  const ctx = { accountId: "primary", tradingEnvironment: env, dataMode: "live" } as unknown as ExecutionContext;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "MarketObservation", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
    );
    const config = { ...DEFAULT_STRATEGY, paperLatencyMs: 0, tradingEnvironment: env };
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING", config: toJson(config) } });
  });

  async function observation(at: Date, ingestJobId: string) {
    return prisma.marketObservation.create({
      data: {
        ingestJobId,
        source: "dexscreener",
        chainId: "solana",
        pairAddress,
        dexId: "orca",
        baseAddress: "So11111111111111111111111111111111111111112",
        baseSymbol: "SOL",
        baseName: "Wrapped SOL",
        quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        quoteSymbol: "USDC",
        priceUsd: "100",
        liquidityUsd: "1000000",
        freshness: "LIVE",
        dataOrigin: "LIVE_FEED",
        tradingEnvironment: env,
        receivedAt: at,
        eventTime: at,
        raw: {},
      },
    });
  }

  /** `lot` simulates the stamp PCR-1 adds at booking time (Order.positionLifecycleId). */
  async function pending(input: { clientOrderId: string; side: "BUY" | "SELL"; intent: string; ownerScope: string; submittedAt: Date; observationId: string; lot?: string | null; stampCum?: string | null; allocStamp?: string | null; qty?: string; eligibleAt?: Date; strategyInstanceId?: string }) {
    return prisma.order.create({
      data: {
        ...(input.allocStamp !== undefined ? { allocationBoughtQtyAtBooking: input.allocStamp } : {}),
        ...(input.lot !== undefined ? { positionLifecycleId: input.lot } : {}),
        ...(input.stampCum !== undefined ? { positionBoughtQtyAtBooking: input.stampCum } : {}),
        ...(input.strategyInstanceId ? { strategyInstanceId: input.strategyInstanceId } : {}),
        clientOrderId: input.clientOrderId,
        cycleId: "cyc_pcr1",
        accountId: "primary",
        pairAddress,
        baseSymbol: "SOL",
        side: input.side,
        intent: input.intent,
        status: "PENDING",
        qty: input.qty ?? "1",
        observationId: input.observationId,
        decisionObservationId: input.observationId,
        reasonCodes: ["ORDER_PENDING"],
        ownerScope: input.ownerScope,
        submittedAt: input.submittedAt,
        eligibleAt: input.eligibleAt ?? input.submittedAt,
        expiresAt: new Date((input.eligibleAt ?? input.submittedAt).getTime() + 60_000),
      },
    });
  }

  async function settle(now: Date) {
    return prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      return settlePendingPaperOrders(host, tx, { ctx, now });
    });
  }

  it("a stale protective NET_CLOSE does not sell a lot opened after its own lot closed", async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 10_000);
    const t1 = new Date(now.getTime() - 8_000);
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    // Lot L1 was closed by protection after the NET_CLOSE below was booked: the pair is flat.
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "0", avgCostUsd: "0", realizedPnlUsd: "0", lifecycleId: null } });
    // T0: an operator BUY on the pair, submitted while L1 was still open (allowed: operator tickets may add).
    await pending({ clientOrderId: "pcr1_buy", side: "BUY", intent: "OPERATOR", ownerScope: "OPERATOR", submittedAt: t0, observationId: decision.id });
    // T1: the planner's protective NET_CLOSE for L1, still pending when protection closed L1.
    await pending({ clientOrderId: "pcr1_stale_close", side: "SELL", intent: "EXIT", ownerScope: "NET_CLOSE", submittedAt: t1, observationId: decision.id, lot: "lot_L1" });

    await settle(now);

    const buy = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_buy" } });
    const stale = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_stale_close" } });
    const position = await prisma.position.findFirstOrThrow({ where: { accountId: "primary", pairAddress } });
    expect(buy.status).toBe("FILLED");
    // The stale exit is cancelled and the new lot (L2) is untouched.
    expect(stale.status).toBe("CANCELLED");
    expect(stale.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    expect(d(position.baseQty.toString()).toFixed(8)).toBe(d(buy.filledQty.toString()).toFixed(8));
    expect(position.lifecycleId).toBeTruthy();
    expect(position.lifecycleId).not.toBe("lot_L1");
  });

  it("control: a pending SELL for the lot that is still open settles normally", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "2", avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId: "lot_L1" } });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: { decrement: 200 } } });
    await pending({ clientOrderId: "pcr1_same_lot", side: "SELL", intent: "EXIT", ownerScope: "NET_CLOSE", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, lot: "lot_L1" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_same_lot" } });
    const position = await prisma.position.findFirstOrThrow({ where: { accountId: "primary", pairAddress } });
    expect(sell.status).toBe("FILLED");
    expect(d(position.baseQty.toString()).toFixed(8)).toBe("1.00000000");
    expect(position.lifecycleId).toBe("lot_L1");
  });

  it("flatten exits are exempt: they mean 'be flat now', whichever lot is open", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "1", avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId: "lot_L2" } });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: { decrement: 100 } } });
    await pending({ clientOrderId: "pcr1_flatten", side: "SELL", intent: "FLATTEN", ownerScope: "ACCOUNT_FLATTEN", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, lot: "lot_L1" });

    await settle(now);

    expect((await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_flatten" } })).status).toBe("FILLED");
  });

  it("legacy pending SELLs without a stamp keep today's behaviour", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "1", avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId: "lot_L2" } });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: { decrement: 100 } } });
    await pending({ clientOrderId: "pcr1_legacy", side: "SELL", intent: "EXIT", ownerScope: "NET_CLOSE", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, lot: null });

    await settle(now);

    expect((await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_legacy" } })).status).toBe("FILLED");
  });

  it("an OPERATOR reduce for a closed lot is fenced even before it is eligible", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "1", avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId: "lot_L2" } });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: { decrement: 100 } } });
    await pending({ clientOrderId: "pcr1_operator", side: "SELL", intent: "OPERATOR", ownerScope: "OPERATOR", submittedAt: new Date(now.getTime() - 8_000), eligibleAt: new Date(now.getTime() + 30_000), observationId: decision.id, lot: "lot_L1" });

    await settle(now);

    const op = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_operator" } });
    expect(op.status).toBe("CANCELLED");
    expect(op.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    expect((await prisma.position.findFirstOrThrow({ where: { accountId: "primary", pairAddress } })).baseQty.toString()).toBe("1");
    expect(await prisma.fill.count()).toBe(0);
  });

  it("a fenced STRATEGY exit releases its reserved exit quantity, clamped at zero", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "1", avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId: "lot_L2" } });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: { decrement: 100 } } });
    await prisma.strategyAllocation.create({
      data: { accountId: "primary", strategyInstanceId: "inst_x", instrumentId: pairAddress, pairAddress, lifecycleId: "lot_L1", qty: "0", avgCostUsd: "0", reservedExitQty: "0.4" },
    });
    await pending({ clientOrderId: "pcr1_strategy", side: "SELL", intent: "EXIT", ownerScope: "STRATEGY", strategyInstanceId: "inst_x", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, lot: "lot_L1" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_strategy" } });
    expect(sell.status).toBe("CANCELLED");
    expect(sell.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    const allocation = await prisma.strategyAllocation.findFirstOrThrow({ where: { strategyInstanceId: "inst_x" } });
    // The order reserved 1; only 0.4 was still held (a pro-rata close released the rest). Release clamps at 0.
    expect(allocation.reservedExitQty.toString()).toBe("0");
    expect((await prisma.position.findFirstOrThrow({ where: { accountId: "primary", pairAddress } })).baseQty.toString()).toBe("1");
  });

  it("booking stamps a pending SELL with the open lot, and a BUY with none", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 2_000), "cyc_pcr1_decision");
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: "1", avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId: "lot_L1" } });
    const eligibleAt = new Date(now.getTime() + 5_000).toISOString();
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      for (const [clientOrderId, side, intent, ownerScope] of [
        ["pcr1_book_sell", "SELL", "EXIT", "NET_CLOSE"],
        ["pcr1_book_buy", "BUY", "OPERATOR", "OPERATOR"],
      ] as const) {
        await commitProposedOrder(tx, {
          accountId: "primary",
          cycleId: "cyc_pcr1",
          order: { clientOrderId, pairAddress, baseSymbol: "SOL", side, intent, qty: "1", observationId: decision.id, reasonCodes: [], eligibleAt, ownerScope },
          config: { ...DEFAULT_STRATEGY, tradingEnvironment: env },
          mode: "live",
          now,
        });
      }
    });
    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_book_sell" } });
    const buy = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_book_buy" } });
    expect(sell.status).toBe("PENDING");
    expect((sell as unknown as { positionLifecycleId: string | null }).positionLifecycleId).toBe("lot_L1");
    expect((buy as unknown as { positionLifecycleId: string | null }).positionLifecycleId).toBeNull();
    const stampOf = (row: unknown) => (row as { positionBoughtQtyAtBooking: { toString(): string } | null }).positionBoughtQtyAtBooking?.toString() ?? null;
    expect(stampOf(sell)).toBe("0");
    expect(stampOf(buy)).toBeNull();
  });

  // ---------- OPERATION INTEGRITY F01: end to end through the patched store (real fills, no seeded counters) ----------

  /** One order through the real store, under the account lock. No eligibleAt + latency 0 fills immediately. */
  async function commit(clientOrderId: string, side: "BUY" | "SELL", qty: string, observationId: string, now: Date, over: { intent?: string; ownerScope?: string; eligibleAt?: string } = {}) {
    return prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      return commitProposedOrder(tx, {
        accountId: "primary",
        cycleId: "cyc_pcr1_e2e",
        order: { clientOrderId, pairAddress, baseSymbol: "SOL", side, intent: over.intent ?? "OPERATOR", qty, observationId, reasonCodes: [], ownerScope: over.ownerScope ?? "OPERATOR", ...(over.eligibleAt ? { eligibleAt: over.eligibleAt } : {}) },
        config: { ...DEFAULT_STRATEGY, paperLatencyMs: 0, tradingEnvironment: env },
        mode: "live",
        now,
      });
    });
  }
  const cumOf = (row: unknown) => d((row as { cumBoughtQty: { toString(): string } }).cumBoughtQty.toString());
  const stampOfRow = (row: unknown) => (row as { positionBoughtQtyAtBooking: { toString(): string } | null }).positionBoughtQtyAtBooking?.toString() ?? null;

  it("e2e: flat then reopen through real fills — the stale exit is cancelled and the new lot is untouched", async () => {
    const now = new Date();
    const obs = await observation(new Date(now.getTime() - 500), "cyc_pcr1_e2e");
    const later = new Date(now.getTime() + 10_000);
    await commit("e2e_buy_1", "BUY", "1", obs.id, now);
    const opened = await positionNow();
    const firstLot = opened.lifecycleId;
    const bought1 = d(opened.baseQty.toString());
    expect(bought1.gt(0)).toBe(true);
    expect(cumOf(opened).toFixed(8)).toBe(bought1.toFixed(8));

    // A pending exit for the whole first lot, booked now and eligible later.
    await commit("e2e_stale_exit", "SELL", bought1.toFixed(8), obs.id, now, { intent: "EXIT", ownerScope: "NET_CLOSE", eligibleAt: later.toISOString() });
    const booked = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "e2e_stale_exit" } });
    expect(booked.status).toBe("PENDING");
    expect((booked as unknown as { positionLifecycleId: string | null }).positionLifecycleId).toBe(firstLot);
    expect(d(stampOfRow(booked)!).toFixed(8)).toBe(bought1.toFixed(8));

    // Another path closes the lot, then a new BUY reopens the pair.
    await commit("e2e_close", "SELL", bought1.toFixed(8), obs.id, now);
    expect(d((await positionNow()).baseQty.toString()).toFixed(8)).toBe("0.00000000");
    expect(cumOf(await positionNow()).toFixed(8)).toBe(bought1.toFixed(8)); // SELL fills never move the counter
    await commit("e2e_buy_2", "BUY", "1", obs.id, now);
    const reopened = await positionNow();
    const bought2 = d(reopened.baseQty.toString());
    expect(reopened.lifecycleId).not.toBe(firstLot);
    expect(cumOf(reopened).toFixed(8)).toBe(bought1.plus(bought2).toFixed(8));

    await observation(new Date(later.getTime() + 100), "cyc_pcr1_e2e_late");
    await settle(new Date(later.getTime() + 1_000));
    const stale = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "e2e_stale_exit" } });
    expect(stale.status).toBe("CANCELLED");
    expect(stale.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    expect(d((await positionNow()).baseQty.toString()).toFixed(8)).toBe(bought2.toFixed(8));
  });

  it("e2e: reduce then add within one lot through real fills — the old exit sells only surviving booked units", async () => {
    const now = new Date();
    const obs = await observation(new Date(now.getTime() - 500), "cyc_pcr1_e2e");
    const later = new Date(now.getTime() + 10_000);
    await commit("e2e_rb_buy", "BUY", "2", obs.id, now);
    const held = d((await positionNow()).baseQty.toString());
    const lot = (await positionNow()).lifecycleId;
    await commit("e2e_rb_exit", "SELL", held.toFixed(8), obs.id, now, { intent: "EXIT", ownerScope: "NET_CLOSE", eligibleAt: later.toISOString() });
    const half = held.div(2);
    await commit("e2e_rb_reduce", "SELL", half.toFixed(8), obs.id, now);
    await commit("e2e_rb_add", "BUY", "1", obs.id, now);
    const afterAdd = await positionNow();
    expect(afterAdd.lifecycleId).toBe(lot); // same lot id: a lot-id fence alone would not notice
    const added = d(afterAdd.baseQty.toString()).minus(held.minus(half));

    await observation(new Date(later.getTime() + 100), "cyc_pcr1_e2e_late");
    await settle(new Date(later.getTime() + 1_000));
    const exit = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "e2e_rb_exit" } });
    expect(exit.reasonCodes).toContain("EXIT_CAPPED_TO_BOOKED_LOT");
    expect(d(exit.qty.toString()).toFixed(8)).toBe(held.minus(half).toFixed(8));
    expect(exit.status).toBe("FILLED");
    // Exactly the units bought after booking remain.
    expect(d((await positionNow()).baseQty.toString()).toFixed(8)).toBe(added.toFixed(8));
  });

  // ---------- v2: the monotonic cumBoughtQty counter (F-PCR1-b) ----------
  // Positions are seeded in the state the stamping patch produces (counter incremented by every BUY fill).

  async function openPosition(qty: string, cumBoughtQty: string, lifecycleId: string | null) {
    await prisma.position.create({ data: { accountId: "primary", pairAddress, baseSymbol: "SOL", baseQty: qty, avgCostUsd: "100", realizedPnlUsd: "0", lifecycleId, cumBoughtQty } });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: { decrement: d(qty).mul(100).toNumber() } } });
  }
  const positionNow = () => prisma.position.findFirstOrThrow({ where: { accountId: "primary", pairAddress } });

  it("reduced then increased within the same lot: an old exit sells only the surviving booked units", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    // Booked to sell 2 when 2 were held (cum 2). Then another exit sold 1 and an add bought 1: qty 2, cum 3, same lot.
    await openPosition("2", "3", "lot_L1");
    await pending({ clientOrderId: "pcr1_v2_cap", side: "SELL", intent: "EXIT", ownerScope: "NET_CLOSE", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "2", lot: "lot_L1", stampCum: "2" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v2_cap" } });
    expect(sell.status).toBe("FILLED");
    expect(sell.reasonCodes).toContain("EXIT_CAPPED_TO_BOOKED_LOT");
    expect(sell.filledQty.toString()).toBe("1");
    // The unit bought after booking is still held.
    expect((await positionNow()).baseQty.toString()).toBe("1");
  });

  it("two exits from one booking cannot together sell more than the surviving booked units", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    // Both booked at qty 2 / cum 2; then 1 was sold elsewhere and 1 bought: qty 2, cum 3. One booked unit survives.
    await openPosition("2", "3", "lot_L1");
    await pending({ clientOrderId: "pcr1_v2_a", side: "SELL", intent: "OPERATOR", ownerScope: "OPERATOR", submittedAt: new Date(now.getTime() - 9_000), observationId: decision.id, qty: "1", lot: "lot_L1", stampCum: "2" });
    await pending({ clientOrderId: "pcr1_v2_b", side: "SELL", intent: "OPERATOR", ownerScope: "OPERATOR", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "1", lot: "lot_L1", stampCum: "2" });

    await settle(now);

    const a = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v2_a" } });
    const b = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v2_b" } });
    expect(a.status).toBe("FILLED");
    expect(b.status).toBe("CANCELLED");
    expect(b.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    expect((await positionNow()).baseQty.toString()).toBe("1");
  });

  it("a capped STRATEGY exit releases only the excess reserved quantity", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await openPosition("2", "3", "lot_L1");
    await prisma.strategyAllocation.create({ data: { accountId: "primary", strategyInstanceId: "inst_x", instrumentId: pairAddress, pairAddress, lifecycleId: "lot_L1", qty: "2", avgCostUsd: "100", reservedExitQty: "2" } });
    // Not yet eligible: the cap is applied and persisted before any fill.
    await pending({ clientOrderId: "pcr1_v2_strat", side: "SELL", intent: "EXIT", ownerScope: "STRATEGY", strategyInstanceId: "inst_x", submittedAt: new Date(now.getTime() - 8_000), eligibleAt: new Date(now.getTime() + 30_000), observationId: decision.id, qty: "2", lot: "lot_L1", stampCum: "2" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v2_strat" } });
    expect(sell.status).toBe("PENDING");
    expect(sell.qty.toString()).toBe("1");
    const allocation = await prisma.strategyAllocation.findFirstOrThrow({ where: { strategyInstanceId: "inst_x" } });
    expect(allocation.reservedExitQty.toString()).toBe("1");
  });

  it("concurrent settle transactions release a fenced exit's reservation exactly once", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await openPosition("1", "5", "lot_L2");
    // 1.5 reserved: 1 for the stale exit, 0.5 for another in-flight exit. A double release would leave 0.
    await prisma.strategyAllocation.create({ data: { accountId: "primary", strategyInstanceId: "inst_x", instrumentId: pairAddress, pairAddress, lifecycleId: "lot_L2", qty: "1", avgCostUsd: "100", reservedExitQty: "1.5" } });
    await pending({ clientOrderId: "pcr1_v2_race", side: "SELL", intent: "EXIT", ownerScope: "STRATEGY", strategyInstanceId: "inst_x", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "1", lot: "lot_L1", stampCum: "1" });

    const second = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const settleWith = (client: PrismaClient) =>
        client.$transaction(async (tx) => {
          await lockAccount(tx, "primary");
          return settlePendingPaperOrders(host, tx, { ctx, now });
        });
      await Promise.all([settleWith(prisma), settleWith(second)]);
    } finally {
      await second.$disconnect();
    }

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v2_race" } });
    expect(sell.status).toBe("CANCELLED");
    const allocation = await prisma.strategyAllocation.findFirstOrThrow({ where: { strategyInstanceId: "inst_x" } });
    expect(allocation.reservedExitQty.toString()).toBe("0.5");
    expect((await positionNow()).baseQty.toString()).toBe("1");
  });

  it("worker recovery: re-running settle from a fresh client after a restart is idempotent", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await openPosition("1", "2", "lot_L2");
    await pending({ clientOrderId: "pcr1_v2_recover", side: "SELL", intent: "EXIT", ownerScope: "NET_CLOSE", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "1", lot: "lot_L1", stampCum: "1" });

    await settle(now);
    const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      await restarted.$transaction(async (tx) => {
        await lockAccount(tx, "primary");
        await settlePendingPaperOrders(host, tx, { ctx, now: new Date(now.getTime() + 20_000) });
      });
    } finally {
      await restarted.$disconnect();
    }

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v2_recover" } });
    expect(sell.status).toBe("CANCELLED");
    expect(sell.reasonCodes.filter((code) => code === "EXIT_LIFECYCLE_MISMATCH")).toHaveLength(1);
    expect(await prisma.fill.count()).toBe(0);
    expect((await positionNow()).baseQty.toString()).toBe("1");
  });

  // ---------- v3: STRATEGY exits fenced per owner (review MEDIUM) ----------

  async function allocation(instance: string, qty: string, cumBoughtQty: string, reservedExitQty = "0") {
    await prisma.strategyAllocation.create({ data: { accountId: "primary", strategyInstanceId: instance, instrumentId: pairAddress, pairAddress, lifecycleId: "lot_L1", qty, avgCostUsd: "100", reservedExitQty, cumBoughtQty } });
  }

  it("another owner's buys and sells do not cancel an owner's STRATEGY exit", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    // A held 1, B held 1 (pair cum 2). B booked an exit for 1 (B cum 1). Then A bought 5 and sold 6:
    // pair qty 1, cum 7; B's allocation untouched (qty 1, cum 1). Pair-level FIFO alone would cancel B.
    await openPosition("1", "7", "lot_L1");
    await allocation("inst_a", "0", "6");
    await allocation("inst_b", "1", "1", "1");
    await pending({ clientOrderId: "pcr1_v3_owner_b", side: "SELL", intent: "EXIT", ownerScope: "STRATEGY", strategyInstanceId: "inst_b", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "1", lot: "lot_L1", stampCum: "2", allocStamp: "1" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v3_owner_b" } });
    expect(sell.status).toBe("FILLED");
    expect(sell.reasonCodes).not.toContain("EXIT_LIFECYCLE_MISMATCH");
    expect((await positionNow()).baseQty.toString()).toBe("0");
  });

  it("an owner's own re-buy after a pro-rata reduction is not sold by its old STRATEGY exit", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    // A booked 1 when it held 1 (A cum 1). A net close sold A's unit pro rata; A re-entered with 1 (A cum 2).
    // B still holds 1, so the lot id never changed: only the owner counter shows the unit is new.
    await openPosition("2", "3", "lot_L1");
    await allocation("inst_a", "1", "2");
    await allocation("inst_b", "1", "1");
    await pending({ clientOrderId: "pcr1_v3_rebuy", side: "SELL", intent: "EXIT", ownerScope: "STRATEGY", strategyInstanceId: "inst_a", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "1", lot: "lot_L1", stampCum: "2", allocStamp: "1" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v3_rebuy" } });
    expect(sell.status).toBe("CANCELLED");
    expect(sell.rejectReason).toBe("EXIT_LIFECYCLE_MISMATCH");
    expect((await positionNow()).baseQty.toString()).toBe("2");
  });

  it("CAP then expiry releases exactly the original reservation in total (an extra reservation exposes double release)", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await openPosition("2", "3", "lot_L1");
    // Owner holds 2; booked 2 at owner cum 2; owner since sold 1 and bought 1 (owner qty 2, cum 3). Reserved:
    // 2 for this exit plus 0.5 for another in-flight exit, which must survive.
    await allocation("inst_x", "2", "3", "2.5");
    await pending({ clientOrderId: "pcr1_v3_cap_expire", side: "SELL", intent: "EXIT", ownerScope: "STRATEGY", strategyInstanceId: "inst_x", submittedAt: new Date(now.getTime() - 8_000), eligibleAt: new Date(now.getTime() + 30_000), observationId: decision.id, qty: "2", lot: "lot_L1", stampCum: "2", allocStamp: "2" });

    await settle(now);
    const capped = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v3_cap_expire" } });
    expect(capped.qty.toString()).toBe("1");
    expect((await prisma.strategyAllocation.findFirstOrThrow({ where: { strategyInstanceId: "inst_x" } })).reservedExitQty.toString()).toBe("1.5");

    // Past expiry (eligible + 60 s): the store expires the capped order and releases only its capped qty.
    await settle(new Date(now.getTime() + 120_000));
    const expired = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v3_cap_expire" } });
    expect(expired.status).toBe("EXPIRED");
    expect((await prisma.strategyAllocation.findFirstOrThrow({ where: { strategyInstanceId: "inst_x" } })).reservedExitQty.toString()).toBe("0.5");
  });

  it("an oversized flatten after a partial reduction is capped to the position and fills", async () => {
    const now = new Date();
    const decision = await observation(new Date(now.getTime() - 12_000), "cyc_pcr1_decision");
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await openPosition("1", "3", "lot_L1");
    await pending({ clientOrderId: "pcr1_v3_flatten", side: "SELL", intent: "FLATTEN", ownerScope: "ACCOUNT_FLATTEN", submittedAt: new Date(now.getTime() - 8_000), observationId: decision.id, qty: "3", lot: "lot_L1", stampCum: "3" });

    await settle(now);

    const sell = await prisma.order.findUniqueOrThrow({ where: { clientOrderId: "pcr1_v3_flatten" } });
    expect(sell.status).toBe("FILLED");
    expect(sell.reasonCodes).toContain("EXIT_CAPPED_TO_POSITION");
    expect((await positionNow()).baseQty.toString()).toBe("0");
  });

  // ---------- F-PCR1-a: protection retry decides under the account lock ----------

  it("a protection retry racing a close-and-reopen never sells the new lot", async () => {
    const now = new Date();
    await observation(new Date(now.getTime() - 1_000), "cyc_pcr1");
    await openPosition("1", "1", "lot_L1");
    const groupId = `oco_primary_${pairAddress}_lot_L1`;
    const leg = await prisma.protectionOrder.create({
      data: { accountId: "primary", positionKey: buildPositionKey("primary", pairAddress), ocoGroupId: groupId, lifecycleId: "lot_L1", kind: "STOP", origin: "SYNTHETIC_ENGINE", protectedQty: "1", remainingQty: "1", triggerPriceUsd: "97", status: "TRIGGERED" },
    });
    await prisma.protectionIntent.create({
      data: { accountId: "primary", ocoGroupId: groupId, legId: leg.id, status: "UNRESOLVED", reason: "EXIT_FAILED", kind: "EXIT_RETRY", lifecycleId: "lot_L1", retryAfter: new Date(now.getTime() - 1_000) },
    });

    // Another transaction holds the account lock and replaces lot L1 with a new lot L2 (close + reopen).
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const reopen = other.$transaction(
        async (tx) => {
          await lockAccount(tx, "primary");
          locked();
          await new Promise((resolve) => setTimeout(resolve, 600));
          await tx.position.update({ where: { accountId_pairAddress: { accountId: "primary", pairAddress } }, data: { lifecycleId: "lot_L2", cumBoughtQty: "2" } });
        },
        { timeout: 10_000 },
      );
      await lockHeld;
      // The retry starts while the lock is held; it must not act on what it saw before acquiring it.
      await Promise.all([reopen, retryProtectionExits(prisma, { ctx, now })]);
    } finally {
      await other.$disconnect();
    }

    const sells = await prisma.order.findMany({ where: { side: "SELL", status: "FILLED" } });
    expect(sells).toHaveLength(0);
    const position = await positionNow();
    expect(position.lifecycleId).toBe("lot_L2");
    expect(position.baseQty.toString()).toBe("1");
    const intent = await prisma.protectionIntent.findFirstOrThrow({ where: { legId: leg.id } });
    expect(intent.status).toBe("RESOLVED");
  });
});
