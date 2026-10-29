import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, d, newId } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import { commitProposedOrder, lockAccount, settlePendingOrder } from "./store.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

describe.skipIf(!enabled)("pending fill uses eligible observation (R04)", () => {
  let prisma: PrismaClient;
  const accountId = "primary:pending-r04";
  const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.fill.deleteMany({ where: { order: { accountId } } });
    await prisma.ledgerEntry.deleteMany({ where: { accountId } });
    await prisma.order.deleteMany({ where: { accountId } });
    await prisma.position.deleteMany({ where: { accountId } });
    await prisma.marketObservation.deleteMany({ where: { pairAddress } });
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: {
        id: accountId,
        cashUsd: "100000",
        startingBalanceUsd: "100000",
        tradingEnvironment: "MARKET_DATA_PAPER",
      },
      update: { cashUsd: "100000" },
    });
  });

  afterAll(async () => {
    await prisma.fill.deleteMany({ where: { order: { accountId } } });
    await prisma.ledgerEntry.deleteMany({ where: { accountId } });
    await prisma.order.deleteMany({ where: { accountId } });
    await prisma.position.deleteMany({ where: { accountId } });
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("fills against a post-eligibility price, not the decision quote", async () => {
    const t0 = new Date("2026-10-29T10:00:00.000Z");
    const eligibleAt = new Date("2026-10-29T10:00:05.000Z");
    const tFill = new Date("2026-10-29T10:00:06.000Z");
    const decisionObs = await prisma.marketObservation.create({
      data: {
        ingestJobId: "cyc_r04_decision",
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
        tradingEnvironment: "MARKET_DATA_PAPER",
        receivedAt: t0,
        eventTime: t0,
        raw: {},
      },
    });
    const fillObs = await prisma.marketObservation.create({
      data: {
        ingestJobId: "cyc_r04_fill",
        source: "dexscreener",
        chainId: "solana",
        pairAddress,
        dexId: "orca",
        baseAddress: "So11111111111111111111111111111111111111112",
        baseSymbol: "SOL",
        baseName: "Wrapped SOL",
        quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        quoteSymbol: "USDC",
        priceUsd: "110",
        liquidityUsd: "1000000",
        freshness: "LIVE",
        dataOrigin: "LIVE_FEED",
        tradingEnvironment: "MARKET_DATA_PAPER",
        receivedAt: tFill,
        eventTime: tFill,
        raw: {},
      },
    });

    const clientOrderId = newId("ord");
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId);
      const pending = await commitProposedOrder(tx, {
        accountId,
        cycleId: "cyc_r04",
        order: {
          clientOrderId,
          pairAddress,
          baseSymbol: "SOL",
          side: "BUY",
          intent: "ENTRY",
          qty: "1",
          observationId: decisionObs.id,
          reasonCodes: ["ORDER_PROPOSED"],
          eligibleAt: eligibleAt.toISOString(),
          expiresAt: new Date(eligibleAt.getTime() + 60_000).toISOString(),
        },
        config: { ...DEFAULT_STRATEGY, allowDemoPaperEntries: false },
        mode: "live",
        now: t0,
      });
      expect(pending.status).toBe("PENDING");
    });

    const settled = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId);
      return settlePendingOrder(tx, {
        accountId,
        orderId: (await tx.order.findUniqueOrThrow({ where: { clientOrderId } })).id,
        config: { ...DEFAULT_STRATEGY, allowDemoPaperEntries: false },
        mode: "live",
        now: tFill,
        tradingEnvironment: "MARKET_DATA_PAPER",
      });
    });

    expect(settled.status).toBe("FILLED");
    const order = await prisma.order.findUniqueOrThrow({ where: { clientOrderId } });
    expect(order.decisionObservationId).toBe(decisionObs.id);
    expect(order.fillObservationId).toBe(fillObs.id);
    const fill = await prisma.fill.findFirstOrThrow({ where: { orderId: order.id } });
    expect(fill.observationId).toBe(fillObs.id);
    expect(d(fill.priceUsd.toString()).gt("105")).toBe(true);
    expect(fill.observationId).not.toBe(decisionObs.id);
  });
});
