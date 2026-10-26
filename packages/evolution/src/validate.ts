import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { ChallengeReport } from "./challenge.js";

export const experimentReportSchema = z
  .object({
    reportId: z.string().min(1),
    hypothesisId: z.string().min(1),
    strategyModuleId: z.string().min(1),
    strategyVersion: z.string().min(1),
    models: z.array(
      z.object({
        agentOrTask: z.string(),
        endpointId: z.string(),
        model: z.string(),
      }),
    ),
    datasetManifest: z.object({
      observationCount: z.number().int().nonnegative(),
      startAt: z.string().nullable(),
      endAt: z.string().nullable(),
      sources: z.array(z.string()),
      contentHash: z.string().min(8),
    }),
    periods: z.object({
      train: z.string().nullable(),
      validation: z.string().nullable(),
      test: z.string().nullable(),
    }),
    results: z.object({
      sampleSize: z.number().int(),
      returnPct: z.string().nullable(),
      maxDrawdownPct: z.string().nullable(),
      releaseGateLabel: z.string(),
    }),
    uncertainty: z.array(z.string()).max(32),
    weaknesses: z.array(z.string()).max(32),
    challenge: challengeEmbeddedSchema(),
    approval: z.object({
      status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
      approvedBy: z.string().nullable(),
      approvedAt: z.string().nullable(),
    }),
    reproducibility: z.object({
      codeHash: z.string().min(8),
      configHash: z.string().min(8),
      seed: z.number().int().nullable(),
    }),
    contentHash: z.string().min(16),
    signature: z.string().min(16),
  })
  .strict();

export type ExperimentReport = z.infer<typeof experimentReportSchema>;

function challengeEmbeddedSchema() {
  return z.object({
    passed: z.boolean(),
    summary: z.string(),
    findingCodes: z.array(z.string()),
  });
}

export function signExperimentReport(
  draft: Omit<ExperimentReport, "contentHash" | "signature">,
  signingKey = process.env.ODIN_REPORT_SIGNING_KEY ?? "odin-dev-report-key",
): ExperimentReport {
  const body = { ...draft };
  const contentHash = createHash("sha256").update(canonical(body)).digest("hex");
  const signature = createHmac("sha256", signingKey).update(contentHash).digest("hex");
  return experimentReportSchema.parse({ ...body, contentHash, signature });
}

export function verifyExperimentReport(
  report: ExperimentReport,
  signingKey = process.env.ODIN_REPORT_SIGNING_KEY ?? "odin-dev-report-key",
): boolean {
  const { contentHash, signature, ...rest } = report;
  const expectedHash = createHash("sha256").update(canonical(rest)).digest("hex");
  if (expectedHash !== contentHash) return false;
  const expectedSig = createHmac("sha256", signingKey).update(contentHash).digest("hex");
  return expectedSig === signature;
}

export function buildExperimentReport(input: {
  reportId: string;
  hypothesisId: string;
  strategyModuleId: string;
  strategyVersion: string;
  models: ExperimentReport["models"];
  datasetManifest: ExperimentReport["datasetManifest"];
  periods: ExperimentReport["periods"];
  results: ExperimentReport["results"];
  uncertainty: string[];
  weaknesses: string[];
  challenge: ChallengeReport;
  approval?: ExperimentReport["approval"];
  reproducibility: ExperimentReport["reproducibility"];
}): ExperimentReport {
  return signExperimentReport({
    reportId: input.reportId,
    hypothesisId: input.hypothesisId,
    strategyModuleId: input.strategyModuleId,
    strategyVersion: input.strategyVersion,
    models: input.models,
    datasetManifest: input.datasetManifest,
    periods: input.periods,
    results: input.results,
    uncertainty: input.uncertainty,
    weaknesses: input.weaknesses,
    challenge: {
      passed: input.challenge.passed,
      summary: input.challenge.summary,
      findingCodes: input.challenge.findings.map((finding) => finding.code),
    },
    approval: input.approval ?? { status: "PENDING", approvedBy: null, approvedAt: null },
    reproducibility: input.reproducibility,
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
