import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureFoundation } from "./bootstrap.js";
import { PrismaClient, toJson } from "./db.js";
import { DEFAULT_STRATEGY } from "./strategy.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/** ASCEND-00 F6: every engine config write leaves an append-only revision, whatever path made it. */
describe.skipIf(!enabled)("engine config revision history (Postgres trigger)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    // TRUNCATE does not fire row triggers, so it can reset the append-only table between suites.
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "EngineConfigRevision", "EngineControl", "PaperAccount", "User" RESTART IDENTITY CASCADE`);
    await ensureFoundation(prisma, { email: "admin@odin.local", password: "odin-paper-dev", config: DEFAULT_STRATEGY });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("records the bootstrap insert, then each config change with its changed keys and actor", async () => {
    const created = await prisma.engineConfigRevision.findMany({ orderBy: { id: "asc" } });
    expect(created.map((row) => row.source)).toEqual(["INSERT"]);

    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { config: toJson({ ...DEFAULT_STRATEGY, minLiquidityUsd: "250000", maxDailyLossPct: "3" }), updatedBy: "operator@odin" },
    });
    const [latest] = await prisma.engineConfigRevision.findMany({ orderBy: { id: "desc" }, take: 1 });
    expect(latest?.source).toBe("UPDATE");
    expect(latest?.actor).toBe("operator@odin");
    expect(latest?.changedKeys).toEqual(["minLiquidityUsd"]);
    expect((latest?.previousConfig as Record<string, unknown>).minLiquidityUsd).toBe(DEFAULT_STRATEGY.minLiquidityUsd);
    expect((latest?.config as Record<string, unknown>).minLiquidityUsd).toBe("250000");
    const engine = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    expect(latest?.engineUpdatedAt.getTime()).toBe(engine.updatedAt.getTime());
  });

  it("does not record status, runtime-state or identical-config writes", async () => {
    const before = await prisma.engineConfigRevision.count();
    const engine = await prisma.engineControl.findUniqueOrThrow({ where: { id: "primary" } });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { status: "RUNNING", updatedBy: "resume" } });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { runtimeState: toJson({ fairnessCursor: "x" }) } });
    await prisma.engineControl.update({ where: { id: "primary" }, data: { config: toJson(engine.config) } });
    expect(await prisma.engineConfigRevision.count()).toBe(before);
  });

  it("rejects updates and deletes of a revision", async () => {
    const [row] = await prisma.engineConfigRevision.findMany({ take: 1 });
    await expect(
      prisma.engineConfigRevision.update({ where: { id: row!.id }, data: { actor: "tamper" } }),
    ).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
    await expect(prisma.engineConfigRevision.delete({ where: { id: row!.id } })).rejects.toThrow(/EVIDENCE_IMMUTABLE/);
  });
});
