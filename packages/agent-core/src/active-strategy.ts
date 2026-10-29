import { z } from "zod";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

const activeStrategySchema = z
  .object({
    strategyId: z.string().min(1),
    strategyVersion: z.string().min(1),
    sourceHash: hashSchema,
    artifactHash: hashSchema,
  })
  .passthrough();

export type ActiveStrategyIdentity = {
  strategyId: string;
  strategyVersion: string;
  sourceHash: string;
  artifactHash: string;
};

/** Parse EngineControl.activeStrategy without depending on @odin/evolution. */
export function parseActiveStrategyIdentity(value: unknown): ActiveStrategyIdentity | null {
  const parsed = activeStrategySchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    strategyId: parsed.data.strategyId,
    strategyVersion: parsed.data.strategyVersion,
    sourceHash: parsed.data.sourceHash.toLowerCase(),
    artifactHash: parsed.data.artifactHash.toLowerCase(),
  };
}

/** Exact version/hash stamp for Order.strategyVersion / fill provenance. */
export function strategyVersionStamp(
  identity: ActiveStrategyIdentity | null,
  fallbackConfigEntryM5?: string | number | null,
): string {
  if (identity) {
    return `${identity.strategyId}@${identity.strategyVersion}+src:${identity.sourceHash}+art:${identity.artifactHash}`;
  }
  if (fallbackConfigEntryM5 !== undefined && fallbackConfigEntryM5 !== null && `${fallbackConfigEntryM5}` !== "") {
    return `pulse:${fallbackConfigEntryM5}`;
  }
  return "pulse:default";
}
