"use client";

import { useEffect, useState } from "react";
import { EmptyState, Panel, SkeletonBlock } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatLondonDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type LogEntry = {
  id: string;
  level: string;
  timestamp: string;
  stage: string;
  status: string;
  trigger: string;
  dataState: string;
  message: string;
  observationCount: number;
  orderCount: number;
  finishedAt: string | null;
};

export function LogsSection() {
  const { snapshot } = useSnapshot();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ entries: LogEntry[] }>("/terminal/logs?limit=100")
      .then((result) => {
        if (!cancelled) {
          setEntries(result.entries);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Logs failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot?.serverTime]);

  return (
    <Panel title="System logs" extra="CycleRun ledger" className="animate-odin-fade">
      {loading ? (
        <div className="space-y-2 p-3">
          <SkeletonBlock className="h-8 w-full" />
          <SkeletonBlock className="h-8 w-full" />
        </div>
      ) : null}
      {error ? <p className="p-3 text-sm text-loss">{error}</p> : null}
      {!loading && entries.length === 0 ? <EmptyState title="No cycle logs" /> : null}
      <ul className="divide-y divide-border/70">
        {entries.map((entry) => (
          <li key={entry.id} className="px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-muted">{formatLondonDateTime(entry.timestamp)}</span>
              <Badge className={cn(entry.level === "error" ? "border-loss/40 text-loss" : entry.level === "warn" ? "border-warning/40 text-warning" : "")}>
                {entry.level}
              </Badge>
              <span>{entry.trigger}</span>
              <span className="text-muted">{entry.stage}</span>
              <span className="text-muted">{entry.status}</span>
            </div>
            <div className="mt-1">{entry.message}</div>
            <div className="mt-1 text-[10px] text-muted">
              obs {entry.observationCount} · orders {entry.orderCount} · data {entry.dataState}
              {entry.finishedAt ? ` · finished ${formatLondonDateTime(entry.finishedAt)}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
