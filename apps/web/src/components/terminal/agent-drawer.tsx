"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { agentMeta } from "@/lib/agents";
import { formatLondonDateTime } from "@/lib/format";
import type { Decision } from "@/lib/types";
import { SkeletonBlock } from "@/components/terminal/panel";

type AgentDetail = {
  agent: string;
  latest: (Decision & { input?: unknown; output?: unknown }) | null;
  recent: Decision[];
};

export function AgentDrawer({
  agent,
  open,
  onOpenChange,
}: {
  agent: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const meta = agent ? agentMeta(agent) : null;

  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<AgentDetail>(`/terminal/agents/${encodeURIComponent(agent)}`)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load agent");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogTitle className="flex items-center gap-2 text-lg">
          <span className="h-2 w-2 rounded-full" style={{ background: meta?.accent }} />
          {agent}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted">{meta?.role} · latest cycle inputs, outputs, and reasoning</DialogDescription>
        {loading ? (
          <div className="mt-4 space-y-2">
            <SkeletonBlock className="h-16 w-full" />
            <SkeletonBlock className="h-40 w-full" />
          </div>
        ) : null}
        {error ? <p className="mt-4 text-sm text-loss">{error}</p> : null}
        {!loading && detail?.latest == null ? <p className="mt-4 text-sm text-muted">No decisions recorded for this agent yet.</p> : null}
        {detail?.latest ? (
          <div className="mt-4 space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Decision" value={detail.latest.decision} />
              <Field label="Confidence" value={detail.latest.confidence} />
              <Field label="Latency" value={detail.latest.durationMs != null ? `${detail.latest.durationMs}ms` : "—"} />
              <Field label="Source" value={detail.latest.inputSource ?? "—"} />
            </div>
            <Field label="Executed" value={formatLondonDateTime(detail.latest.createdAt)} />
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted">Reasoning</div>
              <ul className="space-y-1 text-xs text-muted">
                {detail.latest.reasonText.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
            </div>
            <JsonBlock title="Inputs" value={detail.latest.input} />
            <JsonBlock title="Outputs" value={detail.latest.output} />
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted">Recent decisions</div>
              <ul className="max-h-40 space-y-1 overflow-auto text-xs">
                {detail.recent.map((item) => (
                  <li key={item.id} className="flex justify-between gap-2 border-b border-border/60 py-1">
                    <span>
                      {item.decision}
                      {item.pairAddress ? ` · ${item.pairAddress.slice(0, 6)}…` : ""}
                    </span>
                    <span className="mono text-muted">{formatLondonDateTime(item.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mono mt-1 text-sm">{value}</div>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted">{title}</div>
      <pre className="max-h-48 overflow-auto rounded border border-border bg-panel p-2 text-[11px] text-muted">
        {value === undefined || value === null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
