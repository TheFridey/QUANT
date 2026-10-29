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

  it("refuses promotion when reportId is present but the report is missing (D13)", async () => {
    const prisma = {
      engineControl: {
        findUnique: async () => ({
          id: "primary",
          config: { ...DEFAULT_STRATEGY },
          activeStrategy: null,
        }),
        update: async () => {
          throw new Error("engine should not be written");
        },
      },
      experimentReport: {
        findUnique: async () => null,
      },
    } as unknown as PrismaClient;
    const service = new EvolutionService(prisma);
    await expect(
      service.promotePaperStrategy(
        {
          authorised: true,
          reportId: "rpt_missing",
          evidence: evidence(),
          config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "3" },
        },
        "operator@odin.local",
      ),
    ).rejects.toThrow(/rpt_missing|not a persisted ExperimentReport/i);
  });

  it("resolves persisted report evidence server-side and ignores forged client hashes (D13)", async () => {
    const { buildExperimentReport } = await import("@odin/evolution");
    const report = buildExperimentReport({
      reportId: "rpt_bound",
      hypothesisId: "hyp1",
      strategyModuleId: "strat_from_report",
      strategyVersion: "2.0.0",
      models: [],
      datasetManifest: {
        observationCount: 50,
        startAt: null,
        endAt: null,
        sources: ["fixture"],
        contentHash: "d".repeat(64),
      },
      periods: { train: null, validation: null, test: null },
      results: {
        sampleSize: 40,
        returnPct: "1.50",
        maxDrawdownPct: "3",
        releaseGateLabel: "PROMOTION_REVIEW",
      },
      uncertainty: [],
      weaknesses: [],
      challenge: { passed: true, summary: "ok", findings: [], reviewer: "CHALLENGE", independent: true },
      approval: { status: "APPROVED", approvedBy: "operator@odin.local", approvedAt: "2026-10-28T19:00:00.000Z" },
      reproducibility: { codeHash: sourceHash, configHash: "e".repeat(64), seed: null },
      outcomes: {
        PIPELINE_COMPLETED: { met: true, detail: "ok" },
        EXPERIMENT_EXECUTED: { met: true, detail: "ok" },
        RESULTS_MEASURABLE: { met: true, detail: "ok" },
        STATISTICALLY_EVALUATED: { met: true, detail: "ok" },
        OUT_OF_SAMPLE_VALIDATED: { met: true, detail: "ok" },
        FORWARD_PAPER_VALIDATED: { met: true, detail: "ok" },
        DEPLOYMENT_ELIGIBLE: { met: true, detail: "ok" },
      },
    });
    let row: { id: string; config: unknown; activeStrategy: unknown } = {
      id: "primary",
      config: { ...DEFAULT_STRATEGY },
      activeStrategy: null,
    };
    const prisma = {
      engineControl: {
        findUnique: async () => row,
        update: async (input: { data: { config: unknown; activeStrategy: unknown } }) => {
          row = { id: "primary", config: input.data.config, activeStrategy: input.data.activeStrategy };
          return row;
        },
      },
      experimentReport: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === "rpt_bound"
            ? {
                id: "rpt_bound",
                payload: report,
                contentHash: report.contentHash,
                signature: report.signature,
              }
            : null,
      },
    } as unknown as PrismaClient;
    const service = new EvolutionService(prisma);
    const applied = await service.promotePaperStrategy(
      {
        authorised: true,
        reportId: "rpt_bound",
        // Forged client identity — must be ignored in favour of the persisted report.
        evidence: evidence({ strategyId: "forged_client", strategyVersion: "9.9.9", artifactHash: "f".repeat(64) }),
        config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "4" },
      },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);
    expect(row.activeStrategy).toMatchObject({
      strategyId: "strat_from_report",
      strategyVersion: "2.0.0",
      sourceHash,
      artifactHash: report.contentHash,
    });
  });
});