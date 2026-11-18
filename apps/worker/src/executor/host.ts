import type { StageRunner } from "../stage-runner.js";

/** Audit F2: what the executor phase modules need from StageRunner, passed explicitly. */
export type LoadedPlan = NonNullable<Awaited<ReturnType<StageRunner["loadPlan"]>>>;

export type ExecutorHost = {
  dataMode: StageRunner["dataMode"];
  /**
   * CATALYST legacy retirement: settle cancels pending entries when new entries are retired. StageRunner always
   * passes it; a host built without it (tests, older callers) keeps today's behaviour.
   */
  legacy?: StageRunner["legacy"];
  buildReservationBudget: StageRunner["buildReservationBudget"];
  armProtectionForFill: StageRunner["armProtectionForFill"];
  persistAlert: StageRunner["persistAlert"];
  readCyclePlan: StageRunner["readCyclePlan"];
  loadPlan: StageRunner["loadPlan"];
};
