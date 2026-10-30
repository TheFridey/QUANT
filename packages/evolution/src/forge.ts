import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Hypothesis } from "@odin/shared";
import { compileStrategySource, sha256 } from "./compile-strategy.js";
import { executeCompiledStrategy, probeIsolation, type RunnerConfiguration } from "./sandbox-runner.js";
import { inspectSource, STRATEGY_DEPENDENCY_ALLOWLIST } from "./static-gate.js";
import {
  STRATEGY_CONTRACT_VERSION,
  strategyModuleManifestSchema,
  type StrategyBar,
  type StrategyModuleManifest,
  type StrategySignal,
} from "./strategy-interface.js";

export { staticCheck } from "./static-gate.js";

export const FORGE_ALLOWED_DEPENDENCIES = STRATEGY_DEPENDENCY_ALLOWLIST;

export type ExperimentIntegrity = {
  source: string;
  sourceHash: string;
  compiledArtifactHash: string | null;
  strategyVersion: string;
  contractVersion: typeof STRATEGY_CONTRACT_VERSION;
  modelIdentifier: string;
  hypothesisId: string;
  datasetIds: string[];
  runner: RunnerConfiguration;
  dependencies: readonly string[];
  executionResult: string;
  exitStatus: number | null;
  testOutcomes: Array<{ name: string; status: "PASS" | "FAIL" | "SKIP" }>;
  signalsClaimed: boolean;
};

export type ForgeResult =
  | {
      ok: true;
      workspacePath: string;
      manifest: StrategyModuleManifest;
      sourceHash: string;
      artifactHash: string;
      signals: StrategySignal[];
      integrity: ExperimentIntegrity;
      provenance: "TEMPLATE" | "PROVIDED_SOURCE";
      signalsClaimed: true;
    }
  | {
      ok: false;
      code: "STATIC_REJECT" | "COMPILE_FAIL" | "CONTRACT_FAIL" | "SANDBOX_LIMIT" | "ISOLATION_DISABLED" | "SANDBOX_TIMEOUT" | "SANDBOX_EXIT" | "HASH_MISMATCH" | "INVALID";
      error: string;
      findings: string[];
      integrity: ExperimentIntegrity;
      signalsClaimed: false;
      workspacePath?: string;
    };

export type ForgeLimits = {
  maxFsBytes: number;
  timeoutMs: number;
  workspaceRoot: string;
};

const DEFAULT_LIMITS: ForgeLimits = {
  maxFsBytes: 256_000,
  timeoutMs: 4_000,
  workspaceRoot: join(tmpdir(), "odin-forge"),
};

const CONTRACT_BAR: StrategyBar = {
  instrumentId: "solana:spot:universe",
  pairAddress: "So11111111111111111111111111111111111111112demoPairAddress0001",
  receivedAt: "2026-01-01T00:00:00.000Z",
  priceUsd: "1.25",
  liquidityUsd: "100000",
  volume24hUsd: "500000",
  priceChangeM5Pct: "3",
  priceChangeH1Pct: "1",
  txnsM5Buys: 10,
  txnsM5Sells: 4,
  dataState: "LIVE",
};

/**
 * Forge writes, validates, compiles, and — only inside bubblewrap — executes strategy source.
 * There is no in-process evaluator for generated code.
 */
export async function forgeStrategyModule(input: {
  hypothesis: Hypothesis;
  source?: string;
  version?: string;
  modelIdentifier?: string;
  datasetIds?: string[];
  limits?: Partial<ForgeLimits>;
  /** Test seam. Production callers leave this unset so the real probe decides. */
  isolation?: "auto" | "disabled";
  bars?: StrategyBar[];
}): Promise<ForgeResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const provenance = input.source?.trim() ? "PROVIDED_SOURCE" : "TEMPLATE";
  const source = input.source?.trim() ? input.source : renderTemplate(input.hypothesis);
  const modelIdentifier = input.modelIdentifier ?? (provenance === "TEMPLATE" ? "TEMPLATE" : "UNATTRIBUTED_SOURCE");
  const version = input.version ?? "0.1.0";
  const id = `strat_${slug(input.hypothesis.title)}`;
  const hypothesisId = input.hypothesis.id ?? "hyp";
  const runner = input.isolation === "disabled" ? { ...probeIsolation(), runtime: "disabled" as const, available: false, reason: "Isolation disabled by caller" } : probeIsolation();

  const baseIntegrity = (patch: Partial<ExperimentIntegrity>): ExperimentIntegrity => ({
    source,
    sourceHash: sha256(source),
    compiledArtifactHash: null,
    strategyVersion: version,
    contractVersion: STRATEGY_CONTRACT_VERSION,
    modelIdentifier,
    hypothesisId,
    datasetIds: input.datasetIds ?? [],
    runner,
    dependencies: STRATEGY_DEPENDENCY_ALLOWLIST,
    executionResult: "NOT_RUN",
    exitStatus: null,
    testOutcomes: [],
    signalsClaimed: false,
    ...patch,
  });

  const staticFindings = inspectSource(source);
  if (staticFindings.length > 0) {
    return {
      ok: false,
      code: "STATIC_REJECT",
      error: "Generated source failed the static source lint",
      findings: staticFindings.map((finding) => `${finding.code}: ${finding.detail}`),
      signalsClaimed: false,
      integrity: baseIntegrity({
        executionResult: "STATIC_REJECT",
        testOutcomes: [{ name: "static_source_gate", status: "FAIL" }],
      }),
    };
  }

  const compiled = compileStrategySource(source);
  if (!compiled.ok) {
    return {
      ok: false,
      code: "COMPILE_FAIL",
      error: compiled.error,
      findings: [compiled.error],
      signalsClaimed: false,
      integrity: baseIntegrity({
        executionResult: "COMPILE_FAIL",
        testOutcomes: [
          { name: "static_source_gate", status: "PASS" },
          { name: "compilation", status: "FAIL" },
        ],
      }),
    };
  }

  if (!runner.available) {
    return {
      ok: false,
      code: "ISOLATION_DISABLED",
      error: runner.reason,
      findings: [runner.reason],
      signalsClaimed: false,
      integrity: baseIntegrity({
        compiledArtifactHash: compiled.artifactHash,
        executionResult: "ISOLATION_DISABLED",
        testOutcomes: [
          { name: "static_source_gate", status: "PASS" },
          { name: "compilation", status: "PASS" },
          { name: "isolated_execution", status: "SKIP" },
        ],
      }),
    };
  }

  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > limits.maxFsBytes) {
    return {
      ok: false,
      code: "SANDBOX_LIMIT",
      error: `Source exceeds workspace limit (${sourceBytes} > ${limits.maxFsBytes})`,
      findings: [],
      signalsClaimed: false,
      integrity: baseIntegrity({
        compiledArtifactHash: compiled.artifactHash,
        executionResult: "SANDBOX_LIMIT",
      }),
    };
  }

  const manifest = strategyModuleManifestSchema.parse({
    id,
    version,
    instrumentIds: input.hypothesis.instrumentIds,
    hypothesisId,
    entrypoint: "strategy.js",
  });
  const workspacePath = resolve(limits.workspaceRoot, id, version);
  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      code: "SANDBOX_LIMIT",
      error: error instanceof Error ? error.message : "workspace create failed",
      findings: [],
      signalsClaimed: false,
      integrity: baseIntegrity({ compiledArtifactHash: compiled.artifactHash, executionResult: "SANDBOX_LIMIT" }),
    };
  }

  writeFileSync(join(workspacePath, "strategy.ts"), source);
  writeFileSync(join(workspacePath, "strategy.js"), compiled.javascript);
  writeFileSync(join(workspacePath, "manifest.json"), JSON.stringify(manifest, null, 2));

  const bars = input.bars ?? [{ ...CONTRACT_BAR, instrumentId: input.hypothesis.instrumentIds[0] ?? CONTRACT_BAR.instrumentId }];
  const execution = await executeCompiledStrategy({
    javascript: compiled.javascript,
    artifactHash: compiled.artifactHash,
    bars,
    metadata: { strategyId: id, version, hypothesisId },
    timeoutMs: limits.timeoutMs,
  });

  const integrity = baseIntegrity({
    compiledArtifactHash: compiled.artifactHash,
    executionResult: execution.code,
    exitStatus: execution.exitStatus,
    signalsClaimed: execution.signalsClaimed,
    runner: execution.runner,
    testOutcomes: [
      { name: "static_source_gate", status: "PASS" },
      { name: "compilation", status: "PASS" },
      { name: "isolated_execution", status: execution.ok ? "PASS" : "FAIL" },
      {
        name: "artifact_hash_matches_execution",
        status: execution.executedHash === compiled.artifactHash ? "PASS" : "FAIL",
      },
    ],
  });
  writeFileSync(join(workspacePath, "integrity.json"), JSON.stringify(integrity, null, 2));
  writeFileSync(
    join(workspacePath, "sandbox.json"),
    JSON.stringify({ runner: execution.runner, dependencies: STRATEGY_DEPENDENCY_ALLOWLIST }, null, 2),
  );

  if (!execution.ok || !execution.signalsClaimed) {
    const code = mapExecutionCode(execution.code);
    return {
      ok: false,
      code,
      error: execution.error ?? "Isolated execution failed",
      findings: execution.error ? [execution.error] : [],
      signalsClaimed: false,
      workspacePath,
      integrity: { ...integrity, signalsClaimed: false },
    };
  }

  // executeCompiledStrategy has already validated one contract-valid signal per bar.
  const signals: StrategySignal[] = execution.signals;

  return {
    ok: true,
    workspacePath,
    manifest,
    sourceHash: integrity.sourceHash,
    artifactHash: compiled.artifactHash,
    signals,
    integrity: { ...integrity, signalsClaimed: true },
    provenance,
    signalsClaimed: true,
  };
}

function mapExecutionCode(
  code: string,
): "ISOLATION_DISABLED" | "SANDBOX_TIMEOUT" | "HASH_MISMATCH" | "CONTRACT_FAIL" | "SANDBOX_EXIT" {
  if (code === "ISOLATION_DISABLED" || code === "SANDBOX_TIMEOUT" || code === "HASH_MISMATCH") return code;
  if (code === "CONTRACT_FAIL" || code === "CONTRACT" || code.startsWith("SIGNAL_")) return "CONTRACT_FAIL";
  return "SANDBOX_EXIT";
}

export function destroyForgeWorkspace(workspacePath: string, root = join(tmpdir(), "odin-forge")): void {
  const resolved = resolve(workspacePath);
  const allowedRoot = resolve(root);
  if (!resolved.startsWith(allowedRoot)) {
    throw new Error("Refusing to destroy path outside forge root");
  }
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}

function renderTemplate(hypothesis: Hypothesis): string {
  const title = hypothesis.title.replace(/\*\//g, "");
  return `/**
 * TEMPLATE research strategy. This source is a deterministic template.
 * Hypothesis title: ${title}
 * The module emits intents. Risk, sizing, and fills stay outside this file.
 */
export function onBar(input) {
  if (!input.bar || !input.bar.priceUsd) {
    return { intent: "HOLD", reasonCodes: ["NO_PRICE"] };
  }
  return { intent: "HOLD", reasonCodes: ["TEMPLATE"], confidence: 0 };
}
`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

export const forgeRequestSchema = z
  .object({
    hypothesisId: z.string().min(1),
    source: z.string().max(200_000).optional(),
    version: z.string().max(40).optional(),
  })
  .strict();
