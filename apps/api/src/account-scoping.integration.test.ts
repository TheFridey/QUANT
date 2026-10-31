import type { Queue } from "bullmq";
import { DEFAULT_STRATEGY, newId } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TerminalService } from "./terminal.service.js";

/** Audit F3: order history and the activity feed show only the active account. */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

describe.skipIf(!enabled)("account scoping of history and activity (audit F3)", () => {
  let prisma: PrismaClient;
  const other = "primary:replay";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "CycleRun", "PaperAccount", "EngineControl", "User" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config: DEFAULT_STRATEGY });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { config: toJson({ ...DEFAULT_STRATEGY, tradingEnvironment: "MARKET_DATA_PAPER" }) },
    });
    await prisma.paperAccount.create({
      data: { id: other, cashUsd: "10000", startingBalanceUsd: "10000", tradingEnvironment: "REPLAY" },
    });
    for (const [accountId, symbol] of [
      ["primary", "MINE"],
      [other, "THEIRS"],
    ] as const) {
      const cycleId = newId("cyc");
      await prisma.cycleRun.create({
        data: { id: cycleId, trigger: "test", status: "COMPLETE", stage: "complete", dataState: "LIVE", startedAt: new Date(), accountId },
      });
      await prisma.order.create({
        data: {
          clientOrderId: newId("ord"),
          cycleId,
          accountId,
          pairAddress: `${symbol}-pair`,
          baseSymbol: symbol,
          side: "BUY",
          intent: "ENTRY",
          status: "REJECTED",
          qty: "1",
          filledQty: "0",
          reasonCodes: [],
          rejectReason: "TEST",
        },
      });
      await prisma.agentDecision.create({
        data: {
          cycleId,
          agent: "ATLAS",
          modelVersion: "t",
          pairAddress: `${symbol}-pair`,
          decision: "REJECT",
          confidence: "1",
          reasonCodes: ["TEST"],
          input: {},
          output: {},
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("order history lists only the active account's orders", async () => {
    const service = new TerminalService(prisma, {} as Queue);
    const history = await service.orderHistory({ kind: "all", limit: 50, offset: 0 });
    const symbols = (history as { items: Array<{ baseSymbol: string }> }).items.map((row) => row.baseSymbol);
    expect(symbols).toContain("MINE");
    expect(symbols).not.toContain("THEIRS");
  });

  it("the activity feed shows only the active account's orders and decisions", async () => {
    const service = new TerminalService(prisma, {} as Queue);
    const feed = (await service.activityFeed(100)) as unknown as { events?: Array<{ pairAddress: string | null }> } | Array<{ pairAddress: string | null }>;
    const events = Array.isArray(feed) ? feed : (feed.events ?? []);
    const pairs = events.map((event) => event.pairAddress);
    expect(pairs).toContain("MINE-pair");
    expect(pairs).not.toContain("THEIRS-pair");
  });
});
