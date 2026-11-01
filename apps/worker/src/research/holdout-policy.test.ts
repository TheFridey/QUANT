import { describe, expect, it } from "vitest";
import { holdoutAvailable } from "./holdout-policy.js";

type Access = { strategyId: string; datasetId: string };

function fake(datasets: Array<{ id: string; instrumentKey: string; interval: string }>, accesses: Access[]) {
  return {
    historicalDataset: {
      findMany: async ({ where }: { where: { instrumentKey: string; interval: string } }) => datasets.filter((d) => d.instrumentKey === where.instrumentKey && d.interval === where.interval).map((d) => ({ id: d.id })),
    },
    researchHoldoutAccess: {
      findFirst: async ({ where }: { where: { strategyId: string; datasetId: { in: string[] } } }) => accesses.find((a) => a.strategyId === where.strategyId && where.datasetId.in.includes(a.datasetId)) ?? null,
    },
  } as unknown as Parameters<typeof holdoutAvailable>[0];
}

describe("holdout policy (SINGULARITY-00)", () => {
  const datasets = [
    { id: "sol-v1", instrumentKey: "SOLPOOL", interval: "1h" },
    { id: "sol-v2", instrumentKey: "SOLPOOL", interval: "1h" },
    { id: "sol-5m", instrumentKey: "SOLPOOL", interval: "5m" },
  ];

  it("blocks a version bump or a re-imported dataset from re-reading the same instrument's holdout", async () => {
    const prisma = fake(datasets, [{ strategyId: "tsmom", datasetId: "sol-v1" }]);
    expect(await holdoutAvailable(prisma, { strategyId: "tsmom", instrumentKey: "SOLPOOL", interval: "1h" })).toBe(false);
  });

  it("leaves other strategies, intervals and instruments untouched", async () => {
    const prisma = fake(datasets, [{ strategyId: "tsmom", datasetId: "sol-v1" }]);
    expect(await holdoutAvailable(prisma, { strategyId: "ma_trend", instrumentKey: "SOLPOOL", interval: "1h" })).toBe(true);
    expect(await holdoutAvailable(prisma, { strategyId: "tsmom", instrumentKey: "SOLPOOL", interval: "5m" })).toBe(true);
    expect(await holdoutAvailable(prisma, { strategyId: "tsmom", instrumentKey: "OTHER", interval: "1h" })).toBe(true);
  });
});
