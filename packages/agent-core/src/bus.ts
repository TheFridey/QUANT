import { QUEUES, type QueueName } from "@odin/shared";

export type AgentBusEvent = {
  cycleId: string;
  stage: string;
  at: string;
};

export const STAGE_AFTER: Record<string, QueueName | null> = {
  ingest: QUEUES.sentinel,
  sentinel: QUEUES.pulse,
  pulse: QUEUES.aegis,
  aegis: QUEUES.atlas,
  atlas: QUEUES.executor,
  executor: QUEUES.archivist,
  archivist: null,
};
