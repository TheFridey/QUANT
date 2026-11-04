import type { Queue } from "bullmq";
import { computeHistoricalDrawdown } from "@odin/analytics";
import { DEFAULT_STRATEGY } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryHistoricalDrawdown } from "./historical-drawdown.js";
import { TerminalService } from "./terminal.service.js";

/**
 * Overview drawdown regression: the snapshot used to sample the EARLIEST 500
 * EquitySnapshot rows, so a drawdown after row 500 showed as 0.00%.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const t0 = Date.UTC(2026, 9, 1);
const at = (i: number) => new Date(t0 + i * 60_000);

/** 600 rising points (peak 10599 at i=599), crash to 9000, partial recovery. */
function series(): Array<{ equityUsd: string; at: Date }> {
  return [
    ...Array.from({ length: 600 }, (_, i) => ({ equityUsd: String(10_000 + i), at: at(i) })),
    { equityUsd: "9000", at: at(600) },
    { equityUsd: "9500", at: at(601) },
  ];
}

async function seed(prisma: PrismaClient, accountId: string, points: Array<{ equityUsd: string; at: Date }>, withNull = false) {
  await prisma.equitySnapshot.deleteMany({ where: { accountId } });
  await prisma.equitySnapshot.createMany({
    data: points.map((point) => ({
      accountId,
      cashUsd: point.equityUsd,
      equityUsd: point.equityUsd,
      realizedPnlUsd: "0",
      valuation: "CASH_ONLY",
      feesUsd: "0",
      metrics: {},
      createdAt: point.at,
    })),
  });
  if (withNull) {
    // INCOMPLETE valuations have null equity and must be ignored, not read as zero.
    await prisma.equitySnapshot.create({
      data: { accountId, cashUsd: "1", equityUsd: null, realizedPnlUsd: "0", valuation: "INCOMPLETE", feesUsd: "0", metrics: {}, createdAt: at(600) },
    });
  }
}

describe.skipIf(!enabled)("all-history max drawdown (PostgreSQL window function)", () => {
  let prisma: PrismaClient;
  const scratch = "dd-test:scratch";
  const other = "dd-test:other";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });

  afterAll(async () => {
    await prisma.equitySnapshot.deleteMany({ where: { accountId: { in: [scratch, other] } } });
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("measures a drawdown that occurs after the first 500 snapshots, scoped to the account", async () => {
    const points = series();
    await seed(prisma, scratch, points, true);
    // A different account with a deeper fall must not leak in.
    await seed(prisma, other, [
      { equityUsd: "10000", at: at(0) },
      { equityUsd: "5000", at: at(1) },
    ]);

    const result = await queryHistoricalDrawdown(prisma, scratch);
    expect(result).toMatchObject({
      range: "ALL",
      maxDrawdownPct: "15.0863",
      peakEquityUsd: "10599.00000000",
      troughEquityUsd: "9000.00000000",
      peakAt: at(599).toISOString(),
      troughAt: at(600).toISOString(),
      sampleCount: 602,
      firstAt: at(0).toISOString(),
      lastAt: at(601).toISOString(),
    });
    // SQL and the in-memory reference agree.
    expect(result).toEqual(computeHistoricalDrawdown(points));
  });

  it("returns a null drawdown and zero samples for an account with no snapshots", async () => {
    const result = await queryHistoricalDrawdown(prisma, "dd-test:empty");
    expect(result).toMatchObject({ sampleCount: 0, maxDrawdownPct: null, firstAt: null, lastAt: null });
  });

  it("the terminal snapshot reports the all-history value with its window", async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "CycleRun", "PaperAccount", "EngineControl", "User" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config: DEFAULT_STRATEGY });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { config: toJson({ ...DEFAULT_STRATEGY, tradingEnvironment: "MARKET_DATA_PAPER" }) },
    });
    await prisma.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: "9500", highWaterMarkUsd: "10599" } });
    await seed(prisma, "primary", series());

    const service = new TerminalService(prisma, {} as Queue);
    const snapshot = (await service.snapshot()) as unknown as {
      portfolio: {
        maxDrawdownPct: string | null;
        historicalMaxDrawdownPct: string | null;
        currentDrawdownPct: string | null;
        analyticsWindows: { historicalDrawdown: { range: string; sampleSize: number; source: string; method: string } };
      };
    };
    expect(snapshot.portfolio.historicalMaxDrawdownPct).toBe("15.0863");
    expect(snapshot.portfolio.maxDrawdownPct).toBe("15.0863");
    expect(snapshot.portfolio.currentDrawdownPct).toBe("10.3689");
    expect(snapshot.portfolio.analyticsWindows.historicalDrawdown).toMatchObject({ range: "ALL", sampleSize: 602 });
    expect(snapshot.portfolio.analyticsWindows.historicalDrawdown.source).toContain("EquitySnapshot");
    await prisma.equitySnapshot.deleteMany({ where: { accountId: "primary" } });
  });
});
