import { z } from "zod";
import type { AutonomyPolicy } from "@odin/shared";
import { assertActionAllowed } from "./autonomy.js";

export const researchQueueItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["EXPERIMENT", "CHALLENGE", "PAPER_REVIEW", "RETIREMENT", "BRIEFING"]),
    priority: z.number().int().min(0).max(100),
    hypothesisId: z.string().nullable(),
    strategyId: z.string().nullable(),
    status: z.enum(["QUEUED", "RUNNING", "DONE", "CANCELLED", "BLOCKED"]),
    reason: z.string().min(1).max(1000),
    createdAt: z.string().datetime(),
    budgetUsd: z.string().regex(/^\d+(\.\d{1,4})?$/),
  })
  .strict();

export type ResearchQueueItem = z.infer<typeof researchQueueItemSchema>;

export type OracleSupervisorState = {
  queue: ResearchQueueItem[];
  iterations: number;
  spentBudgetUsd: number;
  terminated: boolean;
  terminationReason: string | null;
  briefings: string[];
};

export function createOracleSupervisor(): OracleSupervisorState {
  return {
    queue: [],
    iterations: 0,
    spentBudgetUsd: 0,
    terminated: false,
    terminationReason: null,
    briefings: [],
  };
}

export function enqueueResearch(
  state: OracleSupervisorState,
  item: Omit<ResearchQueueItem, "status">,
  policy: AutonomyPolicy,
): { state: OracleSupervisorState; accepted: boolean; reason: string } {
  const gate = assertActionAllowed(policy, "queue_experiment");
  if (!gate.allowed) {
    return { state, accepted: false, reason: gate.reason };
  }
  if (state.terminated) {
    return { state, accepted: false, reason: state.terminationReason ?? "terminated" };
  }
  if (state.iterations >= policy.maxResearchIterations) {
    return {
      state: { ...state, terminated: true, terminationReason: "max iterations reached" },
      accepted: false,
      reason: "max iterations reached",
    };
  }
  const nextBudget = state.spentBudgetUsd + Number(item.budgetUsd);
  if (nextBudget > Number(policy.maxResearchBudgetUsd)) {
    return {
      state: { ...state, terminated: true, terminationReason: "budget cap reached" },
      accepted: false,
      reason: "budget cap reached",
    };
  }
  const queued = researchQueueItemSchema.parse({ ...item, status: "QUEUED" });
  const queue = [...state.queue, queued].sort((a, b) => b.priority - a.priority);
  return {
    state: {
      ...state,
      queue,
      iterations: state.iterations + 1,
      spentBudgetUsd: nextBudget,
    },
    accepted: true,
    reason: "queued",
  };
}

export function detectDeterioration(input: {
  recentReturnPct: string | null;
  maxDrawdownPct: string | null;
  sampleSize: number;
}): { deteriorate: boolean; recommendRetire: boolean; notes: string[] } {
  const notes: string[] = [];
  let deteriorate = false;
  let recommendRetire = false;
  if (input.sampleSize >= 20 && input.recentReturnPct !== null && Number(input.recentReturnPct) < -5) {
    deteriorate = true;
    notes.push("Recent paper window return < -5%.");
  }
  if (input.maxDrawdownPct !== null && Number(input.maxDrawdownPct) > 15) {
    deteriorate = true;
    notes.push(`Drawdown ${input.maxDrawdownPct}% exceeds caution band.`);
  }
  if (input.sampleSize >= 50 && input.recentReturnPct !== null && Number(input.recentReturnPct) < -10) {
    recommendRetire = true;
    notes.push("Sustained negative expectancy — recommend RETIRED / QUARANTINED review.");
  }
  if (notes.length === 0) notes.push("No automated deterioration flags.");
  return { deteriorate, recommendRetire, notes };
}

export function dailyBriefing(state: OracleSupervisorState, facts: Record<string, unknown>): string {
  const queued = state.queue.filter((item) => item.status === "QUEUED").length;
  const done = state.queue.filter((item) => item.status === "DONE").length;
  const briefing = [
    `ORACLE daily briefing (${new Date().toISOString().slice(0, 10)})`,
    `Queue: ${queued} open / ${done} done / iterations ${state.iterations}`,
    `Budget spent ≈ ${state.spentBudgetUsd.toFixed(4)}`,
    `Terminated: ${state.terminated ? state.terminationReason : "no"}`,
    `Facts: ${JSON.stringify(facts).slice(0, 500)}`,
    "Advisory only — does not size, fill, or mutate RUNNING risk.",
  ].join("\n");
  state.briefings.push(briefing);
  return briefing;
}

export function compareStrategies(rows: Array<{ id: string; returnPct: string | null; sampleSize: number }>): {
  ranking: Array<{ id: string; rank: number; note: string }>;
} {
  const ranked = [...rows].sort((a, b) => {
    if (a.sampleSize < 10 && b.sampleSize >= 10) return 1;
    if (b.sampleSize < 10 && a.sampleSize >= 10) return -1;
    return Number(b.returnPct ?? Number.NEGATIVE_INFINITY) - Number(a.returnPct ?? Number.NEGATIVE_INFINITY);
  });
  return {
    ranking: ranked.map((row, index) => ({
      id: row.id,
      rank: index + 1,
      note:
        row.sampleSize < 10
          ? "INSUFFICIENT_EVIDENCE"
          : row.returnPct === null
            ? "NULL_RETURN"
            : `observed return ${row.returnPct}% (n=${row.sampleSize})`,
    })),
  };
}
