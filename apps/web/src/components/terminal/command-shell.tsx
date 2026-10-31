"use client";

import { CommandBar } from "@/components/terminal/command-bar";
import { MobileNav, Sidebar } from "@/components/terminal/sidebar";
import { useSnapshot } from "@/components/terminal/snapshot-context";
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
import { CapacitySection } from "@/components/terminal/sections/capacity-section";
import { RiskSection } from "@/components/terminal/sections/risk-section";
import { SettingsSection } from "@/components/terminal/sections/settings-section";
import { StrategySection } from "@/components/terminal/sections/strategy-section";
import { TradingSection } from "@/components/terminal/sections/trading-section";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/terminal/panel";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RESEARCH_TABS, SECTIONS, parseResearchTab } from "@/lib/sections";
import { cn } from "@/lib/utils";
import type { TerminalSection } from "@/lib/types";

export function CommandShell({ section }: { section: TerminalSection }) {
  // The SnapshotProvider is in app/terminal/layout.tsx so it survives section navigation (UI item 15).
  return <ShellFrame section={section} />;
}

function ShellFrame({ section }: { section: TerminalSection }) {
  const { loading, snapshot, refresh, error, lastRefreshAt } = useSnapshot();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const ageSeconds = lastRefreshAt ? Math.max(0, Math.round((Date.now() - new Date(lastRefreshAt).getTime()) / 1000)) : null;
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
                {group}
              </div>
              <h1 className="text-sm font-medium">{label}</h1>
            </div>
            <span className={cn("ml-auto mr-2 text-[11px]", ageSeconds !== null && ageSeconds > 30 ? "text-warning" : "text-muted")} aria-live="off">
              {ageSeconds === null ? "Not yet updated" : ageSeconds < 2 ? "Updated just now" : `Updated ${ageSeconds}s ago`}
            </span>
            <Button size="xs" variant="outline" onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
          {/* Focusable so keyboard users can scroll the section (axe scrollable-region-focusable). */}
          <div
            role="region"
            aria-label="Section content"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto scroll-thin p-3"
          >
            {renderSection(section)}
          </div>
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
    case "operations":
    case "forge":
    case "genome":
    case "integrity":
    case "confidence":
    case "memory":
      return (
        <Suspense fallback={null}>
          <ResearchPage fallbackTab={section} />
        </Suspense>
      );
    case "risk":
      return <RiskSection />;
    case "capacity":
      return <CapacitySection />;
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

/** UI item 13: one Research page; the former sub-pages are tabs selected by ?tab=. */
function ResearchPage({ fallbackTab }: { fallbackTab: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const active = parseResearchTab(params.get("tab") ?? fallbackTab);
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Research views" className="flex flex-wrap gap-1 border-b border-border pb-2">
        {RESEARCH_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`research-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls="research-tabpanel"
            onClick={() => router.replace(`/terminal/research?tab=${tab.id}`)}
            className={cn(
              "rounded px-3 py-1.5 text-xs",
              active === tab.id ? "bg-primary/15 text-primary" : "text-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="research-tabpanel" aria-labelledby={`research-tab-${active}`}>
        {active === "research" ? <ResearchCentreSection /> : null}
        {active === "operations" ? <ResearchOperationsSection /> : null}
        {active === "forge" ? <ForgeMonitorSection /> : null}
        {active === "genome" ? <GenomeSection /> : null}
        {active === "integrity" ? <DataIntegritySection /> : null}
        {active === "confidence" ? <ResearchConfidenceSection /> : null}
        {active === "memory" ? <ResearchMemorySection /> : null}
      </div>
    </div>
  );
}
