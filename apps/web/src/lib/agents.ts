export const AGENT_PIPELINE = [
  { id: "SENTINEL", role: "Universe scan", accent: "#7eb6ff" },
  { id: "PULSE", role: "Momentum signal", accent: "#35e0c4" },
  { id: "AEGIS", role: "Security gate", accent: "#f5b95e" },
  { id: "ATLAS", role: "Risk sizing", accent: "#c4a1ff" },
  { id: "EXECUTOR", role: "Paper routing", accent: "#f36b7c" },
  { id: "ARCHIVIST", role: "Audit & research", accent: "#8b9bb3" },
] as const;

/** Supervisory advisory module — not part of the live paper fill pipeline. */
export const ORACLE_AGENT = {
  id: "ORACLE",
  role: "Research supervisor (advisory)",
  accent: "#94a3b8",
} as const;

export type AgentId = (typeof AGENT_PIPELINE)[number]["id"] | typeof ORACLE_AGENT.id;

export function agentMeta(agent: string) {
  if (agent === ORACLE_AGENT.id) return ORACLE_AGENT;
  return AGENT_PIPELINE.find((item) => item.id === agent) ?? {
    id: agent,
    role: "Agent",
    accent: "#8b9bb3",
  };
}
