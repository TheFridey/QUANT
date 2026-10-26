export const DATA_STATES = ["LIVE", "DELAYED", "STALE", "REPLAY", "DEMO"] as const;
export type DataState = (typeof DATA_STATES)[number];

export const DATA_MODES = ["live", "replay", "demo"] as const;
export type DataMode = (typeof DATA_MODES)[number];

const WORST_RANK: Record<DataState, number> = {
  LIVE: 0,
  DELAYED: 1,
  STALE: 2,
  REPLAY: 3,
  DEMO: 4,
};

export function classifyFreshness(input: {
  mode: DataMode;
  receivedAt: Date;
  now: Date;
  liveMaxAgeMs: number;
  delayedMaxAgeMs: number;
}): DataState {
  if (input.mode === "demo") return "DEMO";
  if (input.mode === "replay") return "REPLAY";
  const age = input.now.getTime() - input.receivedAt.getTime();
  if (!Number.isFinite(age) || age < 0) return "STALE";
  if (age <= input.liveMaxAgeMs) return "LIVE";
  if (age <= input.delayedMaxAgeMs) return "DELAYED";
  return "STALE";
}

export function worstDataState(states: DataState[]): DataState | null {
  if (states.length === 0) return null;
  return states.reduce((worst, state) => (WORST_RANK[state] > WORST_RANK[worst] ? state : worst));
}
