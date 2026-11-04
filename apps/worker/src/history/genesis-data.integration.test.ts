import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { barHash, datasetQuality, datasetVersionHash, listDatasetsForQuality } from "@odin/market-data";
import { INTEGRATION_TEST_ADVISORY_LOCK } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import { loadOpportunityWindow } from "./opportunity-loader.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const H = 3_600_000;
const RUN = `gen3_${Date.now().toString(36)}`;
const T0 = Date.UTC(2001, 0, 1, 12);

/** GENESIS Phase 3: the quality report and the opportunity loader read the real schema, read-only. */
describe.skipIf(!enabled)("GENESIS data quality + opportunity history (Postgres)", () => {
  let prisma: PrismaClient;
  let datasetId = "";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    // Warehouse rows are append-only by trigger, so this run uses its own instrument key and leaves them.
    const pool = `${RUN}_POOL`;
    const dataset = await prisma.historicalDataset.create({
      data: { sourceId: "geckoterminal", instrumentKey: pool, instrumentKind: "SOLANA_POOL", cohort: "SPECULATIVE_SOLANA", interval: "1h", licence: { provider: "test" } },
    });
    datasetId = dataset.id;
    const bars = [0, 1, 2, 5, 6, 7, 8, 9, 10].map((i) => {
      const close = (1 + i / 100).toString();
      return { openTime: T0 + i * H, availableAt: T0 + (i + 1) * H, open: close, high: close, low: close, close, volume: "5" };
    });
    await prisma.historicalBar.createMany({
      data: bars.map((b) => ({ datasetId, openTime: new Date(b.openTime), availableAt: new Date(b.availableAt), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, hash: barHash(b), collectedAt: new Date(T0 + 20 * H) })),
    });
    const stored = await prisma.historicalBar.findMany({ where: { datasetId }, orderBy: { openTime: "asc" } });
    const versionHash = datasetVersionHash(stored.map((r) => ({ openTime: r.openTime.getTime(), availableAt: r.availableAt.getTime(), open: r.open.toString(), high: r.high.toString(), low: r.low.toString(), close: r.close.toString(), volume: r.volume?.toString() ?? null })));
    await prisma.historicalDataset.update({ where: { id: datasetId }, data: { versionHash, barCount: stored.length, firstOpenTime: stored[0]!.openTime, lastOpenTime: stored.at(-1)!.openTime } });
    await prisma.historicalBarRevision.create({ data: { datasetId, openTime: new Date(T0), previousHash: "a", newHash: "b", newValues: {} } });
    await prisma.historicalBarRejection.createMany({ data: [{ datasetId, openTime: new Date(T0 + 3 * H), reason: "NON_POSITIVE" }, { datasetId, openTime: new Date(T0 + 4 * H), reason: "NON_POSITIVE" }] });

    const cycleId = `${RUN}_c1`;
    const t = (s: number) => new Date(T0 + 4 * H + s * 1000);
    await prisma.cycleRun.create({ data: { id: cycleId, trigger: "test", status: "COMPLETED", stage: "DONE", dataState: "LIVE", startedAt: t(0), accountId: `${RUN}_acct`, tradingEnvironment: "PAPER", dataMode: "live" } });
    await prisma.opportunityFunnelEvent.createMany({
      data: [
        { accountId: `${RUN}_acct`, cycleId, pairAddress: pool, stage: "DISCOVERED", reasonCodes: [], createdAt: t(5) },
        { accountId: `${RUN}_acct`, cycleId, pairAddress: pool, stage: "REJECTED", reasonCodes: ["MIN_LIQUIDITY"], createdAt: t(5) },
      ],
    });
    await prisma.agentDecision.create({
      data: { id: `${RUN}_d1`, cycleId, agent: "ATLAS", modelVersion: "atlas@1", pairAddress: pool, decision: "REJECT", confidence: "1", reasonCodes: ["MIN_LIQUIDITY"], input: { liquidityUsd: "1000", laterAt: new Date(T0 + 30 * H).toISOString() }, output: {}, createdAt: t(3), updatedAt: t(3) },
    });
    await prisma.tradeIntent.create({
      data: { id: `${RUN}_i1`, idempotencyKey: `${RUN}_k1`, cycleId, accountId: `${RUN}_acct`, tradingEnvironment: "PAPER", source: "STRATEGY", instrumentId: pool, pairAddress: pool, action: "ENTER", side: "BUY", reasonCodes: ["MIN_LIQUIDITY"], status: "REJECTED", statusReason: "MIN_LIQUIDITY", createdAt: t(4), updatedAt: t(4) },
    });
  });

  afterAll(async () => {
    await prisma.tradeIntent.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.agentDecision.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.opportunityFunnelEvent.deleteMany({ where: { cycleId: { startsWith: RUN } } });
    await prisma.cycleRun.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it("reports coverage, gaps, revisions, rejections and a hash equal to the stored version", async () => {
    const report = await datasetQuality(prisma, datasetId, new Date(T0 + 12 * H));
    expect(report).not.toBeNull();
    expect(report!.coverage).toMatchObject({ actualBars: 9, expectedBars: 11, missingBars: 2 });
    expect(report!.gaps.byClass.NO_TRADE_LIKELY).toEqual({ count: 1, missingBars: 2 });
    expect(report!.revisions).toBe(1);
    expect(report!.rejections).toEqual({ total: 2, byReason: { NON_POSITIVE: 2 } });
    expect(report!.versionHashMatches).toBe(true);
    // A window is applied in the query: only bars 5..7 are read, and the partial hash is not compared.
    const windowed = await datasetQuality(prisma, datasetId, new Date(T0 + 12 * H), { window: { fromOpenTime: T0 + 5 * H, toOpenTime: T0 + 7 * H } });
    expect(windowed!.coverage).toMatchObject({ actualBars: 3, expectedBars: 3, missingBars: 0 });
    expect(windowed!.versionHashMatches).toBeNull();
    const listing = await listDatasetsForQuality(prisma, new Date(T0 + 12 * H));
    expect(listing.datasets.some((d) => d.id === datasetId)).toBe(true);
  });

  it("loads a bounded window into point-in-time rows with HYPOTHETICAL counterfactuals", async () => {
    const rows = await loadOpportunityWindow(prisma, { from: new Date(T0), to: new Date(T0 + 24 * H), accountId: `${RUN}_acct`, counterfactualHorizonsMs: [H, 2 * H] });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ outcome: "REJECTED", stages: ["DISCOVERED", "REJECTED"], reasonCodes: ["MIN_LIQUIDITY"], tradingEnvironment: "PAPER" });
    expect(row.agents.ATLAS!.features.input).toEqual({ liquidityUsd: "1000" });
    expect(row.excluded.map((e) => e.reason)).toContain("FUTURE_TIMESTAMP");
    expect(row.intents[0]).toMatchObject({ status: "REJECTED" });
    expect(row.hypothetical).toMatchObject({ label: "HYPOTHETICAL", datasetId, referenceClose: "1.02" });
    // Decision at 04:00:05 (bar 2 closed at 03:00). Bars 3 and 4 are a no-trade gap, so +1h has no newer
    // close (null, not an assumed flat price); +2h reaches bar 5, which closed at 06:00.
    expect(row.hypothetical!.horizons[0]).toMatchObject({ exitClose: null, forwardReturn: null, reason: "NO_FORWARD_BAR" });
    expect(row.hypothetical!.horizons[1]).toMatchObject({ exitClose: "1.05" });
  });
});
