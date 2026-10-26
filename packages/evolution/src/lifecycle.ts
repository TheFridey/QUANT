import { createHash } from "node:crypto";
import {
  STRATEGY_LIFECYCLE,
  canTransition,
  type StrategyLifecycle,
} from "@odin/shared";

export type LifecycleTransition = {
  id: string;
  strategyId: string;
  from: StrategyLifecycle;
  to: StrategyLifecycle;
  actor: string;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  at: string;
};

export function hashEvidence(evidence: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(evidence))).digest("hex");
}

export function transitionLifecycle(input: {
  strategyId: string;
  from: StrategyLifecycle;
  to: StrategyLifecycle;
  actor: string;
  evidence: Record<string, unknown>;
  at?: string;
}): { ok: true; transition: LifecycleTransition } | { ok: false; error: string } {
  if (!(STRATEGY_LIFECYCLE as readonly string[]).includes(input.from)) {
    return { ok: false, error: `Unknown from state ${input.from}` };
  }
  if (!(STRATEGY_LIFECYCLE as readonly string[]).includes(input.to)) {
    return { ok: false, error: `Unknown to state ${input.to}` };
  }
  if (!canTransition(input.from, input.to)) {
    return { ok: false, error: `Illegal transition ${input.from} → ${input.to}` };
  }
  const evidenceHash = hashEvidence(input.evidence);
  const at = input.at ?? new Date().toISOString();
  return {
    ok: true,
    transition: {
      id: `lt_${evidenceHash.slice(0, 12)}`,
      strategyId: input.strategyId,
      from: input.from,
      to: input.to,
      actor: input.actor,
      evidence: input.evidence,
      evidenceHash,
      at,
    },
  };
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
