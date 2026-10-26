import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Hypothesis } from "@odin/shared";
import {
  strategyModuleManifestSchema,
  strategySignalSchema,
  type StrategyBar,
  type StrategyContext,
  type StrategyModule,
  type StrategyModuleManifest,
} from "./strategy-interface.js";

export const FORGE_ALLOWED_DEPENDENCIES = [
  "@odin/shared",
  "@odin/evolution",
  "zod",
  "decimal.js",
] as const;

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["']fs["']/,
  /from\s+["']node:fs["']/,
  /from\s+["']child_process["']/,
  /from\s+["']node:child_process["']/,
  /from\s+["']net["']/,
  /from\s+["']node:net["']/,
  /from\s+["']http["']/,
  /from\s+["']node:http["']/,
  /from\s+["']https["']/,
  /from\s+["']node:https["']/,
  /process\.env/,
  /DATABASE_URL/,
  /REDIS_URL/,
  /PRIVATE_KEY/,
  /API_KEY/,
  /SECRET/,
  /broker/i,
  /real[_-]?money/i,
  /placeOrder\s*\(/,
  /overrideRisk/i,
];

export type ForgeLimits = {
  maxCpuMs: number;
  maxMemoryMb: number;
  maxFsBytes: number;
  timeoutMs: number;
  workspaceRoot: string;
};

export type ForgeResult =
  | {
      ok: true;
      workspacePath: string;
      manifest: StrategyModuleManifest;
      sourceHash: string;
      module: StrategyModule;
      staticFindings: string[];
    }
  | {
      ok: false;
      code: "STATIC_REJECT" | "CONTRACT_FAIL" | "SANDBOX_LIMIT" | "INVALID";
      error: string;
      findings: string[];
    };

const DEFAULT_LIMITS: ForgeLimits = {
  maxCpuMs: 2_000,
  maxMemoryMb: 128,
  maxFsBytes: 256_000,
  timeoutMs: 5_000,
  workspaceRoot: join(tmpdir(), "odin-forge"),
};

/**
 * Isolated research forge.
 * Generates versioned strategy modules into a sandbox workspace.
 * No broker creds, live exec, prod DB, host FS escape, or unrestricted net.
 */
export function forgeStrategyModule(input: {
  hypothesis: Hypothesis;
  /** Optional LLM/template source. When absent, uses deterministic template. */
  source?: string;
  version?: string;
  limits?: Partial<ForgeLimits>;
}): ForgeResult {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const source = input.source?.trim() ? input.source : renderTemplate(input.hypothesis);
  const staticFindings = staticCheck(source);
  if (staticFindings.length > 0) {
    return {
      ok: false,
      code: "STATIC_REJECT",
      error: "Generated source failed static security checks",
      findings: staticFindings,
    };
  }

  const id = `strat_${slug(input.hypothesis.title)}`;
  const version = input.version ?? "0.1.0";
  const workspacePath = resolve(limits.workspaceRoot, id, version);
  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      code: "SANDBOX_LIMIT",
      error: error instanceof Error ? error.message : "workspace create failed",
      findings: [],
    };
  }

  const manifest: StrategyModuleManifest = strategyModuleManifestSchema.parse({
    id,
    version,
    instrumentIds: input.hypothesis.instrumentIds,
    hypothesisId: input.hypothesis.id,
    entrypoint: "strategy.js",
  });

  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > limits.maxFsBytes) {
    return {
      ok: false,
      code: "SANDBOX_LIMIT",
      error: `Source exceeds FS limit (${sourceBytes} > ${limits.maxFsBytes})`,
      findings: [],
    };
  }

  writeFileSync(join(workspacePath, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(workspacePath, "strategy.ts"), source);
  writeFileSync(join(workspacePath, "strategy.js"), compileTemplateToJs(input.hypothesis, id, version));
  writeFileSync(
    join(workspacePath, "sandbox.json"),
    JSON.stringify(
      {
        allowedDependencies: FORGE_ALLOWED_DEPENDENCIES,
        denied: [
          "broker_credentials",
          "live_execution",
          "prod_database",
          "host_filesystem",
          "unrestricted_network",
          "risk_policy_mutation",
        ],
        limits,
      },
      null,
      2,
    ),
  );

  const module = loadSandboxedModule(workspacePath, manifest, input.hypothesis);
  const contract = runContractTests(module);
  if (!contract.ok) {
    return { ok: false, code: "CONTRACT_FAIL", error: contract.error, findings: contract.findings };
  }

  const sourceHash = createHash("sha256").update(source).digest("hex");
  return {
    ok: true,
    workspacePath,
    manifest,
    sourceHash,
    module,
    staticFindings: [],
  };
}

export function staticCheck(source: string): string[] {
  const findings: string[] = [];
  if (!source) return findings;
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    if (pattern.test(source)) {
      findings.push(`Forbidden pattern: ${pattern}`);
    }
  }
  // Dependency allowlist: any non-relative import must be allowlisted.
  const importRe = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source))) {
    const spec = match[1]!;
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (!(FORGE_ALLOWED_DEPENDENCIES as readonly string[]).includes(spec)) {
      findings.push(`Dependency not allowlisted: ${spec}`);
    }
  }
  return findings;
}

export function destroyForgeWorkspace(workspacePath: string, root = join(tmpdir(), "odin-forge")): void {
  const resolved = resolve(workspacePath);
  const allowedRoot = resolve(root);
  if (!resolved.startsWith(allowedRoot)) {
    throw new Error("Refusing to destroy path outside forge root");
  }
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}

function loadSandboxedModule(
  workspacePath: string,
  manifest: StrategyModuleManifest,
  hypothesis: Hypothesis,
): StrategyModule {
  // Execute only the compiled template JS (no eval of arbitrary LLM text in-process).
  // LLM/source text is persisted for review; runtime uses the deterministic sandbox module.
  void readFileSync(join(workspacePath, "strategy.ts"), "utf8");
  const instrumentIds = [...manifest.instrumentIds];
  return {
    id: manifest.id,
    version: manifest.version,
    instrumentIds,
    onBar(bar: StrategyBar, context: StrategyContext) {
      void hypothesis;
      const price = bar.priceUsd;
      if (!price || bar.dataState !== "LIVE" && bar.dataState !== "REPLAY") {
        return strategySignalSchema.parse({
          instrumentId: bar.instrumentId,
          pairAddress: bar.pairAddress,
          intent: "HOLD",
          reasonCodes: ["NO_TRADEABLE_MARK"],
        });
      }
      const m5 = bar.priceChangeM5Pct ? Number(bar.priceChangeM5Pct) : null;
      const entry = Number(context.config.entryM5ChangePct);
      const maxEntry = Number(context.config.maxEntryM5ChangePct);
      if (m5 !== null && Number.isFinite(m5) && m5 >= entry && m5 <= maxEntry) {
        return strategySignalSchema.parse({
          instrumentId: bar.instrumentId,
          pairAddress: bar.pairAddress,
          intent: "ENTER_LONG",
          reasonCodes: ["TEMPLATE_M5_ENTRY"],
          confidence: 0.5,
        });
      }
      if (m5 !== null && Number.isFinite(m5) && m5 <= Number(context.config.exitM5ChangePct)) {
        return strategySignalSchema.parse({
          instrumentId: bar.instrumentId,
          pairAddress: bar.pairAddress,
          intent: "EXIT_LONG",
          reasonCodes: ["TEMPLATE_M5_EXIT"],
        });
      }
      return strategySignalSchema.parse({
        instrumentId: bar.instrumentId,
        pairAddress: bar.pairAddress,
        intent: "HOLD",
        reasonCodes: ["NO_SIGNAL"],
      });
    },
  };
}

function runContractTests(module: StrategyModule): { ok: true } | { ok: false; error: string; findings: string[] } {
  const findings: string[] = [];
  const bar: StrategyBar = {
    instrumentId: module.instrumentIds[0] ?? "solana:spot:universe",
    pairAddress: "So11111111111111111111111111111111111111112demoPairAddress0001",
    receivedAt: new Date().toISOString(),
    priceUsd: "1.25",
    liquidityUsd: "100000",
    volume24hUsd: "500000",
    priceChangeM5Pct: "3",
    priceChangeH1Pct: "1",
    txnsM5Buys: 10,
    txnsM5Sells: 4,
    dataState: "LIVE",
  };
  const context: StrategyContext = {
    config: {
      startingBalanceUsd: "100",
      feeBps: "30",
      maxSlippageBps: "150",
      minLiquidityUsd: "25000",
      minVolume24hUsd: "50000",
      entryM5ChangePct: "2",
      maxEntryM5ChangePct: "25",
      minH1ChangePct: "0",
      exitM5ChangePct: "-1.5",
      stopLossPct: "3",
      takeProfitPct: "5",
      maxPositions: 4,
      maxPositionPctEquity: "5",
      maxDailyLossPct: "3",
      maxParticipationPctLiquidity: "1",
      minOrderNotionalUsd: "5",
      allowDelayedExits: true,
      flattenOnEmergency: false,
      universeLimit: 12,
      liveMaxAgeMs: 45000,
      delayedMaxAgeMs: 180000,
      maxRiskPerTradePct: "0.5",
      maxAggregateExposurePct: "20",
      maxTotalDrawdownPct: "10",
      maxPriceImpactBps: "150",
      paperLatencyMs: 0,
      spreadBpsEstimate: "5",
      orderExpiryMs: 60_000,
      pulseMinObservations: 5,
      discoveryMaxPairAgeHours: null,
      discoveryMinPairAgeMinutes: "0",
      relativeVolumeMin: null,
      trailingStopPct: null,
      maxHoldingMs: null,
      minSampleTrades: 30,
      minObservationSpanMs: 24 * 60 * 60 * 1000,
      requireOosEvaluation: true,
      releaseMaxDrawdownPct: "15",
    },
    openPositions: [],
    history: [],
  };
  try {
    const signal = module.onBar(bar, context);
    strategySignalSchema.parse(signal);
  } catch (error) {
    findings.push(error instanceof Error ? error.message : "contract failure");
    return { ok: false, error: "Strategy contract test failed", findings };
  }
  return { ok: true };
}

function renderTemplate(hypothesis: Hypothesis): string {
  return `/**
 * Auto-forged research strategy (template).
 * Hypothesis: ${hypothesis.title.replace(/\*\//g, "")}
 * This module emits intents only. Risk/sizing/fills are external.
 */
export const manifest = {
  id: "template",
  instrumentIds: ${JSON.stringify(hypothesis.instrumentIds)},
};
export function onBar(bar, context) {
  void context;
  if (!bar.priceUsd) return { instrumentId: bar.instrumentId, intent: "HOLD", reasonCodes: ["NO_PRICE"] };
  return { instrumentId: bar.instrumentId, intent: "HOLD", reasonCodes: ["TEMPLATE"] };
}
`;
}

function compileTemplateToJs(hypothesis: Hypothesis, id: string, version: string): string {
  return `export const id = ${JSON.stringify(id)};
export const version = ${JSON.stringify(version)};
export const instrumentIds = ${JSON.stringify(hypothesis.instrumentIds)};
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
