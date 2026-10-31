import { DEFAULT_STRATEGY } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import type { CyclePlanSnapshot } from "@odin/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";

/**
 * Audit F1: one plan per cycle. AEGIS/ATLAS rows are projections of the stored plan, and the
 * executor only acts on what that plan decided, even when the world moves between stages.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

const feed: MarketFeed = {
  async fetchUniverse() {
    return {
      ok: true,
      fetchedAt: clock.toISOString(),
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
          raw: { fixture: "cycle-plan" },
        },
      ],
    };
  },
};

let clock = new Date();

describe.skipIf(!enabled)("single plan per cycle (audit F1)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "CycleRun", "CyclePlan", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState" RESTART IDENTITY CASCADE`,
    );
    const config = { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs: 0 };
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING", config: toJson(config) } });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  async function runCycle(advanceBeforeExecutorMs: number) {
    await prisma.cycleRun.updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED", error: "TEST_RESET" } });
    clock = new Date();
    const runner = new StageRunner(prisma, feed, silentBus, "live", () => clock);
    const ingested = await runner.ingest({ trigger: `cycle-plan-${advanceBeforeExecutorMs}` });
    expect(ingested.skipped).toBe(false);
    const cycleId = ingested.cycleId;
    await runner.sentinel(cycleId);
    await runner.pulse(cycleId);
    await runner.aegis(cycleId);
    await runner.atlas(cycleId);
    clock = new Date(clock.getTime() + advanceBeforeExecutorMs);
    await runner.executor(cycleId);
    const row = await prisma.cyclePlan.findUniqueOrThrow({ where: { cycleId } });
    return { cycleId, snapshot: row.plan as unknown as CyclePlanSnapshot };
  }

  async function assertProjectionsMatch(cycleId: string, snapshot: CyclePlanSnapshot) {
    for (const agent of ["AEGIS", "ATLAS"] as const) {
      const stored = await prisma.agentDecision.findMany({ where: { cycleId, agent }, orderBy: { pairAddress: "asc" } });
      const planned = snapshot.decisions.filter((decision) => decision.agent === agent);
      expect(stored.map((row) => [row.pairAddress, row.decision, row.reasonCodes])).toEqual(
        planned
          .sort((a, b) => a.pairAddress.localeCompare(b.pairAddress))
          .map((row) => [row.pairAddress, row.decision, row.reasonCodes]),
      );
    }
    const plannedIds = new Set(snapshot.orders.map((order) => order.clientOrderId));
    const entries = await prisma.order.findMany({ where: { cycleId, side: "BUY" } });
    for (const order of entries) expect(plannedIds.has(order.clientOrderId), order.clientOrderId).toBe(true);
  }

  it("executes the planned entry when nothing changes between stages", async () => {
    const { cycleId, snapshot } = await runCycle(0);
    expect(snapshot.orders.some((order) => order.side === "BUY")).toBe(true);
    await assertProjectionsMatch(cycleId, snapshot);
    const filled = await prisma.order.count({ where: { cycleId, side: "BUY", status: "FILLED" } });
    expect(filled).toBeGreaterThan(0);
  });

  it("keeps AEGIS/ATLAS identical to the plan and executes nothing unplanned when the quote ages before admission", async () => {
    const { cycleId, snapshot } = await runCycle(DEFAULT_STRATEGY.liveMaxAgeMs + 15_000);
    await assertProjectionsMatch(cycleId, snapshot);
    const admission = await prisma.agentDecision.findFirstOrThrow({ where: { cycleId, agent: "EXECUTOR", pairAddress: "(admission)" } });
    expect(admission.reasonCodes).toContain("CYCLE_PLAN_ADMISSION");
    const output = admission.output as { records: Array<{ result: string; side: string }> };
    // Whatever the planned entries were, none was executed beyond the plan; any that the stale quote
    // invalidated are recorded as rejected at admission rather than silently replaced.
    for (const record of output.records.filter((row) => row.side === "BUY")) {
      expect(["ADMITTED", "ADMITTED_REDUCED", "REJECTED_AT_ADMISSION"]).toContain(record.result);
    }
    const input = admission.input as { planTime: string; admissionTime: string };
    expect(Date.parse(input.admissionTime) - Date.parse(input.planTime)).toBeGreaterThanOrEqual(DEFAULT_STRATEGY.liveMaxAgeMs);
  });

  it("refuses to rewrite a stored plan", async () => {
    const plan = await prisma.cyclePlan.findFirstOrThrow();
    await expect(prisma.cyclePlan.update({ where: { cycleId: plan.cycleId }, data: { plannedAt: new Date() } })).rejects.toThrow(
      /EVIDENCE_IMMUTABLE/,
    );
  });
});
