"use client";

import { CommandBar } from "@/components/terminal/command-bar";
import { MobileNav, Sidebar } from "@/components/terminal/sidebar";
import { SnapshotProvider, useSnapshot } from "@/components/terminal/snapshot-context";
import { AgentsSection } from "@/components/terminal/sections/agents-section";
import { BacktestingSection } from "@/components/terminal/sections/backtesting-section";
import { DecisionFeed } from "@/components/terminal/sections/decision-feed";
import {
  AutonomySection,
  GenomeSection,
  MarketSelectorSection,
  ModelOpsSection,
  ResearchCentreSection,
  ResearchMemorySection,
} from "@/components/terminal/sections/evolution-sections";
import {
  DataIntegritySection,
  ForgeMonitorSection,
  ResearchConfidenceSection,
  ResearchOperationsSection,
} from "@/components/terminal/sections/genesis-panels";
import { HistorySection } from "@/components/terminal/sections/history-section";
import { LogsSection } from "@/components/terminal/sections/logs-section";
import { OverviewSection } from "@/components/terminal/sections/overview-section";
import { PerformanceSection } from "@/components/terminal/sections/performance-section";
import { PortfolioSection } from "@/components/terminal/sections/portfolio-section";
import { PositionsSection } from "@/components/terminal/sections/positions-section";
import { RadarSection } from "@/components/terminal/sections/radar-section";
import { RiskSection } from "@/components/terminal/sections/risk-section";
import { SettingsSection } from "@/components/terminal/sections/settings-section";
import { StrategySection } from "@/components/terminal/sections/strategy-section";
import { TradingSection } from "@/components/terminal/sections/trading-section";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/terminal/panel";
import { SECTIONS } from "@/lib/sections";
import type { TerminalSection } from "@/lib/types";

export function CommandShell({ section }: { section: TerminalSection }) {
  return (
    <SnapshotProvider>
      <ShellFrame section={section} />
    </SnapshotProvider>
  );
}

function ShellFrame({ section }: { section: TerminalSection }) {
  const { loading, snapshot, refresh, error } = useSnapshot();
  const sectionDef = SECTIONS.find((item) => item.id === section);
  const label = sectionDef?.label ?? "Overview";
  const group = sectionDef?.group ?? "Desk";

  if (loading) {
    return (
      <main className="flex h-screen flex-col">
        <div className="border-b border-border px-4 py-3">
          <SkeletonBlock className="h-8 w-64" />
        </div>
        <div className="grid flex-1 gap-3 p-3 md:grid-cols-[220px_minmax(0,1fr)]">
          <SkeletonBlock className="hidden h-full md:block" />
          <div className="space-y-3">
            <SkeletonBlock className="h-24 w-full" />
            <SkeletonBlock className="h-64 w-full" />
          </div>
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <div className="panel max-w-md space-y-3 rounded-md p-6 text-center">
          <h1 className="text-xl tracking-[0.08em]">ODIN // QUANT</h1>
          <p className="text-sm text-loss">{error ?? "The terminal could not read the book."}</p>
          <Button onClick={() => void refresh()}>Retry snapshot</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <CommandBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar active={section} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav active={section} />
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                {group} · Module
              </div>
              <h1 className="text-sm font-medium">{label}</h1>
            </div>
            <Button size="xs" variant="outline" onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scroll-thin p-3">{renderSection(section)}</div>
        </div>
      </div>
    </main>
  );
}

function renderSection(section: TerminalSection) {
  switch (section) {
    case "overview":
      return <OverviewSection />;
    case "radar":
      return <RadarSection />;
    case "agents":
      return <AgentsSection />;
    case "markets":
      return <MarketSelectorSection />;
    case "trading":
      return <TradingSection />;
    case "portfolio":
      return (
        <div className="space-y-3">
          <PortfolioSection />
          <PerformanceSection />
        </div>
      );
    case "positions":
      return <PositionsSection />;
    case "history":
      return <HistorySection />;
    case "strategy":
      return <StrategySection />;
    case "backtesting":
      return <BacktestingSection />;
    case "research":
      return <ResearchCentreSection />;
    case "operations":
      return <ResearchOperationsSection />;
    case "forge":
      return <ForgeMonitorSection />;
    case "genome":
      return <GenomeSection />;
    case "integrity":
      return <DataIntegritySection />;
    case "confidence":
      return <ResearchConfidenceSection />;
    case "memory":
      return <ResearchMemorySection />;
    case "risk":
      return <RiskSection />;
    case "models":
      return <ModelOpsSection />;
    case "autonomy":
      return <AutonomySection />;
    case "logs":
      return (
        <div className="space-y-3">
          <LogsSection />
          <DecisionFeed />
        </div>
      );
    case "settings":
      return <SettingsSection />;
    default:
      return <OverviewSection />;
  }
}
