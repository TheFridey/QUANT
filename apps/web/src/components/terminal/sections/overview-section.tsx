"use client";

import { useState } from "react";
import { AgentDrawer } from "@/components/terminal/agent-drawer";
import { DecisionFeed } from "@/components/terminal/sections/decision-feed";
import { PerformanceSection } from "@/components/terminal/sections/performance-section";
import { PortfolioSection } from "@/components/terminal/sections/portfolio-section";
import { PositionsSection } from "@/components/terminal/sections/positions-section";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { AGENT_PIPELINE } from "@/lib/agents";
import { formatLondon, formatLondonDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function OverviewSection() {
  const { snapshot } = useSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  if (!snapshot) return null;
  const status = snapshot.agents ?? [];

  const fixtureMode = snapshot.execution?.fixtureMode === true
    || snapshot.execution?.tradingEnvironment === "FIXTURE";
  const replayMode = snapshot.execution?.replayMode === true
    || snapshot.execution?.tradingEnvironment === "REPLAY";
  const unresolved = snapshot.execution?.unresolvedProtection ?? 0;

  return (
    <div className="space-y-3">
      {fixtureMode ? (
        <div
          role="status"
          className="rounded border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-100"
        >
          <strong className="font-semibold tracking-wide">FIXTURE MODE</strong>
          <span className="ml-2 text-amber-100/80">
            Synthetic sequences only — isolated from market-data paper accounts, metrics, and reports.
          </span>
        </div>
      ) : null}
      {replayMode ? (
        <div
          role="status"
          className="rounded border border-sky-800/50 bg-sky-950/30 px-4 py-3 text-sm text-sky-100"
        >
          <strong className="font-semibold tracking-wide">REPLAY MODE</strong>
          <span className="ml-2 text-sky-100/80">
            Metrics/funnel scoped to {snapshot.execution?.metricsAccountId ?? "primary:replay"} — not mixed into paper.
          </span>
        </div>
      ) : null}
      {unresolved > 0 ? (
        <div
          role="status"
          className="rounded border border-rose-800/50 bg-rose-950/30 px-4 py-3 text-sm text-rose-100"
        >
          <strong className="font-semibold tracking-wide">UNRESOLVED PROTECTION</strong>
          <span className="ml-2 text-rose-100/80">
            {unresolved} durable exit intent{unresolved === 1 ? "" : "s"} awaiting retry — ACK of alerts does not clear these.
          </span>
        </div>
      ) : null}
      <PortfolioSection />
      <Panel title="Agent pipeline" extra="Click a card for inputs / outputs">
        <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {AGENT_PIPELINE.map((agent) => {
            const row = status.find((item) => item.agent === agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelected(agent.id)}
                className={cn(
                  "rounded border border-border bg-panel/60 p-3 text-left transition-colors hover:bg-white/[0.03]",
                  row?.decision && "border-white/10",
                )}
              >
                <div className="text-[11px] font-medium tracking-[0.08em]" style={{ color: agent.accent }}>
                  {agent.id}
                </div>
                <div className="mt-1 text-[11px] text-muted">{agent.role}</div>
                <div className="mono mt-3 text-sm">{row?.decision ?? "IDLE"}</div>
                <div className="mt-2 truncate text-[10px] text-muted">
                  {row?.createdAt ? formatLondon(row.createdAt) : "—"} · {row?.durationMs != null ? `${row.durationMs}ms` : "—"}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <div className="space-y-3">
          <PositionsSection />
          <PerformanceSection />
          <Panel title="Market radar snapshot" extra={`${(snapshot.watchlist ?? []).length} ranked`}>
            {(snapshot.watchlist ?? []).length === 0 ? (
              <EmptyState title="Watchlist empty" detail="Open Market Scanner once entries exist." />
            ) : (
              <ul className="divide-y divide-border/70 text-xs">
                {(snapshot.watchlist ?? []).slice(0, 8).map((row) => (
                  <li key={row.pairAddress} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>
                      #{row.rank} {row.baseSymbol}/{row.quoteSymbol}
                    </span>
                    <span className="mono text-muted">{row.recommendation ? `${row.recommendation.agent} ${row.recommendation.decision}` : row.score}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="space-y-3">
          <DecisionFeed compact />
          <Panel title="System pulse">
            <dl className="grid grid-cols-2 gap-3 p-3 text-xs">
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Engine</dt>
                <dd>{snapshot.engine.status}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Execution</dt>
                <dd className="uppercase mono">{snapshot.execution?.mode ?? "PAPER"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Market mode</dt>
                <dd className="uppercase">{snapshot.market.mode}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Last cycle</dt>
                <dd>{snapshot.cycle ? formatLondonDateTime(snapshot.cycle.startedAt) : "—"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Observations</dt>
                <dd className="mono">{snapshot.cycle?.observationCount ?? 0}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Open alerts</dt>
                <dd className="mono">{snapshot.alerts?.length ?? 0}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Provider readiness</dt>
                <dd className="mono text-[10px]">
                  A:{snapshot.execution?.providerReadiness?.alpaca_paper ?? "—"} · O:
                  {snapshot.execution?.providerReadiness?.oanda_practice ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Environment</dt>
                <dd className="mono">{snapshot.execution?.tradingEnvironment ?? "MARKET_DATA_PAPER"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Active strategy</dt>
                <dd className="mono truncate">
                  {snapshot.activeStrategy
                    ? `${snapshot.activeStrategy.strategyId}@${snapshot.activeStrategy.strategyVersion}`
                    : "default PULSE"}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Server time</dt>
                <dd className="mono">{formatLondonDateTime(snapshot.serverTime)}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
      <AgentDrawer agent={selected} open={selected !== null} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
