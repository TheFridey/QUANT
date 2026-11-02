import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvolutionService } from "./evolution.service.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/**
 * APEX D-01: the research model budget must be cumulative. Before the fix every pipeline request
 * built a router with an empty in-memory store, so each request could spend the whole cap again,
 * and Model Ops always showed $0 spent against the default $5 cap, not the operator's cap.
 */
describe.skipIf(!enabled)("research model budget is read from the durable usage log", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "ModelUsageLog" RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "ModelUsageLog" RESTART IDENTITY CASCADE`);
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  const row = (id: string, costUsdEst: string, createdAt: Date) => ({
    id,
    agentOrTask: "FORGE",
    endpointId: "openai-primary",
    provider: "fixture",
    model: "FIXTURE",
    tier: "ENGINEERING_AGENTS",
    ok: true,
    latencyMs: 1,
    promptTokensEst: 10,
    completionTokensEst: 10,
    costUsdEst,
    createdAt,
  });

  it("sums only the current UTC day and shows the operator's cap", async () => {
    const service = new EvolutionService(prisma);
    await service.ensureSeeds();
    await service.setAutonomy({ level: 1, maxResearchBudgetUsd: "2" }, "operator@odin.local");
    const now = new Date();
    const yesterday = new Date(now.getTime() - 26 * 3_600_000);
    await prisma.modelUsageLog.createMany({
      data: [row("mul_old", "9.00000000", yesterday), row("mul_a", "0.75000000", now), row("mul_b", "0.50000000", now)],
    });

    const window = await service.researchBudgetWindow(now);
    expect(window.spentUsd).toBe("1.25000000");

    const ops = await service.modelOps();
    expect(ops.budget.capUsd).toBe("2.0000");
    expect(ops.budget.spentUsd).toBe("1.25000000");
    expect(ops.budget.remainingUsd).toBe("0.75000000");
    expect(ops.budget.window).toBe("UTC_DAY");
  });

  it("shows zero remaining once the day's spend reaches the cap", async () => {
    const service = new EvolutionService(prisma);
    await prisma.modelUsageLog.create({ data: row("mul_c", "1.00000000", new Date()) });
    const ops = await service.modelOps();
    expect(ops.budget.remainingUsd).toBe("0.00000000");
  });

  it("refuses to store risk-limit mutation for research autonomy", async () => {
    const service = new EvolutionService(prisma);
    await expect(service.setAutonomy({ level: 2, allowRiskLimitMutation: true }, "operator@odin.local")).rejects.toThrow();
    await prisma.autonomyControl.update({ where: { id: "primary" }, data: { allowRiskLimitMutation: true } });
    expect((await service.getAutonomy()).allowRiskLimitMutation).toBe(false);
    await service.ensureSeeds();
    expect((await prisma.autonomyControl.findUniqueOrThrow({ where: { id: "primary" } })).allowRiskLimitMutation).toBe(false);
    await service.setAutonomy({ level: 1, maxResearchBudgetUsd: "5" }, "operator@odin.local");
  });
});
