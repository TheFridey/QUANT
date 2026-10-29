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
      code: "UNKNOWN_MODULE_REF" | "DYNAMIC_ARTIFACT_UNAVAILABLE" | "MISSING_MODULE_REF";
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

/** Default moduleRef for seeded instances — never inferred from a renamed display label. */
export function defaultModuleRefForSeed(seedKey: "crypto" | "fx" | "etf"): BuiltinModuleRef {
  if (seedKey === "etf") return "mean-revert-fade-v1";
  if (seedKey === "fx") return "pulse-momentum-v1";
  return "pulse-momentum-v1";
}
