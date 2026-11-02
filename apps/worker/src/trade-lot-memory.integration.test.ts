/**
 * ASCEND-09 point-in-time trade memory against a real database and a real paper cycle.
 * The snapshot write must not change any trading row, must be append-only, and must not depend on
 * rows recorded after the fill it describes.
 */
import { assertNoPostAsOfTimestamps, collectTimestamps, viewHash, type PointInTimeView } from "@odin/analytics";
import { DEFAULT_STRATEGY, INTEGRATION_TEST_ADVISORY_LOCK } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";
import { persistTradeLotSnapshots } from "./trade-lot-memory.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const config = {
  ...DEFAULT_STRATEGY,
  multiMarketPaperIngest: false,
  paperLatencyMs: 0,
  entryM5ChangePct: "1",
  minH1ChangePct: "0",
  allowDemoPaperEntries: true,
};

const feed: MarketFeed = {
  security: passingSecuritySource,
  async fetchUniverse() {
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      data: [
        {
          source: "dexscreener",
          chainId: "solana",
          pairAddress,
          dexId: "orca",
          url: `https://dexscreener.com/solana/${pairAddress}`,
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
          raw: { fixture: "ascend-09" },
        },
      ],
    };
  },
};

/** md5 over every row of the trading tables, in id order. */
async function tradingHashes(prisma: PrismaClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of ["Order", "Fill", "Position", "LedgerEntry", "StrategyAllocation", "PaperAccount", "RiskReservation", "ProtectionOrder"]) {
    const rows = await prisma.$queryRawUnsafe<Array<{ h: string | null; n: bigint }>>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) AS h, count(*) AS n FROM "${table}" t`,
    );
    out[table] = `${rows[0]!.n}:${rows[0]!.h}`;
  }
  return out;
}

describe.skipIf(!enabled)("ASCEND-09 trade lot snapshots (worker + DB)", () => {
  let prisma: PrismaClient;
  let cycleId = "";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "CyclePlan", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState", "TradeMemory", "TradeLotSnapshot" RESTART IDENTITY CASCADE`,
    );
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config,
    });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING", config: toJson(config) } });

    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    const ingested = await runner.ingest({ trigger: "ascend-09" });
    cycleId = ingested.cycleId;
    await runner.sentinel(cycleId);
    await runner.pulse(cycleId);
    await runner.aegis(cycleId);
    await runner.atlas(cycleId);
    await runner.executor(cycleId);
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("writes one ENTRY snapshot per lot open without changing any trading row", async () => {
    const entryFill = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } }, include: { order: true } });
    const before = await tradingHashes(prisma);
    const result = await persistTradeLotSnapshots(prisma, { accountId: "primary" });
    const after = await tradingHashes(prisma);
    expect(after).toEqual(before);
    expect(result.written).toBeGreaterThanOrEqual(1);

    const snapshot = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: entryFill.id } });
    expect(snapshot.phase).toBe("ENTRY");
    expect(snapshot.entryFillId).toBe(entryFill.id);
    expect(snapshot.asOf.toISOString()).toBe(entryFill.createdAt.toISOString());
    const view = snapshot.view as unknown as PointInTimeView;
    expect(viewHash(view)).toBe(snapshot.viewHash);
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
    for (const stamp of collectTimestamps(view)) expect(Date.parse(stamp.at)).toBeLessThanOrEqual(entryFill.createdAt.getTime());
    expect(view.decisionObservation?.id).toBe(entryFill.order.decisionObservationId);
    expect(view.decisions.length).toBeGreaterThan(0);
    expect(view.decisions.every((row) => Date.parse(row.createdAt) <= entryFill.createdAt.getTime())).toBe(true);
    expect(view.strategy.strategyInstanceId).toBe(entryFill.order.strategyInstanceId);
    expect(view.config.configHash).toBeTruthy();
    expect(view.estimatedCost.source).toBe("CYCLE_PLAN");
    expect(view.estimatedCost.estimatedCostUsd).toBeTruthy();
    expect(view.quoteFreshness.decisionObservationAgeAtFillMs).not.toBeNull();
    // Lifecycle id is an identity label (outside the view), from the open Position.
    const position = await prisma.position.findUniqueOrThrow({ where: { accountId_pairAddress: { accountId: "primary", pairAddress } } });
    expect(snapshot.lifecycleId).toBe(position.lifecycleId);
  });

  it("the archivist stage writes nothing twice (idempotent on fillId)", async () => {
    const count = await prisma.tradeLotSnapshot.count();
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
    await runner.archivist(cycleId);
    expect(await prisma.tradeLotSnapshot.count()).toBe(count);
    const again = await persistTradeLotSnapshots(prisma, { accountId: "primary" });
    expect(again.written).toBe(0);
  });

  it("is prefix invariant: rows recorded after the entry fill do not change the rebuilt view", async () => {
    const entryFill = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } } });
    const original = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: entryFill.id } });
    const later = new Date(entryFill.createdAt.getTime() + 60_000);
    const decisionObservation = await prisma.marketObservation.findFirstOrThrow({ where: { pairAddress } });
    await prisma.marketObservation.create({
      data: {
        ...decisionObservation,
        id: "obs_after_entry",
        ingestJobId: "job_after_entry",
        priceUsd: "250",
        receivedAt: later,
        raw: toJson({ later: true }),
        createdAt: later,
      },
    });
    await prisma.agentDecision.create({
      data: { cycleId, agent: "LATE_AGENT", modelVersion: "late-1", pairAddress, decision: "ACT", confidence: "1", reasonCodes: ["LATE"], input: {}, output: { estimatedCostUsd: "999" }, createdAt: later },
    });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { config: toJson({ ...config, feeBps: "77" }) } });
    // TRUNCATE (not DELETE: the table is append-only) and rebuild from the database as it is now.
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "TradeLotSnapshot"`);
    await persistTradeLotSnapshots(prisma, { accountId: "primary" });
    const rebuilt = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: entryFill.id } });
    expect(rebuilt.viewHash).toBe(original.viewHash);
    expect(rebuilt.view).toEqual(original.view);
    expect(JSON.stringify(rebuilt.view)).not.toContain("LATE_AGENT");
  });

  it("rejects UPDATE and DELETE on TradeLotSnapshot", async () => {
    const row = await prisma.tradeLotSnapshot.findFirstOrThrow();
    await expect(prisma.tradeLotSnapshot.update({ where: { id: row.id }, data: { viewHash: "tampered" } })).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "TradeLotSnapshot" SET "phase" = 'EXIT' WHERE "id" = $1`, row.id)).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.tradeLotSnapshot.delete({ where: { id: row.id } })).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "TradeLotSnapshot"`)).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    expect((await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { id: row.id } })).viewHash).toBe(row.viewHash);
  });

  it("writes an EXIT snapshot for a reducing fill, bounded by the exit fill time", async () => {
    const entry = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } }, include: { order: true } });
    // A booked paper exit recorded directly (the snapshot writer only reads these tables).
    const exitAt = new Date(Date.now() + 1000);
    const order = await prisma.order.create({
      data: {
        clientOrderId: "coid_a09_exit",
        cycleId,
        accountId: "primary",
        pairAddress,
        baseSymbol: entry.order.baseSymbol,
        side: "SELL",
        intent: "EXIT",
        status: "FILLED",
        qty: entry.qty,
        filledQty: entry.qty,
        reasonCodes: ["STOP_LOSS", "FILLED"],
        ownerScope: "PROTECTION",
        createdAt: exitAt,
      },
    });
    const exitFill = await prisma.fill.create({
      data: {
        orderId: order.id,
        pairAddress,
        side: "SELL",
        qty: entry.qty,
        priceUsd: "99",
        notionalUsd: "1",
        feeUsd: "0.01",
        slippageBps: "10",
        liquidityUsd: "1000000",
        createdAt: exitAt,
      },
    });
    await persistTradeLotSnapshots(prisma, { accountId: "primary" });
    const snapshot = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: exitFill.id } });
    expect(snapshot.phase).toBe("EXIT");
    expect(snapshot.eventKind).toBe("EXIT");
    expect(snapshot.entryFillId).toBe(entry.id);
    const view = snapshot.view as unknown as PointInTimeView;
    expect(view.order.exitReason).toEqual({ code: "STOP_LOSS", source: "REASON_CODE" });
    expect(view.excursionToDate).not.toBeNull();
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
  });
});
