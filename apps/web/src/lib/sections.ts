import type { TerminalSection } from "@/lib/types";

/** Primary nav pillars — specialised modules nest under these groups. */
export const NAV_GROUPS = [
  "Desk",
  "Markets",
  "Orders & Positions",
  "Strategies",
  "Research",
  "Operations",
] as const;

export type NavGroup = (typeof NAV_GROUPS)[number];

export type SectionDef = {
  id: TerminalSection;
  label: string;
  group: NavGroup;
  /** Short label for compact mobile chips inside a group. */
  shortLabel?: string;
};

/**
 * All modules remain reachable via deep links. Groups condense the primary
 * strip so mobile is not 22 flat items (D24).
 */
export const SECTIONS: SectionDef[] = [
  { id: "overview", label: "Overview", group: "Desk", shortLabel: "Overview" },
  { id: "agents", label: "Agent Intelligence", group: "Desk", shortLabel: "Agents" },
  { id: "radar", label: "Market Scanner", group: "Markets", shortLabel: "Scanner" },
  { id: "markets", label: "Market Selector", group: "Markets", shortLabel: "Selector" },
  { id: "trading", label: "Trading Terminal", group: "Orders & Positions", shortLabel: "Ticket" },
  { id: "portfolio", label: "Portfolio", group: "Orders & Positions", shortLabel: "Portfolio" },
  { id: "positions", label: "Positions", group: "Orders & Positions", shortLabel: "Positions" },
  { id: "history", label: "Trade History", group: "Orders & Positions", shortLabel: "History" },
  { id: "strategy", label: "Strategy Laboratory", group: "Strategies", shortLabel: "Lab" },
  { id: "backtesting", label: "Backtesting", group: "Strategies", shortLabel: "Backtest" },
  { id: "risk", label: "Risk Management", group: "Strategies", shortLabel: "Risk" },
  { id: "research", label: "AI Research Centre", group: "Research", shortLabel: "Centre" },
  { id: "operations", label: "Research Operations", group: "Research", shortLabel: "Ops" },
  { id: "forge", label: "FORGE Monitor", group: "Research", shortLabel: "FORGE" },
  { id: "genome", label: "Strategy Evolution", group: "Research", shortLabel: "Genome" },
  { id: "integrity", label: "Data Integrity", group: "Research", shortLabel: "Integrity" },
  { id: "confidence", label: "Research Confidence", group: "Research", shortLabel: "Confidence" },
  { id: "memory", label: "Research Memory", group: "Research", shortLabel: "Memory" },
  { id: "models", label: "AI Model Operations", group: "Operations", shortLabel: "Models" },
  { id: "autonomy", label: "Autonomy Control", group: "Operations", shortLabel: "Autonomy" },
  { id: "logs", label: "System Logs", group: "Operations", shortLabel: "Logs" },
  { id: "settings", label: "Settings", group: "Operations", shortLabel: "Settings" },
];

export function sectionHref(id: TerminalSection): string {
  return id === "overview" ? "/terminal" : `/terminal/${id}`;
}

export function parseSection(value: string | undefined): TerminalSection {
  const match = SECTIONS.find((section) => section.id === value);
  return match?.id ?? "overview";
}

export function groupForSection(id: TerminalSection): NavGroup {
  return SECTIONS.find((section) => section.id === id)?.group ?? "Desk";
}

export function sectionsInGroup(group: NavGroup): SectionDef[] {
  return SECTIONS.filter((section) => section.group === group);
}
