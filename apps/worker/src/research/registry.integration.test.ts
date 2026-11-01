import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@odin/shared/db";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/** ASCEND-03: research evidence is append-only, and a holdout can be consumed once per strategy version. */
describe.skipIf(!enabled)("research registry (Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641102)`;
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "ResearchTrial", "ResearchRun", "ResearchHoldoutAccess" CASCADE`);
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641102)`;
    await prisma.$disconnect();
  });

  it("keeps runs and trials immutable, failures included", async () => {
    const run = await prisma.researchRun.create({
      data: { datasetId: "ds", datasetVersion: "v", codeVersion: "c", strategyId: "tsmom", strategyVersion: "1.0.0", family: "TREND", config: {}, verdict: "REJECTED_OVERFIT", reasons: ["DSR < 0.95"], evidence: "VERIFIED_HISTORICAL", summary: {} },
    });
    await prisma.researchTrial.create({ data: { runId: run.id, window: "TRAIN", fold: 1, params: { lookback: 24 }, startT: new Date(0), endT: new Date(1), bars: 100, trades: 3, netReturn: -0.02 } });
    await expect(prisma.researchRun.update({ where: { id: run.id }, data: { verdict: "VALIDATED_CANDIDATE" } })).rejects.toThrow(/append-only/);
    await expect(prisma.researchTrial.deleteMany({ where: { runId: run.id } })).rejects.toThrow(/append-only/);
  });

  it("refuses a second holdout evaluation of the same strategy version and dataset", async () => {
    await prisma.researchHoldoutAccess.create({ data: { strategyId: "tsmom", strategyVersion: "1.0.0", datasetId: "ds", runId: "r1" } });
    await expect(prisma.researchHoldoutAccess.create({ data: { strategyId: "tsmom", strategyVersion: "1.0.0", datasetId: "ds", runId: "r2" } })).rejects.toThrow();
    await expect(prisma.researchHoldoutAccess.create({ data: { strategyId: "tsmom", strategyVersion: "1.1.0", datasetId: "ds", runId: "r3" } })).resolves.toBeTruthy();
  });
});
