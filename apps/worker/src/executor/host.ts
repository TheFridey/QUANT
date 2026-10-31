import type { StageRunner } from "../stage-runner.js";

/** Audit F2: what the executor phase modules need from StageRunner, passed explicitly. */
export type LoadedPlan = NonNullable<Awaited<ReturnType<StageRunner["loadPlan"]>>>;

export type ExecutorHost = {
  dataMode: StageRunner["dataMode"];
  buildReservationBudget: StageRunner["buildReservationBudget"];
  armProtectionForFill: StageRunner["armProtectionForFill"];
  persistAlert: StageRunner["persistAlert"];
  readCyclePlan: StageRunner["readCyclePlan"];
  loadPlan: StageRunner["loadPlan"];
};
