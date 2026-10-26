export const AGENT_PIPELINE = [
  { id: "SENTINEL", role: "Universe scan", accent: "#7eb6ff" },
  { id: "PULSE", role: "Momentum signal", accent: "#35e0c4" },
  { id: "AEGIS", role: "Security gate", accent: "#f5b95e" },
  { id: "ATLAS", role: "Risk sizing", accent: "#c4a1ff" },
  { id: "EXECUTOR", role: "Paper routing", accent: "#f36b7c" },
  { id: "ARCHIVIST", role: "Audit & research", accent: "#8b9bb3" },
] as const;

export type AgentId = (typeof AGENT_PIPELINE)[number]["id"];

export function agentMeta(agent: string) {
  return AGENT_PIPELINE.find((item) => item.id === agent) ?? {
    id: agent,
    role: "Agent",
    accent: "#8b9bb3",
  };
}
