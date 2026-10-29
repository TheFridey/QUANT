"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Panel } from "@/components/terminal/panel";
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
  notes: string | null;
  createdAt: string;
  config: Record<string, unknown>;
};

export function StrategySection() {
  const { snapshot, refresh } = useSnapshot();
  const config = snapshot?.engine.config;
  const [balance, setBalance] = useState("");
  const [maxPositions, setMaxPositions] = useState("");
  const [entry, setEntry] = useState("");
  const [anomaly, setAnomaly] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [trailing, setTrailing] = useState("");
  const [relVol, setRelVol] = useState("");
  const [minSamples, setMinSamples] = useState("30");
  const [message, setMessage] = useState<string | null>(null);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [versionName, setVersionName] = useState("default");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const rows = await api<StrategyVersion[]>("/lab/strategies");
      setVersions(rows);
      if (!selectedId && rows[0]) setSelectedId(rows[0].id);
    } catch {
      /* lab endpoints may be unavailable during boot */
    }
  }, [selectedId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  useEffect(() => {
    if (!config) return;
    setBalance(String(config.startingBalanceUsd ?? ""));
    setMaxPositions(String(config.maxPositions ?? ""));
    setEntry(String(config.entryM5ChangePct ?? ""));
    setAnomaly(String(config.maxEntryM5ChangePct ?? ""));
    setStop(String(config.stopLossPct ?? ""));
    setTarget(String(config.takeProfitPct ?? ""));
    setTrailing(config.trailingStopPct == null ? "" : String(config.trailingStopPct));
    setRelVol(config.relativeVolumeMin == null ? "" : String(config.relativeVolumeMin));
    setMinSamples(String(config.minSampleTrades ?? 30));
  }, [config]);

  if (!snapshot) return null;

  const ops = snapshot.opsControls;
  const instances = snapshot.strategyInstances ?? [];

  async function patchOpsFlag(flag: "pauseNewEntries" | "allowDemoPaperEntries" | "multiMarketPaperIngest", value: boolean) {
    setMessage(null);
    try {
      await api("/engine/config", {
        method: "PATCH",
        body: JSON.stringify({ [flag]: value }),
      });
      await refresh();
      setMessage(`Ops flag ${flag}=${value} saved (engine must be paused).`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Ops flag rejected");
    }
  }

  async function saveEngine(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await api("/engine/config", {
        method: "PATCH",
        body: JSON.stringify({
          startingBalanceUsd: balance,
          maxPositions: Number(maxPositions),
          entryM5ChangePct: entry,
          maxEntryM5ChangePct: anomaly,
          stopLossPct: stop,
          takeProfitPct: target,
          trailingStopPct: trailing === "" ? null : trailing,
          relativeVolumeMin: relVol === "" ? null : relVol,
          minSampleTrades: Number(minSamples),
        }),
      });
      await refresh();
      setMessage("Live paper strategy config saved (engine must be paused).");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Config rejected");
    }
  }

  async function snapshotVersion() {
    setMessage(null);
    try {
      const created = await api<{ id: string }>("/lab/strategies", {
        method: "POST",
        body: JSON.stringify({
          name: versionName,
          notes: "Snapshot from Strategy Laboratory",
          config: {
            startingBalanceUsd: balance,
            maxPositions: Number(maxPositions),
            entryM5ChangePct: entry,
            maxEntryM5ChangePct: anomaly,
            stopLossPct: stop,
            takeProfitPct: target,
            trailingStopPct: trailing === "" ? null : trailing,
            relativeVolumeMin: relVol === "" ? null : relVol,
            minSampleTrades: Number(minSamples),
          },
        }),
      });
      setSelectedId(created.id);
      await loadVersions();
      setMessage("Strategy version stored. It does not auto-apply to a RUNNING engine.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Version create failed");
    }
  }

  const selected = versions.find((row) => row.id === selectedId) ?? null;

  return (
    <div className="grid gap-3">
      <Panel title="Operating controls" extra={ops?.engineStatus ?? snapshot.engine.status} className="animate-odin-fade">
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Allowed actions</dt>
              <dd className="mono">{(ops?.allowedActions ?? snapshot.engine.allowedActions).join(", ") || "—"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Flatten requested</dt>
              <dd className="mono">{ops?.flattenRequested || snapshot.engine.flattenRequested ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Entries suspended</dt>
              <dd className="mono">{ops?.entriesSuspended ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Circuit breaker</dt>
              <dd className="mono">{ops?.circuitBreakerOpen ? "OPEN" : "closed"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Risk dominant</dt>
              <dd className="mono text-[10px]">{ops?.riskDominantHard ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted">Unresolved protection</dt>
              <dd className="mono">{ops?.unresolvedProtection ?? 0}</dd>
            </div>
          </dl>
          <div className="space-y-2 text-xs">
            <p className="text-muted">{ops?.note ?? "Alert ACK does not clear safety suspensions."}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void patchOpsFlag("pauseNewEntries", !(ops?.pauseNewEntries ?? false))}
              >
                {ops?.pauseNewEntries ? "Resume new entries" : "Pause new entries"}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void patchOpsFlag("allowDemoPaperEntries", !(ops?.allowDemoPaperEntries ?? false))}
              >
                DEMO entries: {ops?.allowDemoPaperEntries ? "on" : "off"}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void patchOpsFlag("multiMarketPaperIngest", !(ops?.multiMarketPaperIngest ?? false))}
              >
                Multi-market ingest: {ops?.multiMarketPaperIngest ? "on" : "off"}
              </Button>
            </div>
            {(ops?.unresolvedActions?.length ?? 0) > 0 ? (
              <ul className="mt-2 max-h-28 overflow-auto divide-y divide-border/70 text-[11px]">
                {ops!.unresolvedActions.slice(0, 6).map((action) => (
                  <li key={action.id} className="py-1 mono">
                    {action.reason} · attempts={action.attempts}
                    {action.retryAfter ? ` · retry ${action.retryAfter}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-muted">No unresolved protection intents.</p>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="Strategy instances" extra={`${instances.length} durable`} className="animate-odin-fade">
        {instances.length === 0 ? (
          <p className="p-4 text-xs text-muted">No StrategyInstance rows yet — worker seeds defaults on loadPlan.</p>
        ) : (
          <ul className="divide-y divide-border/70 text-xs">
            {instances.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2">
                <div>
                  <div className="font-medium">
                    {row.name} <span className="mono text-[10px] text-muted">@{row.version}</span>
                  </div>
                  <div className="mono text-[10px] text-muted">
                    {row.status}/{row.health} · {row.instrumentIds.join(", ") || "—"} · budget {row.budgetUsd}
                  </div>
                </div>
                <div className="mono text-[10px] text-muted">{row.timeframe}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <Panel title="Strategy laboratory" extra={`Engine ${snapshot.engine.status}`} className="animate-odin-fade">
        <form className="grid max-w-xl gap-3 p-4" onSubmit={(event) => void saveEngine(event)}>
          <p className="text-xs text-muted">
            Pause the engine before saving live config. Starting balance changes only while stopped and before any order.
            Version snapshots feed Backtesting / ORACLE — they never auto-graduate to real money (no real-money venue).
          </p>
          <Field id="balance" label="Starting balance USD" value={balance} onChange={setBalance} />
          <Field id="positions" label="Max positions" value={maxPositions} onChange={setMaxPositions} />
          <Field id="entry" label="Entry 5-minute change %" value={entry} onChange={setEntry} />
          <Field id="anomaly" label="Maximum 5-minute change %" value={anomaly} onChange={setAnomaly} />
          <Field id="stop" label="Stop loss %" value={stop} onChange={setStop} />
          <Field id="target" label="Take profit %" value={target} onChange={setTarget} />
          <Field id="trailing" label="Trailing stop % (empty = off)" value={trailing} onChange={setTrailing} />
          <Field id="relvol" label="Relative volume min (empty = off)" value={relVol} onChange={setRelVol} />
          <Field id="minsamples" label="Min sample trades (release gate)" value={minSamples} onChange={setMinSamples} />
          {message ? <p className={`text-sm ${message.includes("saved") || message.includes("stored") ? "text-profit" : "text-loss"}`}>{message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="w-fit">
              Save live paper config
            </Button>
            <Button type="button" variant="outline" className="w-fit" onClick={() => void snapshotVersion()}>
              Snapshot version
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title="Versioned strategies" extra={`${versions.length} stored`} className="animate-odin-fade">
        <div className="space-y-3 p-4">
          <div className="space-y-1">
            <Label htmlFor="vname">Version family name</Label>
            <Input id="vname" value={versionName} onChange={(event) => setVersionName(event.target.value)} />
          </div>
          <ul className="max-h-80 space-y-2 overflow-auto text-sm">
            {versions.length === 0 ? (
              <li className="text-muted">No versions yet — snapshot the current parameters.</li>
            ) : (
              versions.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`w-full rounded border px-3 py-2 text-left ${selectedId === row.id ? "border-accent bg-panel-2" : "border-border"}`}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {row.name} <span className="mono text-xs text-muted">v{row.version}</span>
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted">{row.status}</span>
                    </div>
                    <div className="mono text-[11px] text-muted">{row.id}</div>
                  </button>
                </li>
              ))
            )}
          </ul>
          {selected ? (
            <div className="rounded border border-border bg-panel-2 p-3 text-xs">
              <div className="mb-1 text-muted">Selected for backtests</div>
              <div className="mono">{selected.id}</div>
              <div className="mt-2 text-muted">
                entry={String(selected.config.entryM5ChangePct)} · stop={String(selected.config.stopLossPct)} · tp=
                {String(selected.config.takeProfitPct)}
              </div>
              <a className="mt-2 inline-block text-accent underline" href="/terminal/backtesting">
                Open Backtesting →
              </a>
            </div>
          ) : null}
          <p className="text-[11px] text-muted">
            Report export path: <span className="mono">{apiBase()}/api/lab/backtests/:id/report</span>
            {token() ? " (auth required)" : ""}
          </p>
        </div>
      </Panel>
      </div>
    </div>
  );
}

function Field({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
