"use client";

import { useEffect, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { api } from "@/lib/api";

type Tone = "open" | "recorded" | "measured";

function toneClass(tone: Tone | string): string {
  if (tone === "recorded") return "border-warning/40 text-warning";
  if (tone === "measured") return "border-border text-foreground";
  return "border-border text-muted";
}

export function ResearchOperationsSection() {
  const [data, setData] = useState<{
    queue: Array<{ id: string; capability?: string; kind: string; status: string; reason: string; aiDiscovery?: boolean; provenance?: string }>;
    oracle?: {
      capabilities: string[];
      limits: { maxExperimentsPerCycle: number; maxSpendUsdPerDay: string; maxConcurrent: number; maxRetries: number; maxRepeatedFailures: number };
      proposals: Array<{ capability: string; aiDiscovery: boolean; provenance: string; returnPct: string | null }>;
    };
  } | null>(null);

  useEffect(() => {
    void api<NonNullable<typeof data>>("/evolution/research").then(setData).catch(() => setData(null));
  }, []);

  return (
    <div className="grid gap-3 lg:grid-cols-2 animate-odin-fade">
      <Panel title="Research Operations" extra="Persisted queue">
        {!data ? (
          <EmptyState title="Research queue unavailable" />
        ) : (
          <ul className="divide-y divide-border text-xs">
            {data.queue.slice(0, 20).map((item) => (
              <li key={item.id} className="px-3 py-2">
                <div className="flex justify-between gap-2">
                  <span>{item.capability ?? item.kind}</span>
                  <span className="text-muted">{item.status}</span>
                </div>
                <div className="mt-1 text-muted">
                  {item.provenance ?? "unlabelled"} · discovery {String(item.aiDiscovery ?? false)} · {item.reason}
                </div>
              </li>
            ))}
            {data.queue.length === 0 ? <li className="p-3 text-muted">Queue is empty.</li> : null}
          </ul>
        )}
      </Panel>
      <Panel title="Supervisor limits">
        {!data?.oracle ? (
          <EmptyState title="Supervisor snapshot unavailable" />
        ) : (
          <div className="space-y-2 p-3 text-xs">
            <p className="text-muted">
              Cycle {data.oracle.limits.maxExperimentsPerCycle} · spend ${data.oracle.limits.maxSpendUsdPerDay} · concurrent{" "}
              {data.oracle.limits.maxConcurrent} · retries {data.oracle.limits.maxRetries} · failures{" "}
              {data.oracle.limits.maxRepeatedFailures}
            </p>
            <ul className="space-y-1">
              {data.oracle.proposals.map((proposal) => (
                <li key={proposal.capability} className="flex justify-between gap-2">
                  <span>{proposal.capability}</span>
                  <span className="text-muted">
                    {proposal.provenance} · return {proposal.returnPct ?? "unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function ForgeMonitorSection() {
  const [data, setData] = useState<{
    runs: Array<{
      id: string;
      strategyVersion: string;
      approvalStatus: string;
      codeHash: string | null;
      returnPct: string | null;
      pipelineCompleted: boolean;
      resultsMeasurable: boolean;
      deploymentEligible: boolean;
    }>;
  } | null>(null);

  useEffect(() => {
    void api<NonNullable<typeof data>>("/evolution/forge").then(setData).catch(() => setData(null));
  }, []);

  return (
    <Panel title="FORGE Monitor" extra="Persisted reports">
      {!data ? (
        <EmptyState title="Forge reports unavailable" />
      ) : (
        <ul className="divide-y divide-border text-xs">
          {data.runs.map((run) => (
            <li key={run.id} className="px-3 py-2">
              <div className="flex justify-between gap-2">
                <span className="mono">{run.strategyVersion}</span>
                <span className="text-muted">{run.approvalStatus}</span>
              </div>
              <div className="mt-1 text-muted">
                hash {run.codeHash?.slice(0, 12) ?? "none"} · return {run.returnPct ?? "unavailable"} · pipeline{" "}
                {run.pipelineCompleted ? "recorded" : "open"} · measurable {String(run.resultsMeasurable)} · eligible{" "}
                {String(run.deploymentEligible)}
              </div>
            </li>
          ))}
          {data.runs.length === 0 ? <li className="p-3 text-muted">No forged reports stored.</li> : null}
        </ul>
      )}
    </Panel>
  );
}

export function DataIntegritySection() {
  const [data, setData] = useState<{
    observationCount: number;
    usableCount: number;
    blocking: boolean;
    issues: Array<{ code: string; severity: string; detail: string }>;
  } | null>(null);

  useEffect(() => {
    void api<NonNullable<typeof data>>("/evolution/integrity").then(setData).catch(() => setData(null));
  }, []);

  return (
    <Panel title="Data Integrity" extra="Persisted observations">
      {!data ? (
        <EmptyState title="Integrity snapshot unavailable" />
      ) : (
        <div className="space-y-2 p-3 text-xs">
          <p className="text-muted">
            Observations {data.observationCount} · usable {data.usableCount} · blocking {String(data.blocking)}
          </p>
          <ul className="space-y-1">
            {data.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <span className={issue.severity === "block" ? "text-loss" : "text-warning"}>{issue.code}</span>{" "}
                <span className="text-muted">{issue.detail}</span>
              </li>
            ))}
            {data.issues.length === 0 ? <li className="text-muted">No integrity issues in the loaded window.</li> : null}
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function ResearchConfidenceSection() {
  const [data, setData] = useState<{
    reportId: string | null;
    returnPct: string | null;
    note: string;
    outcomes: Array<{ name: string; met: boolean; detail: string; tone: Tone }>;
  } | null>(null);

  useEffect(() => {
    void api<NonNullable<typeof data>>("/evolution/confidence").then(setData).catch(() => setData(null));
  }, []);

  return (
    <Panel title="Research Confidence" extra="Not a profit signal">
      {!data ? (
        <EmptyState title="Confidence snapshot unavailable" />
      ) : (
        <div className="space-y-3 p-3 text-xs">
          <p className="text-muted">{data.note}</p>
          <p className="text-muted">Report {data.reportId ?? "none"} · return {data.returnPct ?? "unavailable"}</p>
          <ul className="flex flex-wrap gap-2">
            {data.outcomes.map((outcome) => (
              <li key={outcome.name} className={`rounded border px-2 py-1 ${toneClass(outcome.tone)}`} title={outcome.detail}>
                {outcome.name} · {outcome.met ? outcome.tone : "open"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
