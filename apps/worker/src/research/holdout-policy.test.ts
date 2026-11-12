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

describe("OPERATION INTEGRITY F03/F06: legacy CLI holdout and trial-count policy", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolvePriorTrials } = await import("./holdout-policy.js");
  const { runIntelligenceStudy } = await import("@odin/backtest");

  it("a supplied --prior-trials can raise but never lower the durable programme count", () => {
    expect(resolvePriorTrials(null, 120)).toEqual({ priorTrials: 120, source: "LEDGER", ignoredSupplied: null });
    expect(resolvePriorTrials(0, 120)).toEqual({ priorTrials: 120, source: "LEDGER", ignoredSupplied: 0 });
    expect(resolvePriorTrials(5, 120).priorTrials).toBe(120);
    expect(resolvePriorTrials(120, 120)).toEqual({ priorTrials: 120, source: "LEDGER", ignoredSupplied: null });
    expect(resolvePriorTrials(5_000, 120)).toEqual({ priorTrials: 5_000, source: "SUPPLIED_ABOVE_LEDGER", ignoredSupplied: null });
  });

  it("warehouse-mode HORIZON and ML CLIs resolve the count through the floor, not `??`", () => {
    for (const file of ["horizon-cli.ts", "ml-cli.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).toContain("resolvePriorTrials(args.priorTrials, await programmeTrialCount(prisma))");
      expect(source).not.toContain("args.priorTrials ?? (await programmeTrialCount(prisma))");
    }
  });

  it("the ASCEND and intelligence CLIs withhold every holdout instead of check-evaluate-record", () => {
    for (const file of ["research-cli.ts", "intelligence-cli.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).toContain("holdoutWithheld: true");
      expect(source).not.toMatch(/holdoutAvailable\(prisma/);
    }
  });

  it("a withheld intelligence study never evaluates a holdout window", () => {
    const bars = Array.from({ length: 1_500 }, (_, i) => {
      const close = 100 * Math.exp(0.0004 * i + 0.01 * Math.sin(i / 9));
      return { t: Date.UTC(2025, 0, 1) + i * 3_600_000, open: close, high: close * 1.002, low: close * 0.998, close, volume: 1_000 };
    });
    const study = runIntelligenceStudy({ bars, barMs: 3_600_000, costBpsPerSide: 5, periodsPerYear: 8_760, codeVersion: "test", holdoutWithheld: true, holdoutAvailable: () => true });
    for (const h of study.hypotheses) {
      expect(h.gated.trials.some((t) => t.window === "HOLDOUT")).toBe(false);
      expect(h.gated.holdout).toBeNull();
    }
  });
});
