import { readFileSync } from "node:fs";
import { builtinArtifactIdentity } from "@odin/agent-core";
import {
  buildExperimentReport,
  finaliseEvaluation,
  EVALUATION_PROTOCOLS,
} from "@odin/evolution";
import { DEFAULT_STRATEGY, configHashOf, parseStrategyConfig } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { EvolutionService } from "./evolution.service.js";

const identity = builtinArtifactIdentity("pulse-momentum-v1")!;
const sourceHash = identity.sourceHash;
const artifactHash = identity.artifactHash;

function promotedConfig(entryM5ChangePct = "3") {
  return parseStrategyConfig({ ...DEFAULT_STRATEGY, entryM5ChangePct });
}

function buildValidatedFixtures(entryM5ChangePct = "3") {
  const config = promotedConfig(entryM5ChangePct);
  const configHash = configHashOf(config);
  const hypothesisId = "hyp_promote";
  const reportId = "rpt_bound";
  const artifactId = "art_pulse";
  const approvalId = "appr_1";
  const createdAt = new Date("2026-10-28T19:00:00.000Z");
  const executable = {
    kind: "BUILTIN_MODULE" as const,
    moduleRef: identity.moduleRef,
    moduleVersion: identity.moduleVersion,
    sourceHash: identity.sourceHash,
    artifactHash: identity.artifactHash,
    runtimeLoadable: true,
  };
  const evaluation = finaliseEvaluation(
    {
      protocol: EVALUATION_PROTOCOLS.PIPELINE_SANDBOX_V1,
      config,
      configHash,
      dataset: {
        id: "ds_fixture",
        hash: "dataset-hash-fixture",
        basis: "fixture",
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-31T00:00:00.000Z",
        observationCount: 100,
      },
      partitions: [
        {
          name: "FULL",
          startAt: "2026-01-01T00:00:00.000Z",
          endAt: "2026-01-31T00:00:00.000Z",
          measured: true,
          sampleSize: 40,
          returnPct: "1.50",
          maxDrawdownPct: "4",
        },
        {
          name: "TEST",
          startAt: "2026-01-20T00:00:00.000Z",
          endAt: "2026-01-31T00:00:00.000Z",
          measured: true,
          sampleSize: 30,
          returnPct: "1.10",
          maxDrawdownPct: "3",
        },
      ],
      minSampleSize: 30,
      tuning: {
        parameterTrials: 1,
        tunedOnEvaluationSample: false,
        basis: "single candidate",
        history: [],
      },
      costs: {
        feeBps: config.feeBps,
        slippageModel: "fixture",
        latencyMs: config.paperLatencyMs,
      },
      forwardPaper: {
        status: "RECORDED",
        resultIds: ["fwd_1"],
        closedTradeCount: 30,
        returnPct: "0.80",
      },
    },
    executable,
  );
  expect(evaluation.provenance).toBe("COMPLETE");
  const report = buildExperimentReport({
    reportId,
    hypothesisId,
    strategyModuleId: "strat_from_report",
    strategyVersion: "2.0.0",
    models: [],
    datasetManifest: {
      observationCount: 100,
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-31T00:00:00.000Z",
      sources: ["fixture"],
      contentHash: "dataset-hash-fixture",
    },
    periods: { train: null, validation: null, test: "2026-01-20T00:00:00.000Z" },
    results: {
      sampleSize: 40,
      returnPct: "1.50",
      maxDrawdownPct: "4",
      releaseGateLabel: "PROMOTION_REVIEW",
    },
    uncertainty: [],
    weaknesses: [],
    challenge: { passed: true, summary: "ok", findings: [], reviewer: "CHALLENGE", independent: true },
    approval: { status: "APPROVED", approvedBy: "operator@odin.local", approvedAt: createdAt.toISOString() },
    reproducibility: { codeHash: sourceHash, configHash, seed: null },
    evaluation,
    executable,
  });
  expect(report.contentHash).not.toBe(artifactHash);

  const artifact = {
    id: artifactId,
    kind: "BUILTIN_MODULE",
    moduleRef: identity.moduleRef,
    moduleVersion: identity.moduleVersion,
    sourceHash: identity.sourceHash,
    artifactHash: identity.artifactHash,
    runtimeLoadable: true,
  };
  const approval = {
    id: approvalId,
    reportId,
    reportContentHash: report.contentHash,
    artifactId,
    artifactHash: identity.artifactHash,
    sourceHash: identity.sourceHash,
    configHash,
    decision: "APPROVED",
    reviewer: "operator@odin.local",
    createdAt,
  };
  const hypothesis = {
    id: hypothesisId,
    status: "PROPOSED",
    parameterPatch: {},
    rationale: "fixture",
    createdAt,
  };
  const reportRow = {
    id: reportId,
    payload: report,
    contentHash: report.contentHash,
    signature: report.signature,
    createdAt,
  };
  return { config, configHash, report, reportRow, artifact, approval, hypothesis, reportId, artifactId, approvalId };
}

function mockPrisma(seed: ReturnType<typeof buildValidatedFixtures>, options?: { missingReport?: boolean }) {
  let row: { id: string; config: unknown; activeStrategy: unknown; runtimeState?: unknown } = {
    id: "primary",
    config: { ...DEFAULT_STRATEGY },
    activeStrategy: null,
    runtimeState: {},
  };
  const promotions: unknown[] = [];
  const updates: unknown[] = [];
  const prisma = {
    engineControl: {
      findUnique: async () => row,
      update: async (input: { data: { config: unknown; activeStrategy: unknown; updatedBy?: string; runtimeState?: unknown } }) => {
        updates.push(input.data);
        row = {
          id: "primary",
          config: input.data.config,
          activeStrategy: input.data.activeStrategy,
          runtimeState: input.data.runtimeState ?? row.runtimeState,
        };
        return row;
      },
    },
    experimentReport: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        options?.missingReport || where.id !== seed.reportId ? null : seed.reportRow,
    },
    strategyArtifact: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === seed.artifactId ? seed.artifact : null,
    },
    promotionApproval: {
      findMany: async ({ where }: { where: { reportId: string } }) =>
        where.reportId === seed.reportId ? [seed.approval] : [],
    },
    researchProposal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === seed.hypothesis.id ? seed.hypothesis : null,
    },
    strategyPromotion: {
      findFirst: async () => null,
      create: async (input: { data: Record<string, unknown> }) => {
        promotions.push(input.data);
        return input.data;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, getRow: () => row, updates, promotions };
}

describe("paper engine promotion write", () => {
  it("updates EngineControl primary after VALIDATED promotion and refuses rejected validation", async () => {
    const seed = buildValidatedFixtures("3");
    const { prisma, getRow, updates, promotions } = mockPrisma(seed);
    const service = new EvolutionService(prisma);

    const refused = await service
      .promotePaperStrategy(
        { authorised: true, reportId: "rpt_missing", artifactId: seed.artifactId, config: seed.config },
        "operator@odin.local",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
    expect(promotions).toHaveLength(0);

    const applied = await service.promotePaperStrategy(
      {
        authorised: true,
        reportId: seed.reportId,
        artifactId: seed.artifactId,
        approvalId: seed.approvalId,
        config: seed.config,
      },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);
    expect(applied.deploymentEligible).toBe(true);
    expect(applied.validatedPromotion).toBe(true);
    expect(updates).toHaveLength(1);
    expect(promotions).toHaveLength(1);
    expect(getRow().config).toMatchObject({ entryM5ChangePct: "3" });
    expect(getRow().activeStrategy).toMatchObject({
      strategyId: "strat_from_report",
      strategyVersion: "2.0.0",
      sourceHash,
      artifactHash,
      mode: "VALIDATED",
      deploymentEligible: true,
      reportId: seed.reportId,
      artifactId: seed.artifactId,
      approvalId: seed.approvalId,
    });
  });

  it("rejects a model-labelled or evidence-only request body before it can write the engine", async () => {
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
          evidence: { strategyId: "x" },
          config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "3" },
        },
        "operator@odin.local",
      ),
    ).rejects.toThrow();
    await expect(
      service.promotePaperStrategy(
        {
          authorised: true,
          mode: "UNVALIDATED_PAPER_EXPERIMENT",
          artifactId: "art_pulse",
          config: { ...DEFAULT_STRATEGY },
          label: "experiment",
          rationale: "labelled paper only",
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
    expect(controller).toMatch(/@Post\("promote\/unvalidated"\)/);
    expect(controller).not.toMatch(/submitOrder|api\.binance|jup\.ag\/swap/);
  });

  it("refuses promotion when reportId is present but the report is missing", async () => {
    const seed = buildValidatedFixtures();
    const { prisma, updates } = mockPrisma(seed, { missingReport: true });
    const service = new EvolutionService(prisma);
    await expect(
      service.promotePaperStrategy(
        {
          authorised: true,
          reportId: "rpt_missing",
          artifactId: seed.artifactId,
          config: seed.config,
        },
        "operator@odin.local",
      ),
    ).rejects.toThrow(/REPORT_PERSISTED|rejected|ExperimentReport/i);
    expect(updates).toHaveLength(0);
  });

  it("resolves persisted report/artifact/approval server-side (no client evidence)", async () => {
    const seed = buildValidatedFixtures("4");
    const { prisma, getRow } = mockPrisma(seed);
    const service = new EvolutionService(prisma);
    const applied = await service.promotePaperStrategy(
      {
        authorised: true,
        reportId: seed.reportId,
        artifactId: seed.artifactId,
        config: seed.config,
      },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);
    expect(getRow().activeStrategy).toMatchObject({
      strategyId: "strat_from_report",
      strategyVersion: "2.0.0",
      sourceHash,
      artifactHash,
      mode: "VALIDATED",
      deploymentEligible: true,
    });
    expect(artifactHash).not.toBe(seed.report.contentHash);
  });

  it("applies an unvalidated paper experiment without deployment eligibility", async () => {
    const seed = buildValidatedFixtures();
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
      strategyArtifact: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === seed.artifactId ? seed.artifact : null,
      },
      strategyPromotion: {
        findFirst: async () => null,
        create: async (input: { data: Record<string, unknown> }) => input.data,
      },
    } as unknown as PrismaClient;
    const service = new EvolutionService(prisma);
    const applied = await service.applyUnvalidatedPaperExperiment(
      {
        authorised: true,
        mode: "UNVALIDATED_PAPER_EXPERIMENT",
        artifactId: seed.artifactId,
        config: seed.config,
        label: "labelled experiment",
        rationale: "explicit paper-only trial",
      },
      "operator@odin.local",
    );
    expect(applied.appliedToPaperEngine).toBe(true);
    expect(applied.deploymentEligible).toBe(false);
    expect(applied.validatedPromotion).toBe(false);
    expect(row.activeStrategy).toMatchObject({
      mode: "UNVALIDATED_PAPER_EXPERIMENT",
      deploymentEligible: false,
      artifactId: seed.artifactId,
    });
  });
});
