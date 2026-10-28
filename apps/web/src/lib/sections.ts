import type { TerminalSection } from "@/lib/types";

export const SECTIONS: Array<{ id: TerminalSection; label: string; group: string }> = [
  { id: "overview", label: "Overview", group: "Command" },
  { id: "radar", label: "Market Scanner", group: "Command" },
  { id: "agents", label: "Agent Intelligence", group: "Command" },
  { id: "markets", label: "Market Selector", group: "Command" },
  { id: "trading", label: "Trading Terminal", group: "Execution" },
  { id: "portfolio", label: "Portfolio", group: "Execution" },
  { id: "positions", label: "Positions", group: "Execution" },
  { id: "history", label: "Trade History", group: "Execution" },
  { id: "strategy", label: "Strategy Laboratory", group: "Research" },
  { id: "backtesting", label: "Backtesting", group: "Research" },
  { id: "research", label: "AI Research Centre", group: "Research" },
  { id: "operations", label: "Research Operations", group: "Research" },
  { id: "forge", label: "FORGE Monitor", group: "Research" },
  { id: "genome", label: "Strategy Evolution", group: "Research" },
  { id: "integrity", label: "Data Integrity", group: "Research" },
  { id: "confidence", label: "Research Confidence", group: "Research" },
  { id: "memory", label: "Research Memory", group: "Research" },
  { id: "risk", label: "Risk Management", group: "Research" },
  { id: "models", label: "AI Model Operations", group: "Ops" },
  { id: "autonomy", label: "Autonomy Control", group: "Ops" },
  { id: "logs", label: "System Logs", group: "Ops" },
  { id: "settings", label: "Settings", group: "Ops" },
];

export function parseSection(value: string | undefined): TerminalSection {
  const match = SECTIONS.find((section) => section.id === value);
  return match?.id ?? "overview";
}
