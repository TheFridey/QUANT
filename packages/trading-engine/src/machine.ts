import type { EngineAction, EngineStatus } from "@odin/shared";

const TRANSITIONS: Record<EngineAction, Partial<Record<EngineStatus, EngineStatus>>> = {
  start: { STOPPED: "RUNNING" },
  pause: { RUNNING: "PAUSED" },
  resume: { PAUSED: "RUNNING", EMERGENCY_STOP: "RUNNING" },
  emergency_stop: {
    RUNNING: "EMERGENCY_STOP",
    PAUSED: "EMERGENCY_STOP",
    STOPPED: "EMERGENCY_STOP",
  },
  stop: { PAUSED: "STOPPED", EMERGENCY_STOP: "STOPPED" },
};

export function transition(from: EngineStatus, action: EngineAction): EngineStatus | null {
  return TRANSITIONS[action][from] ?? null;
}

export function allowedActions(from: EngineStatus): EngineAction[] {
  return (Object.keys(TRANSITIONS) as EngineAction[]).filter((action) => transition(from, action) !== null);
}
