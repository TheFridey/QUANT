"use client";

import { useEffect, useState } from "react";
import { EmptyState, Panel, SkeletonBlock } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatLondonDateTime } from "@/lib/format";
import type { ActivityEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

export function DecisionFeed({ compact = false }: { compact?: boolean }) {
  const { snapshot } = useSnapshot();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ events: ActivityEvent[] }>("/terminal/activity?limit=80")
      .then((result) => {
        if (!cancelled) {
          setEvents(result.events);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Activity feed failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot?.serverTime]);

  return (
    <Panel title="Decision feed" extra="SCAN · SIGNAL · SECURITY · RISK · ORDER · FILL">
      {loading ? (
        <div className="space-y-2 p-3">
          <SkeletonBlock className="h-8 w-full" />
          <SkeletonBlock className="h-8 w-full" />
          <SkeletonBlock className="h-8 w-full" />
        </div>
      ) : null}
      {error ? <p className="p-3 text-sm text-loss">{error}</p> : null}
      {!loading && events.length === 0 ? <EmptyState title="No activity yet" detail="Agent decisions, orders, fills, and cycle warnings appear here." /> : null}
      <ul className={cn("divide-y divide-border/70", compact && "max-h-[360px] overflow-auto")}>
        {events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-white/[0.02]"
              onClick={() => setExpanded((current) => (current === event.id ? null : event.id))}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-[10px] text-muted">{formatLondonDateTime(event.timestamp)}</span>
                <Badge className={kindClass(event.kind)}>{event.kind.replaceAll("_", " ")}</Badge>
                <span className="text-[11px] text-muted">{event.source}</span>
              </div>
              <div className="text-xs">{event.summary}</div>
              {expanded === event.id ? (
                <pre className="mt-1 overflow-auto rounded border border-border bg-panel p-2 text-[10px] text-muted">
                  {JSON.stringify(event.details, null, 2)}
                </pre>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function kindClass(kind: string) {
  if (kind.includes("BLOCK") || kind.includes("REJECT") || kind.includes("WARNING")) return "border-loss/40 text-loss";
  if (kind.includes("FILL") || kind.includes("PASS") || kind === "EXIT") return "border-profit/40 text-profit";
  if (kind.includes("ORDER")) return "border-primary/40 text-primary";
  return "border-border text-muted";
}
