import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, INTEGRATION_TEST_ADVISORY_LOCK } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import {
  allocateOpportunities,
  ensureDefaultStrategyInstances,
  evaluateConcurrentInstances,
  instanceMatchesInstrument,
  listActiveStrategyInstances,
} from "./strategy-instances.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/**
 * Call-site evidence for C32/C33: same sequence as worker loadPlan —
 * ensureDefault → evaluateConcurrent → allocateOpportunities.
 * Uses shared advisory lock so it cannot race promote-paper / stage-runner truncates.
 */
describe.skipIf(!enabled)("strategy instances worker call-site path", () => {
  let prisma: PrismaClient;
  const accountId = "primary:strategy-instances-it";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
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
    await prisma.strategyAllocation.deleteMany({ where: { accountId } });
  });

  afterAll(async () => {
    await prisma.strategyInstance.deleteMany({ where: { accountId } });
    await prisma.strategyAllocation.deleteMany({ where: { accountId } });
    await prisma.paperAccount.deleteMany({ where: { id: accountId } });
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("seeds ≥3 concurrent instances and gates entries via allocate", async () => {
    const seeded = await ensureDefaultStrategyInstances(prisma, accountId);
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    const listed = await listActiveStrategyInstances(prisma, accountId);
    expect(listed.map((row) => row.name).sort()).toEqual(
      expect.arrayContaining(["pulse-momentum-v1", "pulse-momentum-v1-fx", "mean-revert-fade-v1"]),
    );

    const crypto = listed.find((r) => r.name === "pulse-momentum-v1")!;
    expect(
      instanceMatchesInstrument(crypto, { instrumentId: "fx:EURUSD", pairAddress: "fx:EURUSD" }),
    ).toBe(false);
    expect(
      instanceMatchesInstrument(crypto, {
        instrumentId: "solana:spot:universe",
        pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      }),
    ).toBe(true);

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

    // Crypto universe must not evaluate FX/ETF bars.
    expect(signals.every((s) => s.strategyInstanceId !== crypto.id)).toBe(true);

    const allocated = allocateOpportunities({
      signals,
      maxNewEntries: 2,
      fairnessCursor: null,
    });
    expect(allocated.accepted.length + allocated.deferred.length).toBe(signals.length);
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
    expect(Number(row.budgetUsd.toString())).toBe(4242);
    expect(row.params).toMatchObject({ custom: true });
    const concurrent = await Promise.all([
      ensureDefaultStrategyInstances(prisma, accountId),
      ensureDefaultStrategyInstances(prisma, accountId),
    ]);
    expect(concurrent[0].length).toBe(concurrent[1].length);
  });

  it("fairness cursor rotates permanent alphabetical winners (§15)", async () => {
    const mk = (id: string, instrumentId: string) => ({
      intent: "ENTER_LONG" as const,
      reasonCodes: ["ENTRY_MOMENTUM"],
      instrumentId,
      pairAddress: instrumentId,
      strategyInstanceId: id,
      strategyVersion: "v1",
      moduleRef: "pulse-momentum-v1",
      accountId,
      artifactHash: null,
      sourceHash: null,
    });
    const signals = [mk("aaa", "fx:EURUSD"), mk("bbb", "fx:GBPUSD"), mk("ccc", "fx:USDJPY")];
    const first = allocateOpportunities({ signals, maxNewEntries: 1, fairnessCursor: null });
    expect(first.accepted.map((s) => s.strategyInstanceId)).toEqual(["aaa"]);
    const second = allocateOpportunities({
      signals,
      maxNewEntries: 1,
      fairnessCursor: first.nextFairnessCursor,
    });
    expect(second.accepted.map((s) => s.strategyInstanceId)).toEqual(["bbb"]);
  });
});
