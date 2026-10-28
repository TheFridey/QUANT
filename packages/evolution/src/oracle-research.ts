import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { d } from "@odin/shared";
import type { TradeMemoryRecord } from "@odin/shared";
import { compareStrategies, detectDeterioration } from "./oracle-supervisor.js";

export const ORACLE_CAPABILITIES = [
  "REVIEW_PERFORMANCE",
  "EXAMINE_TRADE_MEMORY",
  "RECURRING_CONDITIONS",
  "WEAKNESSES",
  "FALSIFIABLE_HYPOTHESIS",
  "REQUEST_CODE_GENERATION",
  "SCHEDULE_SANDBOXED_TEST",
  "COMPARE_BASELINES",
  "REVIEW_CHALLENGE",
  "REJECT_WEAK_CANDIDATE",
  "RECOMMEND_EXPERIMENT",
  "DETERIORATING_STRATEGY",
  "PERIODIC_SUMMARY",
] as const;

export type OracleCapability = (typeof ORACLE_CAPABILITIES)[number];

export type OracleLimits = {
  maxExperimentsPerCycle: number;
  maxSpendUsdPerDay: string;
  maxConcurrent: number;
  maxRetries: number;
  maxRepeatedFailures: number;
};

export const DEFAULT_ORACLE_LIMITS: OracleLimits = {
  maxExperimentsPerCycle: 8,
  maxSpendUsdPerDay: "5.0000",
  maxConcurrent: 2,
  maxRetries: 2,
  maxRepeatedFailures: 3,
};

export type OracleQueueStatus = "QUEUED" | "RUNNING" | "DONE" | "CANCELLED" | "BLOCKED";

export type OracleQueueRecord = {
  id: string;
  capability: OracleCapability;
  priority: number;
  hypothesisId: string | null;
  strategyId: string | null;
  status: OracleQueueStatus;
  reason: string;
  createdAt: string;
  budgetUsd: string;
  fingerprint: string;
  retries: number;
  failureStreak: number;
  provenance: "DETERMINISTIC_SUPERVISOR" | "MODEL";
  aiDiscovery: boolean;
  modelIdentifier: string | null;
};

export type OracleQueueSnapshot = {
  items: OracleQueueRecord[];
  spentUsd: string;
  failureStreak: number;
  terminated: boolean;
  terminationReason: string | null;
};

const BLOCKED_MODEL_IDS = new Set([
  "TEMPLATE",
  "UNAVAILABLE",
  "MOCK",
  "FIXTURE",
  "UNATTRIBUTED_SOURCE",
  "DETERMINISTIC_SUPERVISOR",
]);

export function labelAsAiDiscovery(input: {
  provenance: OracleQueueRecord["provenance"];
  modelIdentifier: string | null;
}): boolean {
  if (input.provenance !== "MODEL" || !input.modelIdentifier) return false;
  return !BLOCKED_MODEL_IDS.has(input.modelIdentifier);
}

export function oracleFingerprint(capability: OracleCapability, hypothesisId: string | null, reason: string): string {
  return createHash("sha256").update(`${capability}|${hypothesisId ?? ""}|${reason}`).digest("hex").slice(0, 32);
}

export function emptyOracleQueue(): OracleQueueSnapshot {
  return {
    items: [],
    spentUsd: "0.0000",
    failureStreak: 0,
    terminated: false,
    terminationReason: null,
  };
}

export class FileOracleQueue {
  constructor(private readonly path: string) {}

  read(): OracleQueueSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<OracleQueueSnapshot>;
      if (Array.isArray(parsed.items) && typeof parsed.spentUsd === "string") {
        return {
          items: parsed.items,
          spentUsd: parsed.spentUsd,
          failureStreak: parsed.failureStreak ?? 0,
          terminated: Boolean(parsed.terminated),
          terminationReason: parsed.terminationReason ?? null,
        };
      }
    } catch {
      // Missing file starts empty.
    }
    return emptyOracleQueue();
  }

  write(snapshot: OracleQueueSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(snapshot));
  }
}

export function admitOracleItem(
  snapshot: OracleQueueSnapshot,
  item: Omit<OracleQueueRecord, "status" | "fingerprint" | "aiDiscovery" | "failureStreak"> & {
    fingerprint?: string;
    aiDiscovery?: boolean;
  },
  limits: OracleLimits = DEFAULT_ORACLE_LIMITS,
): { snapshot: OracleQueueSnapshot; accepted: boolean; reason: string; record: OracleQueueRecord | null } {
  if (snapshot.terminated) {
    return { snapshot, accepted: false, reason: snapshot.terminationReason ?? "terminated", record: null };
  }
  const fingerprint = item.fingerprint ?? oracleFingerprint(item.capability, item.hypothesisId, item.reason);
  if (snapshot.items.some((row) => row.fingerprint === fingerprint && row.status !== "CANCELLED")) {
    return { snapshot, accepted: false, reason: "duplicate hypothesis work", record: null };
  }
  if (item.retries > limits.maxRetries) {
    return { snapshot, accepted: false, reason: "max retries", record: null };
  }
  if (snapshot.failureStreak >= limits.maxRepeatedFailures) {
    const next = { ...snapshot, terminated: true, terminationReason: "repeated failure" };
    return { snapshot: next, accepted: false, reason: "repeated failure", record: null };
  }
  const active = snapshot.items.filter((row) => row.status !== "CANCELLED");
  if (active.length >= limits.maxExperimentsPerCycle) {
    const next = { ...snapshot, terminated: true, terminationReason: "max experiments per cycle" };
    return { snapshot: next, accepted: false, reason: "max experiments per cycle", record: null };
  }
  const concurrent = snapshot.items.filter((row) => row.status === "QUEUED" || row.status === "RUNNING").length;
  if (concurrent >= limits.maxConcurrent) {
    return { snapshot, accepted: false, reason: "max concurrent research items", record: null };
  }
  const spent = d(snapshot.spentUsd).plus(d(item.budgetUsd));
  if (spent.gt(d(limits.maxSpendUsdPerDay))) {
    const next = { ...snapshot, terminated: true, terminationReason: "daily spend cap" };
    return { snapshot: next, accepted: false, reason: "daily spend cap", record: null };
  }
  const aiDiscovery = labelAsAiDiscovery({
    provenance: item.provenance,
    modelIdentifier: item.modelIdentifier,
  }) && item.aiDiscovery === true;
  if (item.aiDiscovery === true && !aiDiscovery) {
    return { snapshot, accepted: false, reason: "unconfigured or template output cannot be stored as an AI discovery", record: null };
  }
  const record: OracleQueueRecord = {
    ...item,
    status: "QUEUED",
    fingerprint,
    failureStreak: snapshot.failureStreak,
    aiDiscovery,
  };
  return {
    snapshot: {
      ...snapshot,
      spentUsd: spent.toFixed(4),
      items: [...snapshot.items, record].sort((a, b) => b.priority - a.priority),
    },
    accepted: true,
    reason: "queued",
    record,
  };
}

export function noteOracleFailure(snapshot: OracleQueueSnapshot, limits: OracleLimits = DEFAULT_ORACLE_LIMITS): OracleQueueSnapshot {
  const failureStreak = snapshot.failureStreak + 1;
  const terminated = failureStreak >= limits.maxRepeatedFailures;
  return {
    ...snapshot,
    failureStreak,
    terminated: snapshot.terminated || terminated,
    terminationReason: terminated ? "repeated failure" : snapshot.terminationReason,
  };
}

export type OracleProposal = {
  capability: OracleCapability;
  priority: number;
  reason: string;
  provenance: "DETERMINISTIC_SUPERVISOR";
  aiDiscovery: false;
  modelIdentifier: null;
  returnPct: string | null;
};

export function proposeOracleCycle(input: {
  performance: { returnPct: string | null; sampleSize: number; maxDrawdownPct: string | null };
  memory: TradeMemoryRecord[];
  challengePassed: boolean | null;
  challengeFindings: string[];
  baselines: Array<{ id: string; returnPct: string | null; sampleSize: number }>;
  hypothesisId: string | null;
  openConditions: string[];
}): OracleProposal[] {
  const entryMemory = input.memory.filter((record) => !record.postExit && record.phase !== "AFTER");
  const conditionCounts = new Map<string, number>();
  for (const record of entryMemory) {
    const condition = record.context.condition;
    if (typeof condition === "string" && condition.length > 0) {
      conditionCounts.set(condition, (conditionCounts.get(condition) ?? 0) + 1);
    }
  }
  const recurring = [...conditionCounts.entries()].filter(([, count]) => count >= 2);
  const deterioration = detectDeterioration({
    recentReturnPct: input.performance.returnPct,
    maxDrawdownPct: input.performance.maxDrawdownPct,
    sampleSize: input.performance.sampleSize,
  });
  const ranking = compareStrategies(input.baselines);
  const weak =
    input.performance.returnPct === null || input.performance.sampleSize < 30 || input.challengePassed === false;
  const performanceReason =
    input.performance.returnPct === null
      ? `Performance return is unavailable (n=${input.performance.sampleSize})`
      : `Observed return ${input.performance.returnPct}% (n=${input.performance.sampleSize})`;
  const proposals: Array<Omit<OracleProposal, "provenance" | "aiDiscovery" | "modelIdentifier">> = [
    { capability: "REVIEW_PERFORMANCE", priority: 90, reason: performanceReason, returnPct: input.performance.returnPct },
    {
      capability: "EXAMINE_TRADE_MEMORY",
      priority: 70,
      reason: `Entry-safe memory rows ${entryMemory.length}; post-exit rows excluded`,
      returnPct: null,
    },
    {
      capability: "RECURRING_CONDITIONS",
      priority: 60,
      reason: recurring.length === 0 ? "No repeated entry condition" : `Repeated conditions: ${recurring.map(([name]) => name).join(", ")}`,
      returnPct: null,
    },
    {
      capability: "WEAKNESSES",
      priority: 80,
      reason: input.challengeFindings.length === 0 ? "No challenge findings supplied" : input.challengeFindings.join("; ").slice(0, 900),
      returnPct: null,
    },
    {
      capability: "FALSIFIABLE_HYPOTHESIS",
      priority: 75,
      reason:
        input.openConditions.length === 0
          ? "No condition supplied for a falsifiable statement"
          : `Falsify: ${input.openConditions[0]} fails when the untouched window return is null or negative`,
      returnPct: null,
    },
    {
      capability: "REQUEST_CODE_GENERATION",
      priority: 50,
      reason: "Request code generation for a later sandboxed forge. This cycle does not write strategy source.",
      returnPct: null,
    },
    {
      capability: "SCHEDULE_SANDBOXED_TEST",
      priority: 55,
      reason: "Schedule a sandboxed test. This cycle does not execute generated code.",
      returnPct: null,
    },
    {
      capability: "COMPARE_BASELINES",
      priority: 65,
      reason: ranking.ranking.length === 0 ? "No baselines supplied" : ranking.ranking.map((row) => `${row.rank}:${row.id}:${row.note}`).join(" | ").slice(0, 900),
      returnPct: null,
    },
    {
      capability: "REVIEW_CHALLENGE",
      priority: 85,
      reason: input.challengePassed === null ? "Challenge result unavailable" : `Challenge passed=${input.challengePassed}`,
      returnPct: null,
    },
    {
      capability: "REJECT_WEAK_CANDIDATE",
      priority: 95,
      reason: weak ? "Candidate stays rejected: null return, small sample, or failed challenge" : "Candidate is not auto-rejected by the supervisor rules",
      returnPct: input.performance.returnPct,
    },
    {
      capability: "RECOMMEND_EXPERIMENT",
      priority: 40,
      reason: "Next experiment needs an untouched window and a larger sample before any promotion review",
      returnPct: null,
    },
    {
      capability: "DETERIORATING_STRATEGY",
      priority: deterioration.deteriorate ? 88 : 30,
      reason: deterioration.notes.join(" "),
      returnPct: input.performance.returnPct,
    },
    {
      capability: "PERIODIC_SUMMARY",
      priority: 20,
      reason: `Supervisor summary for ${input.hypothesisId ?? "no hypothesis"}. Return ${input.performance.returnPct === null ? "unavailable" : input.performance.returnPct}. Memory ${entryMemory.length}. This text is deterministic supervision, not a model discovery.`,
      returnPct: input.performance.returnPct,
    },
  ];
  return proposals.map((proposal) => ({
    ...proposal,
    provenance: "DETERMINISTIC_SUPERVISOR",
    aiDiscovery: false,
    modelIdentifier: null,
  }));
}
