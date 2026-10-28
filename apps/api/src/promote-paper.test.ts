import { readFileSync } from "node:fs";
import { DEFAULT_STRATEGY } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { describe, expect, it } from "vitest";
import { EvolutionService } from "./evolution.service.js";

const sourceHash = "a".repeat(64);
const artifactHash = "b".repeat(64);

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    strategyId: "strat_reviewed",
    strategyVersion: "1.0.0",
    sourceHash,
    artifactHash,
    artifactSourceHash: sourceHash,
    approvalStatus: "APPROVED",
    reviewed: true,
    pipelineFinished: true,
    experimentExecuted: true,
    returnPct: "1.50",
    sampleSize: 40,
    minSampleSize: 30,
    statisticsRecorded: true,
    untouchedTestReturnPct: "1.10",
    untouchedSampleSize: 30,
    tunedOnEvaluationSample: false,
    forwardPaperValidated: true,
    ...overrides,
  };
}

describe("paper engine promotion write", () => {
  it("updates EngineControl primary and leaves it unchanged when promotion is refused", async () => {
    const updates: unknown[] = [];
    let row: { id: string; config: unknown; activeStrategy: unknown } = {
      id: "primary",
      config: { ...DEFAULT_STRATEGY },
      activeStrategy: null,
    };
    const prisma = {
      engineControl: {
        findUnique: async () => row,
        update: async (input: { data: { config: unknown; activeStrategy: unknown; updatedBy: string } }) => {
          updates.push(input.data);
          row = { id: "primary", config: input.data.config, activeStrategy: input.data.activeStrategy };
          return row;
        },
      },
    } as unknown as PrismaClient;
    const service = new EvolutionService(prisma);
    const config = { ...DEFAULT_STRATEGY, entryM5ChangePct: "3" };
    const refused = await service.promotePaperStrategy(
      { authorised: true, evidence: evidence({ reviewed: false, approvalStatus: "PENDING" }), config },
      "operator@odin.local",
    );
    expect(refused.appliedToPaperEngine).toBe(false);
    expect(refused.deploymentEligible).toBe(false);
    expect(updates).toHaveLength(0);
    expect(row.config).toMatchObject({ entryM5ChangePct: "2" });

    const applied = await service.promotePaperStrategy(
      { authorised: true, evidence: evidence(), config },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);
    expect(applied.deploymentEligible).toBe(true);
    expect(updates).toHaveLength(1);
    expect(row.config).toMatchObject({ entryM5ChangePct: "3" });
    expect(row.activeStrategy).toMatchObject({
      strategyId: "strat_reviewed",
      strategyVersion: "1.0.0",
      sourceHash,
      artifactHash,
    });

    const later = await service.promotePaperStrategy(
      {
        authorised: true,
        evidence: evidence({ reviewed: false, approvalStatus: "PENDING", strategyVersion: "9.9.9" }),
        config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "9" },
      },
      "operator@odin.local",
    );
    expect(later.appliedToPaperEngine).toBe(false);
    expect(updates).toHaveLength(1);
    expect(row.config).toMatchObject({ entryM5ChangePct: "3" });
  });

  it("rejects a model-labelled request body before it can write the engine", async () => {
    const prisma = {
      engineControl: {
        findUnique: async () => {
          throw new Error("engine should not be read");
        },
        update: async () => {
          throw new Error("engine should not be written");
        },
      },
    } as unknown as PrismaClient;
    const service = new EvolutionService(prisma);
    await expect(
      service.promotePaperStrategy(
        {
          authorised: true,
          caller: "MODEL",
          evidence: evidence(),
          config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "3" },
        },
        "operator@odin.local",
      ),
    ).rejects.toThrow();
  });

  it("does not submit a broker order from the promotion route", () => {
    const service = readFileSync(new URL("./evolution.service.ts", import.meta.url), "utf8");
    const controller = readFileSync(new URL("./evolution.controller.ts", import.meta.url), "utf8");
    expect(service).not.toMatch(/submitOrder|placeOrder|api\.binance|jup\.ag\/swap/);
    expect(controller).toMatch(/@Post\("promote"\)/);
    expect(controller).not.toMatch(/submitOrder|api\.binance|jup\.ag\/swap/);
  });
});