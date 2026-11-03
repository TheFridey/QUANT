/**
 * ASCEND-09 point-in-time trade memory against a real database and a real paper cycle.
 * The snapshot write must not change any trading row, must be append-only, must not depend on rows
 * recorded (or rewritten) after the fill it describes, and must make durable progress.
 *
 * TradeLotSnapshot rejects TRUNCATE, so it is never reset here: every assertion is scoped to fills this
 * run created (fresh cuids, and fresh account ids for the synthetic backlog cases).
 */
import { assertNoPostAsOfTimestamps, collectTimestamps, viewHash, type PointInTimeView } from "@odin/analytics";
import { DEFAULT_STRATEGY, INTEGRATION_TEST_ADVISORY_LOCK } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertDecision } from "./decisions.js";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";
import { passingSecuritySource } from "./test-security-source.js";
import { persistTradeLotSnapshots, planTradeLotSnapshots, SNAPSHOT_SETTLE_MS } from "./trade-lot-memory.js";

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
/** A clock past the settle margin, so fills created during the test are candidates. */
const settledNow = () => new Date(Date.now() + SNAPSHOT_SETTLE_MS + 5_000);
const RUN = Date.now().toString(36);

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

/** Synthetic filled orders for one account (the writer only reads these). Returns fill ids in order. */
async function seedFills(prisma: PrismaClient, accountId: string, pair: string, sides: Array<"BUY" | "SELL">, startMs: number): Promise<string[]> {
  await prisma.paperAccount.upsert({ where: { id: accountId }, create: { id: accountId, cashUsd: "1000", startingBalanceUsd: "1000" }, update: {} });
  const orders = sides.map((side, index) => ({
    id: `${accountId}_o${index}`,
    clientOrderId: `${accountId}_c${index}`,
    cycleId: `${accountId}_cyc`,
    accountId,
    pairAddress: pair,
    baseSymbol: "SYN",
    side,
    intent: side === "BUY" ? "ENTRY" : "EXIT",
    status: "FILLED",
    qty: "1",
    filledQty: "1",
    reasonCodes: [],
    ownerScope: "STRATEGY",
    strategyInstanceId: "inst_syn",
    createdAt: new Date(startMs + index * 1000),
  }));
  await prisma.order.createMany({ data: orders });
  await prisma.fill.createMany({
    data: orders.map((order, index) => ({
      id: `${accountId}_f${String(index).padStart(4, "0")}`,
      orderId: order.id,
      pairAddress: pair,
      side: order.side,
      qty: "1",
      priceUsd: "1",
      notionalUsd: "1",
      feeUsd: "0",
      slippageBps: "0",
      liquidityUsd: "1000",
      strategyInstanceId: "inst_syn",
      createdAt: order.createdAt,
    })),
  });
  return orders.map((_, index) => `${accountId}_f${String(index).padStart(4, "0")}`);
}

describe.skipIf(!enabled)("ASCEND-09 trade lot snapshots (worker + DB)", () => {
  let prisma: PrismaClient;
  let cycleId = "";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Fill", "LedgerEntry", "Order", "Position", "AgentDecision", "MarketObservation", "WatchlistEntry", "SecurityAssessment", "EquitySnapshot", "ResearchProposal", "CycleRun", "CyclePlan", "PaperAccount", "EngineControl", "User", "RiskReservationEvent", "RiskReservation", "ProtectionIntent", "ProtectionOrder", "StrategyInstance", "StrategyAllocation", "TradeIntent", "RecoveryCase", "ReconciliationRun", "OpportunityFunnelEvent", "DurableAlert", "AccountSafetyState", "TradeMemory" RESTART IDENTITY CASCADE`,
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

  it("leaves fills inside the settle margin for a later cycle (review L1)", async () => {
    const entryFill = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } } });
    const early = await planTradeLotSnapshots(prisma, { accountId: "primary", now: new Date(entryFill.createdAt.getTime() + 1_000) });
    expect(early.rows.some((row) => row.fillId === entryFill.id)).toBe(false);
    const late = await planTradeLotSnapshots(prisma, { accountId: "primary", now: settledNow() });
    expect(late.rows.some((row) => row.fillId === entryFill.id)).toBe(true);
  });

  it("a writer failure is logged and does not fail the cycle", async () => {
    const failing = new Proxy(prisma, {
      get(target, property) {
        if (property === "tradeLotSnapshot") {
          return new Proxy({}, { get: () => async () => { throw new Error("SIMULATED_SNAPSHOT_FAILURE"); } });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const before = await prisma.tradeLotSnapshot.count();
    const runner = new StageRunner(failing, feed, silentBus, "live", settledNow);
    await expect(runner.archivist(cycleId)).resolves.toBeUndefined();
    const cycle = await prisma.cycleRun.findUniqueOrThrow({ where: { id: cycleId } });
    expect(cycle.status).toBe("COMPLETE");
    expect(await prisma.tradeLotSnapshot.count()).toBe(before);
  });

  it("writes one ENTRY snapshot per lot open without changing any trading row", async () => {
    const entryFill = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } }, include: { order: true } });
    const before = await tradingHashes(prisma);
    const result = await persistTradeLotSnapshots(prisma, { accountId: "primary", now: settledNow() });
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
    expect(view.order.reasonCodesSource).toBe("CYCLE_PLAN_AT_DECISION");
    expect(view.order.reasonCodes).not.toContain("FILLED"); // appended to the order row at fill time, not planned
    expect(view.quoteFreshness.decisionObservationAgeAtFillMs).not.toBeNull();
    const position = await prisma.position.findUniqueOrThrow({ where: { accountId_pairAddress: { accountId: "primary", pairAddress } } });
    expect(snapshot.lifecycleId).toBe(position.lifecycleId);
  });

  it("is idempotent on fillId", async () => {
    const count = await prisma.tradeLotSnapshot.count();
    const again = await persistTradeLotSnapshots(prisma, { accountId: "primary", now: settledNow() });
    expect(again.written).toBe(0);
    expect(await prisma.tradeLotSnapshot.count()).toBe(count);
  });

  it("is prefix invariant: rows recorded after the entry fill do not change the rebuilt view", async () => {
    const entryFill = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } } });
    const original = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: entryFill.id } });
    const later = new Date(entryFill.createdAt.getTime() + 60_000);
    const decisionObservation = await prisma.marketObservation.findFirstOrThrow({ where: { pairAddress } });
    await prisma.marketObservation.create({
      data: { ...decisionObservation, id: `obs_after_entry_${RUN}`, ingestJobId: `job_after_entry_${RUN}`, priceUsd: "250", receivedAt: later, raw: toJson({ later: true }), createdAt: later },
    });
    await prisma.agentDecision.create({
      data: { cycleId, agent: "LATE_AGENT", modelVersion: "late-1", pairAddress, decision: "ACT", confidence: "1", reasonCodes: ["LATE"], input: {}, output: { estimatedCostUsd: "999" }, createdAt: later, updatedAt: later },
    });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { config: toJson({ ...config, feeBps: "77" }) } });
    const rebuilt = await planTradeLotSnapshots(prisma, { accountId: "primary", fillIds: [entryFill.id], now: settledNow() });
    const row = rebuilt.rows.find((item) => item.fillId === entryFill.id)!;
    expect(row.viewHash).toBe(original.viewHash);
    expect(JSON.stringify(row.view)).not.toContain("LATE_AGENT");
  });

  it("excludes a decision upserted after the fill and marks the view decisionUnavailable (review M2)", async () => {
    const entryFill = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } } });
    const original = (await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: entryFill.id } })).view as unknown as PointInTimeView;
    const executorBefore = original.decisions.find((row) => row.agent === "EXECUTOR" && row.pairAddress === pairAddress);
    // The same upsert path admission uses for a second order on the pair: content changes, createdAt stays.
    await upsertDecision(prisma, cycleId, {
      agent: "EXECUTOR",
      modelVersion: "executor-paper-1.2.0",
      pairAddress,
      decision: "REJECT",
      confidence: "1.000000",
      reasonCodes: ["REJECTED"],
      input: {},
      output: { reason: "REVIEW_M2_PROBE" },
      inputSource: "test",
      durationMs: 0,
    });
    // A raw SQL rewrite (bypassing Prisma) of another decision is caught by the DB trigger.
    await prisma.$executeRawUnsafe(`UPDATE "AgentDecision" SET "decision" = 'RAW_REWRITE' WHERE "cycleId" = $1 AND "agent" = 'PULSE' AND "pairAddress" = $2`, cycleId, pairAddress);
    const rows = await prisma.agentDecision.findMany({ where: { cycleId, agent: { in: ["EXECUTOR", "PULSE"] }, pairAddress } });
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(entryFill.createdAt.getTime());
      expect(row.updatedAt.getTime()).toBeGreaterThan(entryFill.createdAt.getTime());
    }
    const rebuilt = await planTradeLotSnapshots(prisma, { accountId: "primary", fillIds: [entryFill.id], now: settledNow() });
    const view = rebuilt.rows[0]!.view as unknown as PointInTimeView;
    expect(view.decisionUnavailable).toBe(true);
    expect(view.unavailableDecisions.map((row) => row.agent).sort()).toEqual(["EXECUTOR", "PULSE"]);
    expect(view.unavailableDecisions.every((row) => row.reason === "UPDATED_AFTER_ASOF")).toBe(true);
    expect(view.decisions.some((row) => row.agent === "EXECUTOR" || row.agent === "PULSE")).toBe(false);
    expect(JSON.stringify(view)).not.toContain("REJECT");
    expect(JSON.stringify(view)).not.toContain("RAW_REWRITE");
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
    // The stored snapshot, written before the rewrite, still shows what was known at the fill.
    if (executorBefore) expect(executorBefore.decision).not.toBe("REJECT");
  });

  it("rejects UPDATE, DELETE and TRUNCATE on TradeLotSnapshot", async () => {
    const row = await prisma.tradeLotSnapshot.findFirstOrThrow({ where: { accountId: "primary" } });
    await expect(prisma.tradeLotSnapshot.update({ where: { id: row.id }, data: { viewHash: "tampered" } })).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "TradeLotSnapshot" SET "phase" = 'EXIT' WHERE "id" = $1`, row.id)).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.tradeLotSnapshot.delete({ where: { id: row.id } })).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "TradeLotSnapshot"`)).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "TradeLotSnapshot"`)).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    expect((await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { id: row.id } })).viewHash).toBe(row.viewHash);
  });

  it("writes an EXIT snapshot for a reducing fill, bounded by the exit fill time", async () => {
    const entry = await prisma.fill.findFirstOrThrow({ where: { order: { cycleId, side: "BUY" } }, include: { order: true } });
    const exitAt = new Date(Date.now() + 1000);
    const order = await prisma.order.create({
      data: {
        clientOrderId: `coid_a09_exit_${RUN}`, cycleId, accountId: "primary", pairAddress, baseSymbol: entry.order.baseSymbol, side: "SELL", intent: "EXIT",
        status: "FILLED", qty: entry.qty, filledQty: entry.qty, reasonCodes: ["STOP_LOSS", "FILLED"], ownerScope: "PROTECTION", createdAt: exitAt,
      },
    });
    const exitFill = await prisma.fill.create({
      data: { orderId: order.id, pairAddress, side: "SELL", qty: entry.qty, priceUsd: "99", notionalUsd: "1", feeUsd: "0.01", slippageBps: "10", liquidityUsd: "1000000", createdAt: exitAt },
    });
    await persistTradeLotSnapshots(prisma, { accountId: "primary", now: settledNow() });
    const snapshot = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: exitFill.id } });
    expect(snapshot.phase).toBe("EXIT");
    expect(snapshot.eventKind).toBe("EXIT");
    expect(snapshot.entryFillId).toBe(entry.id);
    const view = snapshot.view as unknown as PointInTimeView;
    expect(view.order.exitReason).toEqual({ code: "STOP_LOSS", source: "REASON_CODE" });
    expect(view.order.reasonCodesSource).toBe("ORDER_CURRENT_STATE"); // not in any plan: labelled as current state
    expect(view.excursionToDate).not.toBeNull();
    expect(view.excursionTruncated).toBe(false);
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
  });

  it("does not stall behind 200+ orphan sells: they get SKIPPED markers and the later entry is written (review M1)", async () => {
    const account = `acct_a09_orphans_${RUN}`;
    const sides: Array<"BUY" | "SELL"> = [...Array.from({ length: 205 }, () => "SELL" as const), "BUY"];
    const ids = await seedFills(prisma, account, "pairOrphans", sides, Date.now() - 3_600_000);
    const first = await persistTradeLotSnapshots(prisma, { accountId: account, now: settledNow() });
    expect(first).toMatchObject({ candidates: 200, written: 200, snapshots: 0 });
    expect(first.skipped.ORPHAN_SELL).toBe(200);
    const second = await persistTradeLotSnapshots(prisma, { accountId: account, now: settledNow() });
    expect(second).toMatchObject({ candidates: 6, written: 6, snapshots: 1 });
    expect(second.skipped.ORPHAN_SELL).toBe(5);
    const entry = await prisma.tradeLotSnapshot.findUniqueOrThrow({ where: { fillId: ids.at(-1)! } });
    expect(entry.phase).toBe("ENTRY");
    const markers = await prisma.tradeLotSnapshot.count({ where: { accountId: account, phase: "SKIPPED", eventKind: "ORPHAN_SELL" } });
    expect(markers).toBe(205);
    expect((await persistTradeLotSnapshots(prisma, { accountId: account, now: settledNow() })).candidates).toBe(0);
  });

  it("drains a backlog past the batch size, oldest first, with nothing abandoned (review M1)", async () => {
    const account = `acct_a09_backlog_${RUN}`;
    const sides = Array.from({ length: 210 }, (_, index) => (index % 2 === 0 ? ("BUY" as const) : ("SELL" as const)));
    await seedFills(prisma, account, "pairBacklog", sides, Date.now() - 7_200_000);
    const first = await persistTradeLotSnapshots(prisma, { accountId: account, now: settledNow() });
    expect(first).toMatchObject({ candidates: 200, written: 200, snapshots: 200 });
    const second = await persistTradeLotSnapshots(prisma, { accountId: account, now: settledNow() });
    expect(second).toMatchObject({ candidates: 10, written: 10, snapshots: 10 });
    const phases = await prisma.tradeLotSnapshot.groupBy({ by: ["phase"], where: { accountId: account }, _count: { _all: true } });
    expect(Object.fromEntries(phases.map((row) => [row.phase, row._count._all]))).toEqual({ ENTRY: 105, EXIT: 105 });
  });

  it("marks every candidate of a pair over the fill cap as PAIR_FILL_CAP_EXCEEDED and reports it (review M1)", async () => {
    const account = `acct_a09_cap_${RUN}`;
    await seedFills(prisma, account, "pairCap", ["BUY", "SELL", "BUY", "SELL"], Date.now() - 3_600_000);
    const capped = await persistTradeLotSnapshots(prisma, { accountId: account, now: settledNow(), maxPairFills: 3 });
    expect(capped).toMatchObject({ candidates: 4, written: 4, snapshots: 0 });
    expect(capped.skipped.PAIR_FILL_CAP_EXCEEDED).toBe(4);
    expect(await prisma.tradeLotSnapshot.count({ where: { accountId: account, phase: "SKIPPED", eventKind: "PAIR_FILL_CAP_EXCEEDED" } })).toBe(4);
  });

  it("writes only the requested account's fills (multi-account isolation)", async () => {
    const a = `acct_a09_iso_a_${RUN}`;
    const b = `acct_a09_iso_b_${RUN}`;
    const aIds = await seedFills(prisma, a, "pairShared", ["BUY", "SELL"], Date.now() - 3_600_000);
    const bIds = await seedFills(prisma, b, "pairShared", ["BUY", "BUY", "SELL"], Date.now() - 3_600_000);
    const result = await persistTradeLotSnapshots(prisma, { accountId: a, now: settledNow() });
    expect(result.candidates).toBe(2);
    expect(await prisma.tradeLotSnapshot.count({ where: { fillId: { in: bIds } } })).toBe(0);
    const rows = await prisma.tradeLotSnapshot.findMany({ where: { fillId: { in: aIds } } });
    expect(rows.map((row) => row.accountId)).toEqual([a, a]);
    // B's second BUY is an ADD only within B's own sequence; A's fills on the same pair never interleave.
    await persistTradeLotSnapshots(prisma, { accountId: b, now: settledNow() });
    const bRows = await prisma.tradeLotSnapshot.findMany({ where: { fillId: { in: bIds } }, orderBy: { asOf: "asc" } });
    // Position 2 after the two buys, so the sell of 1 is a REDUCE (stored in phase EXIT).
    expect(bRows.map((row) => [row.accountId, row.eventKind, row.phase])).toEqual([[b, "ENTRY", "ENTRY"], [b, "ADD", "ADD"], [b, "REDUCE", "EXIT"]]);
  });
});
