import { DEFAULT_STRATEGY, d } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { commitProposedOrder, lockAccount } from "@odin/trading-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

describe.skipIf(!enabled)("paper cycle persistence", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "PaperAccount", "EngineControl", "User" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config: DEFAULT_STRATEGY,
    });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: "RUNNING", config: toJson(DEFAULT_STRATEGY) },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("turns a live-shaped observation into one paper fill and a ledger that matches cash", async () => {
    const feed: MarketFeed = {
      async fetchUniverse() {
        return {
          ok: true,
          fetchedAt: new Date().toISOString(),
          data: [
            {
              source: "dexscreener",
              chainId: "solana",
              pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
              dexId: "orca",
              url: "https://dexscreener.com/solana/Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
              baseAddress: "So11111111111111111111111111111111111111112",
              baseSymbol: "SOL",
              baseName: "Wrapped SOL",
              quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              quoteSymbol: "USDC",
              priceUsd: "100",
              liquidityUsd: "1000000",
              volume24hUsd: "5000000",
              volume5mUsd: "10000",
              priceChangeM5Pct: "3.5",
              priceChangeH1Pct: "1.2",
              priceChangeH24Pct: "4",
              txnsM5Buys: 80,
              txnsM5Sells: 20,
              raw: { fixture: "integration" },
            },
          ],
        };
      },
    };
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "test" });
    expect(ingested.skipped).toBe(false);
    await runner.sentinel(ingested.cycleId);
    await runner.pulse(ingested.cycleId);
    await runner.aegis(ingested.cycleId);
    await runner.atlas(ingested.cycleId);
    await runner.executor(ingested.cycleId);
    await runner.archivist(ingested.cycleId);

    const observation = await prisma.marketObservation.findFirst({ where: { ingestJobId: ingested.cycleId } });
    expect(observation?.source).toBe("dexscreener");
    expect(observation?.freshness).toBe("LIVE");
    const fills = await prisma.fill.findMany();
    expect(fills).toHaveLength(1);
    expect(fills[0]?.priceUsd.toString().startsWith("100.")).toBe(true);
    const account = await prisma.paperAccount.findUniqueOrThrow({ where: { id: "primary" } });
    const lines = await prisma.ledgerEntry.findMany();
    const summed = lines.filter((line) => line.affectsCash).reduce((total, line) => total.plus(d(line.amountUsd.toString())), d("0"));
    expect(summed.eq(d(account.cashUsd.toString()))).toBe(true);
    expect(d(account.cashUsd.toString()).lt(d(account.startingBalanceUsd.toString()))).toBe(true);
    const agents = new Set((await prisma.agentDecision.findMany({ where: { cycleId: ingested.cycleId } })).map((row) => row.agent));
    for (const agent of ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR", "ARCHIVIST"]) {
      expect(agents.has(agent)).toBe(true);
    }

    const order = await prisma.order.findFirstOrThrow({ where: { status: "FILLED" } });
    const replay = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, "primary");
      return commitProposedOrder(tx, {
        accountId: "primary",
        cycleId: ingested.cycleId,
        order: {
          clientOrderId: order.clientOrderId,
          pairAddress: order.pairAddress,
          baseSymbol: order.baseSymbol,
          side: "BUY",
          intent: "ENTRY",
          qty: order.qty.toString(),
          observationId: fills[0]?.observationId ?? "",
          reasonCodes: ["ORDER_PROPOSED"],
        },
        config: DEFAULT_STRATEGY,
        mode: "live",
        now: new Date(),
      });
    });
    expect(replay.status).toBe("REPLAY");
    expect(await prisma.fill.count()).toBe(1);
  });
});
