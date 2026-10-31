"use client";

import { useState } from "react";
import { AgentDrawer } from "@/components/terminal/agent-drawer";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { AGENT_PIPELINE, agentMeta } from "@/lib/agents";
import { formatLondon, formatLondonDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AgentsSection() {
  const { snapshot } = useSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  if (!snapshot) return null;
  const status = snapshot.agents ?? [];

  return (
    <div className="space-y-3 animate-odin-fade">
      <Panel title="Agent pipeline" extra="SENTINEL → ARCHIVIST · click for drawer">
        <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {AGENT_PIPELINE.map((agent, index) => {
            const row = status.find((item) => item.agent === agent.id);
            const previous = index > 0 ? status.find((item) => item.agent === AGENT_PIPELINE[index - 1]!.id) : null;
            const active = Boolean(row?.decision);
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelected(agent.id)}
                className={cn(
                  "rounded border border-border bg-panel/60 p-3 text-left transition-colors hover:bg-white/[0.03]",
                  active && "border-white/10",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium tracking-[0.08em]" style={{ color: agent.accent }}>
                    {agent.id}
                  </span>
                  <span className="text-[10px] text-muted">{index + 1}/6</span>
                </div>
                <div className="mt-1 text-[11px] text-muted">{agent.role}</div>
                <div className="mono mt-3 text-sm">{row?.decision ?? "IDLE"}</div>
                <div className="mt-2 space-y-1 text-[10px] text-muted">
                  <div>Last {row?.createdAt ? formatLondon(row.createdAt) : "—"}</div>
                  <div className="truncate">Decision · {row?.outcome ?? "—"}</div>
                  <div>
                    {row?.durationMs != null ? `${row.durationMs}ms` : "—"} · {row?.inputSource ?? "—"}
                  </div>
                  <div className="truncate text-loss">{row?.reasonCodes.some((code) => /FAIL|ERROR|BLOCK|REJECT/i.test(code)) ? row.reasonCodes[0] : "No errors"}</div>
                </div>
                {previous?.decision && row?.decision ? (
                  <div className="mt-2 h-0.5 overflow-hidden rounded bg-border">
                    <div className="h-full w-full bg-profit/50 transition-all" />
                  </div>
                ) : (
                  <div className="mt-2 h-0.5 rounded bg-border" />
                )}
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Latest cycle decisions" extra={`${snapshot.decisions.length} rows`}>
        {snapshot.decisions.length === 0 ? (
          <EmptyState title="No decisions in the latest cycle" detail="Start the engine to run the agent pipeline." />
        ) : (
          <div className="overflow-auto" role="region" aria-label="Scrollable table" tabIndex={0}>
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Decision</th>
                  <th className="px-3 py-2 font-medium">Latency</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {[...snapshot.decisions].reverse().map((decision) => {
                  const meta = agentMeta(decision.agent);
                  return (
                    <tr key={decision.id} className="border-b border-border/70 hover:bg-white/[0.02]">
                      <td className="mono px-3 py-2 text-muted">{formatLondonDateTime(decision.createdAt)}</td>
                      <td className="px-3 py-2" style={{ color: meta.accent }}>
                        {decision.agent}
                      </td>
                      <td className="px-3 py-2">{decision.decision}</td>
                      <td className="mono px-3 py-2">{decision.durationMs != null ? `${decision.durationMs}ms` : "—"}</td>
                      <td className="px-3 py-2 text-muted">{decision.inputSource ?? "—"}</td>
                      <td className="max-w-[320px] truncate px-3 py-2 text-muted">{decision.reasonText.join(" · ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <AgentDrawer agent={selected} open={selected !== null} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
