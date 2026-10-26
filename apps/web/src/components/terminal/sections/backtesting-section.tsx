"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, apiBase, token } from "@/lib/api";

type StrategyVersion = {
  id: string;
  name: string;
  version: number;
  status: string;
};

type BacktestListItem = {
  id: string;
  status: string;
  label: string | null;
  strategyVersionId: string | null;
  strategyName: string | null;
  strategyVersion: number | null;
  metrics: Record<string, unknown> | null;
  releaseGate: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

type BacktestDetail = BacktestListItem & {
  assumptions: unknown;
  dataQuality: {
    observationCount?: number;
    pairCount?: number;
    disappearedPairs?: unknown[];
    inactivePairs?: unknown[];
    missingPriceCount?: number;
  } | null;
  baselines: Array<{ name: string; returnPct: string | null; label: string }> | null;
  validation: {
    sampleGate?: { label?: string; passed?: boolean; reasons?: string[] };
    monteCarlo?: { label?: string; p50?: string | null; seed?: number };
    test?: { sampleSize?: number; returnPct?: string | null };
  } | null;
  trades: Array<{
    id: string;
    side: string;
    baseSymbol: string;
    priceUsd: string;
    qty: string;
    feeUsd: string;
    pnlUsd: string | null;
    eventAt: string;
    reasonCodes: string[];
  }>;
  oracleReviews: Array<{
    id: string;
    status: string;
    summary: string;
    readiness: string;
    createdAt: string;
  }>;
  realMoneyGraduation: false;
};

export function BacktestingSection() {
  const { snapshot } = useSnapshot();
  const mode = snapshot?.market.mode;
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [runs, setRuns] = useState<BacktestListItem[]>([]);
  const [strategyVersionId, setStrategyVersionId] = useState("");
  const [latencyMs, setLatencyMs] = useState("0");
  const [seed, setSeed] = useState("42");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BacktestDetail | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ runs: BacktestListItem[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [strategyRows, runRows] = await Promise.all([
      api<StrategyVersion[]>("/lab/strategies"),
      api<BacktestListItem[]>("/lab/backtests"),
    ]);
    setVersions(strategyRows);
    setRuns(runRows);
    if (!strategyVersionId && strategyRows[0]) setStrategyVersionId(strategyRows[0].id);
    if (!selectedId && runRows[0]) setSelectedId(runRows[0].id);
  }, [selectedId, strategyVersionId]);

  useEffect(() => {
    void load().catch((caught: unknown) => {
      setMessage(caught instanceof Error ? caught.message : "Failed to load lab");
    });
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void api<BacktestDetail>(`/lab/backtests/${selectedId}`)
      .then(setDetail)
      .catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : "Load failed"));
  }, [selectedId]);

  const reportUrl = useMemo(() => {
    if (!selectedId) return null;
    return `${apiBase()}/api/lab/backtests/${selectedId}/report`;
  }, [selectedId]);

  async function startRun() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<BacktestDetail>("/lab/backtests", {
        method: "POST",
        body: JSON.stringify({
          strategyVersionId: strategyVersionId || undefined,
          latencyMs: Number(latencyMs) || 0,
          monteCarloSeed: Number(seed) || 42,
          forceLiquidateAtEnd: true,
        }),
      });
      setSelectedId(result.id);
      setDetail(result);
      await load();
      setMessage(`Backtest ${result.status}. Release: ${String(result.releaseGate?.label ?? "n/a")}.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Backtest failed");
    } finally {
      setBusy(false);
    }
  }

  async function runOracle() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const review = await api<{ id: string; readiness: string }>("/lab/backtests/" + selectedId + "/oracle", {
        method: "POST",
        body: "{}",
      });
      setMessage(`ORACLE review ${review.id} · readiness ${review.readiness} (approval required).`);
      const refreshed = await api<BacktestDetail>(`/lab/backtests/${selectedId}`);
      setDetail(refreshed);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "ORACLE failed");
    } finally {
      setBusy(false);
    }
  }

  async function approveOracle(reviewId: string) {
    setBusy(true);
    try {
      await api(`/lab/oracle/${reviewId}/approve`, { method: "POST", body: "{}" });
      setMessage("ORACLE suggestions approved for further paper experiments only — engine config unchanged.");
      if (selectedId) setDetail(await api<BacktestDetail>(`/lab/backtests/${selectedId}`));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function runCompare() {
    if (compareIds.length < 2) {
      setMessage("Select at least two runs to compare.");
      return;
    }
    try {
      const result = await api<{ runs: BacktestListItem[] }>(`/lab/backtests/compare?ids=${compareIds.join(",")}`);
      setCompare(result);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Compare failed");
    }
  }

  function toggleCompare(id: string) {
    setCompareIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : current.length >= 5 ? current : [...current, id],
    );
  }

  async function downloadReport() {
    if (!reportUrl) return;
    const session = token();
    const response = await fetch(reportUrl, {
      headers: session ? { authorization: `Bearer ${session}` } : {},
    });
    if (!response.ok) {
      setMessage(`Report export failed (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `odin-research-${selectedId}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Exported reproducible HTML research report.");
  }

  return (
    <div className="grid gap-3">
      <Panel
        title="Backtesting"
        extra={mode === "replay" ? "REPLAY mode" : mode === "demo" ? "DEMO mode" : "Uses persisted MarketObservation history"}
        className="animate-odin-fade"
      >
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="strat">Strategy version</Label>
            <select
              id="strat"
              className="h-9 w-full rounded-md border border-border bg-panel px-2 text-sm"
              value={strategyVersionId}
              onChange={(event) => setStrategyVersionId(event.target.value)}
            >
              {versions.length === 0 ? <option value="">No versions — create one in Strategy Laboratory</option> : null}
              {versions.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} v{row.version}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lat">Latency ms</Label>
            <Input id="lat" value={latencyMs} onChange={(event) => setLatencyMs(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="seed">Monte Carlo seed</Label>
            <Input id="seed" value={seed} onChange={(event) => setSeed(event.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          <Button disabled={busy || !strategyVersionId} onClick={() => void startRun()}>
            {busy ? "Running…" : "Run historical replay"}
          </Button>
          <Button variant="outline" disabled={!selectedId || busy} onClick={() => void runOracle()}>
            Request ORACLE review
          </Button>
          <Button variant="outline" disabled={!selectedId} onClick={() => void downloadReport()}>
            Export HTML report
          </Button>
          <Button variant="ghost" disabled={compareIds.length < 2} onClick={() => void runCompare()}>
            Compare selected ({compareIds.length})
          </Button>
        </div>
        {message ? <p className="px-4 pb-3 text-sm text-muted">{message}</p> : null}
        <p className="px-4 pb-4 text-[11px] text-muted">
          Event-driven replay uses only prices available at event time + latency. Failed/inactive tokens stay in the data-quality
          report. Paper ≠ live. There is no real-money graduation path.
        </p>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Panel title="Runs" extra={`${runs.length}`}>
          {runs.length === 0 ? (
            <EmptyState
              title="No backtest runs"
              detail="Create a strategy version, ensure MarketObservation history exists, then run a replay."
            />
          ) : (
            <ul className="max-h-[28rem] space-y-1 overflow-auto p-2 text-sm">
              {runs.map((run) => (
                <li key={run.id} className="flex items-start gap-2 rounded border border-border px-2 py-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={compareIds.includes(run.id)}
                    onChange={() => toggleCompare(run.id)}
                    aria-label={`Compare ${run.id}`}
                  />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(run.id)}>
                    <div className="flex justify-between gap-2">
                      <span className="truncate font-medium">{run.label ?? run.id}</span>
                      <span className="text-[10px] uppercase text-muted">{run.status}</span>
                    </div>
                    <div className="mono text-[11px] text-muted">
                      {run.strategyName ?? "?"} v{run.strategyVersion ?? "?"} · sample=
                      {String((run.metrics as { sampleSize?: number } | null)?.sampleSize ?? "null")} · return=
                      {String((run.metrics as { returnPct?: string | null } | null)?.returnPct ?? "null")}
                    </div>
                    <div className="text-[11px] text-warning">
                      {String((run.releaseGate as { label?: string } | null)?.label ?? "NOT_RELEASE_READY")}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Run detail" extra={selectedId ? selectedId.slice(0, 18) : "—"}>
          {!detail ? (
            <EmptyState title="Select a run" detail="Metrics stay null when evidence is insufficient — no fake confidence." />
          ) : (
            <div className="space-y-3 p-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <Metric label="Sample size" value={String(detail.metrics?.sampleSize ?? "null")} />
                <Metric label="Return %" value={String(detail.metrics?.returnPct ?? "null")} />
                <Metric label="Profit factor" value={String(detail.metrics?.profitFactor ?? "null")} />
                <Metric label="Max DD %" value={String(detail.metrics?.maxDrawdownPct ?? "null")} />
                <Metric label="Sample gate" value={String(detail.validation?.sampleGate?.label ?? "null")} />
                <Metric label="OOS return %" value={String(detail.validation?.test?.returnPct ?? "null")} />
                <Metric label="Monte Carlo" value={String(detail.validation?.monteCarlo?.label ?? "null")} />
                <Metric label="MC p50 equity" value={String(detail.validation?.monteCarlo?.p50 ?? "null")} />
              </div>
              <div className="rounded border border-border bg-panel-2 p-3 text-xs">
                <div className="font-medium">Data quality</div>
                <div className="mono mt-1 text-muted">
                  obs={detail.dataQuality?.observationCount ?? 0} · pairs={detail.dataQuality?.pairCount ?? 0} · missingPrice=
                  {detail.dataQuality?.missingPriceCount ?? 0} · disappeared=
                  {detail.dataQuality?.disappearedPairs?.length ?? 0} · inactive=
                  {detail.dataQuality?.inactivePairs?.length ?? 0}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">Baselines</div>
                <ul className="space-y-1 text-xs">
                  {(detail.baselines ?? []).map((baseline) => (
                    <li key={baseline.name} className="flex justify-between gap-2 border-b border-border/60 py-1">
                      <span>{baseline.name}</span>
                      <span className="mono">
                        {baseline.returnPct ?? "null"} · {baseline.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">Recent trades</div>
                <ul className="max-h-40 space-y-1 overflow-auto text-xs">
                  {detail.trades.slice(0, 40).map((trade) => (
                    <li key={trade.id} className="mono flex justify-between gap-2">
                      <span>
                        {trade.eventAt.slice(11, 19)} {trade.side} {trade.baseSymbol}
                      </span>
                      <span>{trade.pnlUsd ?? trade.priceUsd}</span>
                    </li>
                  ))}
                  {detail.trades.length === 0 ? <li className="text-muted">No simulated fills in this window.</li> : null}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">ORACLE</div>
                {(detail.oracleReviews ?? []).length === 0 ? (
                  <p className="text-xs text-muted">No advisory review yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.oracleReviews.map((review) => (
                      <li key={review.id} className="rounded border border-border p-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="uppercase text-muted">{review.status}</span>
                          <span>{review.readiness}</span>
                        </div>
                        <p className="mt-1 text-muted">{review.summary}</p>
                        {review.status === "PENDING_APPROVAL" ? (
                          <Button size="xs" className="mt-2" disabled={busy} onClick={() => void approveOracle(review.id)}>
                            Approve for paper follow-up
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {reportUrl ? (
                <p className="text-[11px] text-muted">
                  Export path: <span className="mono">{reportUrl}</span>
                </p>
              ) : null}
            </div>
          )}
        </Panel>
      </div>

      {compare ? (
        <Panel title="Version comparison" extra={`${compare.runs.length} runs`}>
          <div className="overflow-auto p-4">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-muted">
                  <th className="py-1">Run</th>
                  <th>Strategy</th>
                  <th>Sample</th>
                  <th>Return %</th>
                  <th>PF</th>
                  <th>Release</th>
                </tr>
              </thead>
              <tbody>
                {compare.runs.map((run) => (
                  <tr key={run.id} className="border-t border-border mono">
                    <td className="py-1">{run.label ?? run.id.slice(0, 12)}</td>
                    <td>
                      {run.strategyName} v{run.strategyVersion}
                    </td>
                    <td>{String((run.metrics as { sampleSize?: number } | null)?.sampleSize ?? "null")}</td>
                    <td>{String((run.metrics as { returnPct?: string | null } | null)?.returnPct ?? "null")}</td>
                    <td>{String((run.metrics as { profitFactor?: string | null } | null)?.profitFactor ?? "null")}</td>
                    <td>{String((run.releaseGate as { label?: string } | null)?.label ?? "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const insufficient = value === "null" || value === "INSUFFICIENT_EVIDENCE";
  return (
    <div className="rounded border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mono text-sm ${insufficient ? "text-warning" : ""}`}>{value}</div>
    </div>
  );
}
