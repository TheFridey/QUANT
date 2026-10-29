import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY } from "@odin/shared";
import { createPrismaClient } from "@odin/shared/db";
import {
  allocateOpportunities,
  ensureDefaultStrategyInstances,
  evaluateConcurrentInstances,
  listActiveStrategyInstances,
} from "./strategy-instances.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);

/**
 * Call-site evidence for C32/C33: same sequence as worker loadPlan —
 * ensureDefault → evaluateConcurrent → allocateOpportunities.
 */
describe.runIf(hasDb)("strategy instances worker call-site path", () => {
  const prisma = createPrismaClient();
  const accountId = "primary:strategy-instances-it";

  beforeAll(async () => {
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: {
        id: accountId,
        cashUsd: "50000",
        startingBalanceUsd: "50000",
        tradingEnvironment: "MARKET_DATA_PAPER",
      },
      update: {},
    });
    await prisma.strategyInstance.deleteMany({ where: { accountId } });
  });

  afterAll(async () => {
    await prisma.strategyInstance.deleteMany({ where: { accountId } });
    await prisma.paperAccount.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it("seeds ≥3 concurrent instances and gates entries via allocate", async () => {
    const seeded = await ensureDefaultStrategyInstances(prisma, accountId);
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    const listed = await listActiveStrategyInstances(prisma, accountId);
    expect(listed.map((row) => row.name).sort()).toEqual(
      expect.arrayContaining(["pulse-momentum-v1", "pulse-momentum-v1-fx", "mean-revert-fade-v1"]),
    );

    const bars = [
      {
        instrumentId: "fx:EURUSD",
        pairAddress: "fx:EURUSD",
        receivedAt: "2026-10-28T16:00:00.000Z",
        priceUsd: "1.085",
        liquidityUsd: "1000000000",
        volume24hUsd: "100000000",
        priceChangeM5Pct: "0.4",
        priceChangeH1Pct: "0.2",
        txnsM5Buys: 10,
        txnsM5Sells: 4,
        dataState: "DELAYED" as const,
      },
      {
        instrumentId: "etf:SPY",
        pairAddress: "etf:SPY",
        receivedAt: "2026-10-28T16:00:00.000Z",
        priceUsd: "500",
        liquidityUsd: "1000000000",
        volume24hUsd: "100000000",
        priceChangeM5Pct: "-0.3",
        priceChangeH1Pct: "0.1",
        txnsM5Buys: 8,
        txnsM5Sells: 9,
        dataState: "DELAYED" as const,
      },
    ];

    const { signals } = evaluateConcurrentInstances({
      instances: listed,
      bars,
      context: {
        config: {
          ...DEFAULT_STRATEGY,
          entryM5ChangePct: "0.1",
          minH1ChangePct: "0",
          allowDemoPaperEntries: true,
        },
        openPositions: [],
        history: [],
      },
    });

    const allocated = allocateOpportunities({
      signals,
      maxNewEntries: 2,
    });
    expect(allocated.accepted.length + allocated.deferred.length).toBe(signals.length);
    // Fairness: never admit more entries than maxNewEntries.
    const entries = allocated.accepted.filter((s) => s.intent === "ENTER_LONG");
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it("restart after pause does not reactivate PAUSED defaults (§6)", async () => {
    await ensureDefaultStrategyInstances(prisma, accountId);
    const pausedId = `stratinst_${accountId}_fx`;
    await prisma.strategyInstance.update({
      where: { id: pausedId },
      data: { status: "PAUSED", budgetUsd: "4242.00000000", params: { custom: true } },
    });
    const again = await ensureDefaultStrategyInstances(prisma, accountId);
    expect(again.every((row) => row.id !== pausedId)).toBe(true);
    const row = await prisma.strategyInstance.findUniqueOrThrow({ where: { id: pausedId } });
    expect(row.status).toBe("PAUSED");
    expect(row.budgetUsd.toString()).toBe("4242.00000000");
    const concurrent = await Promise.all([
      ensureDefaultStrategyInstances(prisma, accountId),
      ensureDefaultStrategyInstances(prisma, accountId),
    ]);
    expect(concurrent[0].length).toBe(concurrent[1].length);
  });
});
