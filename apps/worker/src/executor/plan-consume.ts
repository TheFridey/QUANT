// Audit F2: one executor phase, moved out of StageRunner.executor without behaviour change.
import { admitAgainstPlan, cyclePlanInvalidAlert, InvalidCyclePlanError, type CyclePlanSnapshot } from "@odin/agent-core";
import type { ExecutionContext } from "@odin/shared";
import type { Prisma } from "@odin/shared/db";
import { upsertDecision } from "../decisions.js";
import type { ExecutorHost, LoadedPlan } from "./host.js";

/**
 * Plan-consume phase (audit F1): read the cycle's stored plan, run the admission re-check against
 * it, and persist the EXECUTOR projection plus the admission record. Returns null when the cycle
 * cannot be planned (the executor then stops without admitting anything).
 */
export async function consumeCyclePlan(
  host: ExecutorHost,
  tx: Prisma.TransactionClient,
  { cycleId, now, ctx }: { cycleId: string; now: Date; ctx: ExecutionContext },
): Promise<LoadedPlan | null> {
  let snapshot: CyclePlanSnapshot | null;
  let planInvalid = false;
  try {
    snapshot = await host.readCyclePlan(tx, cycleId);
  } catch (error) {
    if (!(error instanceof InvalidCyclePlanError)) throw error;
    planInvalid = true;
    await host.persistAlert(tx, cyclePlanInvalidAlert(cycleId, error.message), ctx.accountId);
    snapshot = { cycleId, plannedAt: now.toISOString(), decisions: [], orders: [], watchlist: [], intentOutcomes: [] };
  }
  const loaded = await host.loadPlan(cycleId, now, tx, ctx, (plan) => admitAgainstPlan(snapshot, plan));
  if (!loaded) return null;
  const admission = loaded.admission ?? admitAgainstPlan(snapshot, loaded.plan);
  const persisted = snapshot
    ? loaded.plan.decisions.filter((item) => item.agent === "EXECUTOR")
    : loaded.plan.decisions.filter((item) => item.agent === "AEGIS" || item.agent === "ATLAS" || item.agent === "EXECUTOR");
  for (const decision of persisted) {
    await upsertDecision(tx, cycleId, decision);
  }
  await upsertDecision(tx, cycleId, {
    agent: "EXECUTOR",
    modelVersion: "executor-admission-1.0.0",
    pairAddress: "(admission)",
    decision: admission.records.some((row) => row.result === "NOT_IN_PLAN" || row.result === "REJECTED_AT_ADMISSION") ? "HOLD" : "PASS",
    confidence: "1.000000",
    reasonCodes: [planInvalid ? "CYCLE_PLAN_INVALID" : snapshot ? "CYCLE_PLAN_ADMISSION" : "CYCLE_PLAN_MISSING"],
    input: { planTime: planInvalid ? null : (snapshot?.plannedAt ?? null), admissionTime: now.toISOString() },
    output: { records: admission.records },
    inputSource: "cycle-plan",
    durationMs: 0,
  });
  return loaded;
}
