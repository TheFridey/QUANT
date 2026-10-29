import { canonicalJson, configHashOf, sha256 } from "@odin/shared";
import {
  createBreakoutHoldStrategy,
  createMeanRevertFadeStrategy,
  createPulseMomentumStrategy,
  findStrategyModule,
  type StrategyModule,
} from "./strategy-library.js";

/**
 * Stable built-in module refs. Display name changes must not change dispatch.
 * Arbitrary dynamic artifacts are explicitly unavailable until a reviewed loader exists.
 */
export const BUILTIN_MODULE_REFS = [
  "pulse-momentum-v1",
  "breakout-hold-v1",
  "mean-revert-fade-v1",
] as const;

export type BuiltinModuleRef = (typeof BUILTIN_MODULE_REFS)[number];

export type StrategyBindingResult =
  | { ok: true; module: StrategyModule; moduleRef: string; provenance: "builtin" }
  | {
      ok: false;
      moduleRef: string | null;
      code:
        | "UNKNOWN_MODULE_REF"
        | "DYNAMIC_ARTIFACT_UNAVAILABLE"
        | "MISSING_MODULE_REF"
        | "ARTIFACT_HASH_MISMATCH";
      message: string;
    };

const FACTORIES: Record<
  BuiltinModuleRef,
  (input: { id: string; instrumentIds: string[] }) => StrategyModule
> = {
  "pulse-momentum-v1": createPulseMomentumStrategy,
  "breakout-hold-v1": createBreakoutHoldStrategy,
  "mean-revert-fade-v1": createMeanRevertFadeStrategy,
};

/** Validate and resolve a durable module/artifact binding. Never use display-name substrings. */
export function resolveStrategyBinding(input: {
  moduleRef?: string | null;
  artifactHash?: string | null;
  name?: string | null;
  instrumentIds: string[];
  instanceId?: string;
}): StrategyBindingResult {
  const ref = input.moduleRef?.trim() || null;

  if (!ref) {
    return {
      ok: false,
      moduleRef: null,
      code: "MISSING_MODULE_REF",
      message: "Strategy instance requires an explicit moduleRef; display name is not a binding.",
    };
  }

  // Dynamic / promoted arbitrary artifacts: refuse until a reviewed sandbox loader ships.
  if (input.artifactHash && !isBuiltinModuleRef(ref)) {
    return {
      ok: false,
      moduleRef: ref,
      code: "DYNAMIC_ARTIFACT_UNAVAILABLE",
      message: `Dynamic artifact execution for moduleRef=${ref} is unavailable; only built-in modules run in paper MVP.`,
    };
  }

  // A claimed artifact hash must be the identity of the code that will actually run.
  const claimed = input.artifactHash?.trim().toLowerCase() || null;
  if (claimed) {
    const identity = builtinArtifactIdentity(ref);
    if (identity && identity.artifactHash !== claimed) {
      return {
        ok: false,
        moduleRef: ref,
        code: "ARTIFACT_HASH_MISMATCH",
        message: `artifactHash ${claimed} is not the executable identity of builtin moduleRef=${ref}.`,
      };
    }
  }

  if (!isBuiltinModuleRef(ref)) {
    // Allow exact library ids that map onto builtins (e.g. fx-breakout-v1 in STRATEGY_LIBRARY).
    const library = findStrategyModule(ref);
    if (library) {
      return { ok: true, module: library, moduleRef: ref, provenance: "builtin" };
    }
    return {
      ok: false,
      moduleRef: ref,
      code: "UNKNOWN_MODULE_REF",
      message: `Unknown strategy moduleRef=${ref}. Supported builtins: ${BUILTIN_MODULE_REFS.join(", ")}.`,
    };
  }

  const factory = FACTORIES[ref];
  const module = factory({
    id: input.instanceId ?? input.name ?? ref,
    instrumentIds: input.instrumentIds,
  });
  return { ok: true, module, moduleRef: ref, provenance: "builtin" };
}

export function isBuiltinModuleRef(value: string): value is BuiltinModuleRef {
  return (BUILTIN_MODULE_REFS as readonly string[]).includes(value);
}

export type BuiltinArtifactIdentity = {
  kind: "BUILTIN_MODULE";
  moduleRef: BuiltinModuleRef;
  moduleVersion: string;
  sourceHash: string;
  artifactHash: string;
};

/**
 * Executable identity of a builtin module, derived from moduleRef + the version the factory
 * reports. Builtin code is version-pinned: changing module behaviour requires a version bump
 * for the identity (and therefore any approval) to change.
 */
export function builtinArtifactIdentity(moduleRef: string): BuiltinArtifactIdentity | null {
  if (!isBuiltinModuleRef(moduleRef)) return null;
  const moduleVersion = FACTORIES[moduleRef]({ id: moduleRef, instrumentIds: [] }).version;
  return {
    kind: "BUILTIN_MODULE",
    moduleRef,
    moduleVersion,
    sourceHash: sha256(
      canonicalJson({ kind: "BUILTIN_MODULE_SOURCE", package: "@odin/agent-core", moduleRef, moduleVersion }),
    ),
    artifactHash: sha256(
      canonicalJson({ kind: "BUILTIN_MODULE", package: "@odin/agent-core", moduleRef, moduleVersion }),
    ),
  };
}

export type RuntimeBindingField =
  | "binding"
  | "moduleRef"
  | "moduleVersion"
  | "artifactHash"
  | "sourceHash"
  | "configHash";

export type RuntimeBindingMismatch = {
  field: RuntimeBindingField;
  expected: string | null;
  actual: string | null;
  detail: string;
};

export type LoadedRuntimeModule = {
  /** moduleRef the runtime actually resolved and will execute. */
  moduleRef: string;
  /** StrategyModule.version reported by the loaded module instance. */
  version: string;
  /** StrategyConfig the runtime will evaluate with. */
  config: unknown;
};

const HEX64 = /^[a-f0-9]{64}$/i;

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Pure check that the executable/config the runtime loaded is exactly the promoted binding in
 * EngineControl.activeStrategy. Callers must not stamp activeStrategy identity on orders unless ok.
 */
export function verifyRuntimeBinding(input: {
  activeStrategy: unknown;
  loadedModule: LoadedRuntimeModule;
}): { ok: boolean; mismatches: RuntimeBindingMismatch[] } {
  const mismatches: RuntimeBindingMismatch[] = [];
  const active =
    input.activeStrategy && typeof input.activeStrategy === "object" && !Array.isArray(input.activeStrategy)
      ? (input.activeStrategy as Record<string, unknown>)
      : null;
  if (!active) {
    return {
      ok: false,
      mismatches: [{ field: "binding", expected: null, actual: null, detail: "No promoted strategy binding is active" }],
    };
  }
  const expectedRef = readString(active, "moduleRef");
  const expectedVersion = readString(active, "moduleVersion");
  const expectedArtifact = readString(active, "artifactHash")?.toLowerCase() ?? null;
  const expectedSource = readString(active, "sourceHash")?.toLowerCase() ?? null;
  const expectedConfig = readString(active, "configHash")?.toLowerCase() ?? null;
  if (!expectedRef || !expectedVersion || !expectedConfig || !expectedArtifact) {
    mismatches.push({
      field: "binding",
      expected: null,
      actual: null,
      detail: "Active strategy is a legacy record without moduleRef/moduleVersion/artifactHash/configHash binding",
    });
  }
  const loaded = input.loadedModule;
  if (expectedRef && loaded.moduleRef !== expectedRef) {
    mismatches.push({
      field: "moduleRef",
      expected: expectedRef,
      actual: loaded.moduleRef,
      detail: "Runtime loaded a different module than the promoted binding",
    });
  }
  if (expectedVersion && loaded.version !== expectedVersion) {
    mismatches.push({
      field: "moduleVersion",
      expected: expectedVersion,
      actual: loaded.version,
      detail: "Loaded module version differs from the promoted version",
    });
  }
  const identity = builtinArtifactIdentity(loaded.moduleRef);
  const actualArtifact = identity && identity.moduleVersion === loaded.version ? identity.artifactHash : null;
  if (expectedArtifact && actualArtifact !== expectedArtifact) {
    mismatches.push({
      field: "artifactHash",
      expected: expectedArtifact,
      actual: actualArtifact,
      detail: actualArtifact
        ? "Loaded executable identity differs from the promoted artifact"
        : "Loaded module has no verifiable executable identity",
    });
  }
  if (expectedSource && identity && actualArtifact && identity.sourceHash !== expectedSource) {
    mismatches.push({
      field: "sourceHash",
      expected: expectedSource,
      actual: identity.sourceHash,
      detail: "Loaded module source identity differs from the promoted source",
    });
  }
  const actualConfig = configHashOf(loaded.config);
  if (expectedConfig && (!HEX64.test(expectedConfig) || actualConfig !== expectedConfig)) {
    mismatches.push({
      field: "configHash",
      expected: expectedConfig,
      actual: actualConfig,
      detail: "Runtime config differs from the promoted config",
    });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Default moduleRef for seeded instances — never inferred from a renamed display label. */
export function defaultModuleRefForSeed(seedKey: "crypto" | "fx" | "etf"): BuiltinModuleRef {
  if (seedKey === "etf") return "mean-revert-fade-v1";
  if (seedKey === "fx") return "pulse-momentum-v1";
  return "pulse-momentum-v1";
}
