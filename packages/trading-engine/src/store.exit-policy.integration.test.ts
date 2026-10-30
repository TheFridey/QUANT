import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, d, newId, type StrategyConfig } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import { commitProposedOrder, lockAccount, settlePendingOrder, type CommitOrder } from "./store.js";

/**
 * Audit B1 (C3) and B3 (H2) against a real database:
 * - a protective exit is never rejected for impact; above maxExitImpactBps the rest becomes a pending reduce order;
 * - DELAYED quotes never open risk on either fill path; DEMO entries need the flag AND DATA_MODE=demo.
 */

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const accountId = "primary:exit-policy-b1";
const pairAddress = "B1exitPo1icyPair1111111111111111111111111111";
const baseObservation = {
  source: "dexscreener",
  chainId: "solana",
  pairAddress,
  dexId: "orca",
  baseAddress: "So11111111111111111111111111111111111111112",
  baseSymbol: "SOL",
  baseName: "Wrapped SOL",
  quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteSymbol: "USDC",
  dataOrigin: "LIVE_FEED",
  tradingEnvironment: "MARKET_DATA_PAPER",
  raw: {},
};

describe.skipIf(!enabled)("exit execution policy and entry freshness (audit B1, B3)", () => {
  let prisma: PrismaClient;

  async function reset(cashUsd = "100000") {
    await prisma.fill.deleteMany({ where: { order: { accountId } } });
    await prisma.ledgerEntry.deleteMany({ where: { accountId } });
    await prisma.order.deleteMany({ where: { accountId } });
    await prisma.position.deleteMany({ where: { accountId } });
    await prisma.marketObservation.deleteMany({ where: { pairAddress } });
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: { id: accountId, cashUsd, startingBalanceUsd: cashUsd, tradingEnvironment: "MARKET_DATA_PAPER" },
      update: { cashUsd },
    });
  }

  async function observation(at: Date, input: { priceUsd: string; liquidityUsd: string; freshness?: string; ingestJobId?: string }) {
    return prisma.marketObservation.create({
      data: {
        ...baseObservation,
        ingestJobId: input.ingestJobId ?? newId("cyc"),
        priceUsd: input.priceUsd,
        liquidityUsd: input.liquidityUsd,
        freshness: input.freshness ?? "LIVE",
        receivedAt: at,
        eventTime: at,
      },
    });
  }

  async function seedPosition(baseQty: string) {
    await prisma.position.create({
      data: { accountId, pairAddress, baseSymbol: "SOL", baseQty, avgCostUsd: "1", realizedPnlUsd: "0" },
    });
  }

  async function commit(order: Partial<CommitOrder> & Pick<CommitOrder, "side" | "intent" | "qty" | "observationId">, config: StrategyConfig, now: Date, mode: "live" | "demo" = "live") {
    return prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId);
      return commitProposedOrder(tx, {
        accountId,
        cycleId: newId("cyc"),
        order: { clientOrderId: newId("ord"), pairAddress, baseSymbol: "SOL", reasonCodes: ["ORDER_PROPOSED"], ...order },
        config,
        mode,
        now,
      });
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641121)`;
  });

  afterAll(async () => {
    await reset();
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641121)`;
    await prisma.$disconnect();
  });

  it("fills a stop-loss exit after liquidity halves instead of rejecting it (audit probe)", async () => {
    await reset();
    await seedPosition("1000");
    const now = new Date("2026-10-30T10:00:00.000Z");
    const halved = await observation(now, { priceUsd: "1", liquidityUsd: "50000" });
    const result = await commit({ side: "SELL", intent: "EXIT", qty: "1000", observationId: halved.id }, DEFAULT_STRATEGY, now);
    expect(result.status).toBe("FILLED");
    const fill = await prisma.fill.findFirstOrThrow({ where: { order: { accountId }, side: "SELL" } });
    expect(d(fill.qty.toString()).toFixed(8)).toBe("1000.00000000");
    expect(d(fill.priceUsd.toString()).lt(1)).toBe(true);
    // Realised slippage is recorded and is above the 150 bps entry cap that used to reject this exit.
    expect(d(fill.slippageBps.toString()).gt(150)).toBe(true);
    const position = await prisma.position.findUniqueOrThrow({ where: { accountId_pairAddress: { accountId, pairAddress } } });
    expect(d(position.baseQty.toString()).toFixed(8)).toBe("0.00000000");
  });

  it("still rejects a BUY at the same impact", async () => {
    await reset();
    const now = new Date("2026-10-30T10:05:00.000Z");
    const halved = await observation(now, { priceUsd: "1", liquidityUsd: "50000" });
    const result = await commit({ side: "BUY", intent: "ENTRY", qty: "1000", observationId: halved.id }, DEFAULT_STRATEGY, now);
    expect(result.status).toBe("REJECTED");
    expect(["SLIPPAGE_LIMIT", "PRICE_IMPACT_LIMIT"]).toContain(result.reason);
  });

  it("partially fills a large exit, books the remainder as a pending reduce order, and closes it on retries", async () => {
    await reset();
    await seedPosition("20000");
    let now = new Date("2026-10-30T10:10:00.000Z");
    const first = await observation(now, { priceUsd: "1", liquidityUsd: "50000" });
    const committed = await commit({ side: "SELL", intent: "FLATTEN", qty: "20000", observationId: first.id }, DEFAULT_STRATEGY, now);
    expect(committed.status).toBe("FILLED");
    let remainder = await prisma.order.findFirst({ where: { accountId, status: "PENDING", side: "SELL" } });
    expect(remainder).not.toBeNull();
    expect(remainder!.reasonCodes).toContain("EXIT_PARTIAL_REMAINDER");
    expect(remainder!.intent).toBe("FLATTEN");

    for (let round = 0; round < 20 && remainder; round += 1) {
      now = new Date(now.getTime() + 5_000);
      await observation(now, { priceUsd: "1", liquidityUsd: "50000" });
      const orderId = remainder.id;
      const settled = await prisma.$transaction(async (tx) => {
        await lockAccount(tx, accountId);
        return settlePendingOrder(tx, { accountId, orderId, config: DEFAULT_STRATEGY, mode: "live", now, tradingEnvironment: "MARKET_DATA_PAPER" });
      });
      expect(settled.status).toBe("FILLED");
      remainder = await prisma.order.findFirst({ where: { accountId, status: "PENDING", side: "SELL" } });
    }
    expect(remainder).toBeNull();
    const position = await prisma.position.findUniqueOrThrow({ where: { accountId_pairAddress: { accountId, pairAddress } } });
    expect(d(position.baseQty.toString()).toFixed(8)).toBe("0.00000000");
    const fills = await prisma.fill.findMany({ where: { order: { accountId }, side: "SELL" } });
    expect(fills.length).toBeGreaterThan(1);
    // Recorded slippage = impact (≤ maxExitImpactBps) + half the spread estimate.
    const ceiling = d(DEFAULT_STRATEGY.maxExitImpactBps).plus(d(DEFAULT_STRATEGY.spreadBpsEstimate).div(2)).plus("0.01");
    for (const fill of fills) expect(d(fill.slippageBps.toString()).lte(ceiling)).toBe(true);
  });

  it("rejects a pending BUY whose quote ages from LIVE into DELAYED before settlement, even with DEMO entries on", async () => {
    await reset();
    const t0 = new Date("2026-10-30T11:00:00.000Z");
    const eligibleAt = new Date(t0.getTime() + 5_000);
    const decision = await observation(t0, { priceUsd: "100", liquidityUsd: "1000000" });
    const clientOrderId = newId("ord");
    const config = { ...DEFAULT_STRATEGY, allowDemoPaperEntries: true };
    const pending = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId);
      return commitProposedOrder(tx, {
        accountId,
        cycleId: "cyc_b3_delayed",
        order: {
          clientOrderId,
          pairAddress,
          baseSymbol: "SOL",
          side: "BUY",
          intent: "ENTRY",
          qty: "1",
          observationId: decision.id,
          reasonCodes: ["ORDER_PROPOSED"],
          eligibleAt: eligibleAt.toISOString(),
          expiresAt: new Date(eligibleAt.getTime() + 120_000).toISOString(),
        },
        config,
        mode: "live",
        now: t0,
      });
    });
    expect(pending.status).toBe("PENDING");
    // A post-eligibility quote that is LIVE when it arrives but older than liveMaxAgeMs at settlement.
    const fillAt = new Date(eligibleAt.getTime() + 1_000);
    await observation(fillAt, { priceUsd: "100", liquidityUsd: "1000000", ingestJobId: "cyc_b3_delayed" });
    const settleAt = new Date(fillAt.getTime() + DEFAULT_STRATEGY.liveMaxAgeMs + 5_000);
    const settled = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId);
      return settlePendingOrder(tx, {
        accountId,
        orderId: (await tx.order.findUniqueOrThrow({ where: { clientOrderId } })).id,
        config,
        mode: "live",
        now: settleAt,
        tradingEnvironment: "MARKET_DATA_PAPER",
      });
    });
    expect(settled.status).toBe("REJECTED");
    expect(settled.reason).toBe("DATA_DELAYED");
  });

  it("rejects an immediate BUY on a DELAYED quote even with DEMO entries on", async () => {
    await reset();
    const now = new Date("2026-10-30T11:10:00.000Z");
    const delayed = await observation(now, { priceUsd: "100", liquidityUsd: "1000000", freshness: "DELAYED" });
    const result = await commit(
      { side: "BUY", intent: "ENTRY", qty: "1", observationId: delayed.id },
      { ...DEFAULT_STRATEGY, allowDemoPaperEntries: true },
      now,
    );
    expect(result).toEqual({ status: "REJECTED", reason: "DATA_DELAYED" });
  });

  it("rejects DEMO entries by default, and outside DATA_MODE=demo even with the flag", async () => {
    await reset();
    const now = new Date("2026-10-30T11:20:00.000Z");
    const demo = await observation(now, { priceUsd: "100", liquidityUsd: "1000000", freshness: "DEMO" });
    const byDefault = await commit({ side: "BUY", intent: "ENTRY", qty: "1", observationId: demo.id }, DEFAULT_STRATEGY, now, "demo");
    expect(byDefault).toEqual({ status: "REJECTED", reason: "DATA_DEMO" });
    const liveMode = await commit(
      { side: "BUY", intent: "ENTRY", qty: "1", observationId: demo.id },
      { ...DEFAULT_STRATEGY, allowDemoPaperEntries: true },
      now,
      "live",
    );
    expect(liveMode).toEqual({ status: "REJECTED", reason: "DATA_DEMO" });
    const demoMode = await commit(
      { side: "BUY", intent: "ENTRY", qty: "1", observationId: demo.id },
      { ...DEFAULT_STRATEGY, allowDemoPaperEntries: true },
      now,
      "demo",
    );
    expect(demoMode.status).toBe("FILLED");
  });

  it("releases a STRATEGY exit reservation exactly once when a pending exit expires (review F3)", async () => {
    await reset();
    await prisma.strategyAllocation.deleteMany({ where: { accountId } });
    await prisma.strategyInstance.deleteMany({ where: { accountId } });
    await seedPosition("100");
    const instance = await prisma.strategyInstance.create({
      data: { name: "f3", version: "1", accountId, instrumentIds: [pairAddress], params: {}, budgetUsd: "1000" },
    });
    await prisma.strategyAllocation.create({
      data: { accountId, strategyInstanceId: instance.id, instrumentId: pairAddress, pairAddress, qty: "100", avgCostUsd: "1" },
    });
    const t0 = new Date("2026-10-30T12:00:00.000Z");
    const decision = await observation(t0, { priceUsd: "1", liquidityUsd: "1000000" });
    const pendingExit = async (expiresInMs: number) => {
      const clientOrderId = newId("ord");
      const result = await prisma.$transaction(async (tx) => {
        await lockAccount(tx, accountId);
        return commitProposedOrder(tx, {
          accountId,
          cycleId: newId("cyc"),
          order: {
            clientOrderId,
            pairAddress,
            baseSymbol: "SOL",
            side: "SELL",
            intent: "EXIT",
            qty: "30",
            observationId: decision.id,
            reasonCodes: ["ORDER_PROPOSED"],
            ownerScope: "STRATEGY",
            strategyInstanceId: instance.id,
            eligibleAt: new Date(t0.getTime() + 5_000).toISOString(),
            expiresAt: new Date(t0.getTime() + expiresInMs).toISOString(),
          },
          config: DEFAULT_STRATEGY,
          mode: "live",
          now: t0,
        });
      });
      expect(result.status).toBe("PENDING");
      return prisma.order.findUniqueOrThrow({ where: { clientOrderId } });
    };
    const first = await pendingExit(10_000);
    await pendingExit(600_000);
    const reserved = async () =>
      d((await prisma.strategyAllocation.findFirstOrThrow({ where: { accountId, strategyInstanceId: instance.id } })).reservedExitQty.toString()).toFixed(8);
    expect(await reserved()).toBe("60.00000000");
    const expired = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId);
      return settlePendingOrder(tx, { accountId, orderId: first.id, config: DEFAULT_STRATEGY, mode: "live", now: new Date(t0.getTime() + 20_000), tradingEnvironment: "MARKET_DATA_PAPER" });
    });
    expect(expired.status).toBe("EXPIRED");
    // Only the expired order's 30 is released; the other pending exit keeps its reservation.
    expect(await reserved()).toBe("30.00000000");
    await prisma.strategyAllocation.deleteMany({ where: { accountId } });
    await prisma.strategyInstance.deleteMany({ where: { accountId } });
  });
});
