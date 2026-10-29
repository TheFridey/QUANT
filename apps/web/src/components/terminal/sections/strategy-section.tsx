"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type DraftFields = {
  balance: string;
  maxPositions: string;
  entry: string;
  anomaly: string;
  stop: string;
  target: string;
  trailing: string;
  relVol: string;
  minSamples: string;
};

function draftFromConfig(config: Record<string, string | number | boolean | null>): DraftFields {
  return {
    balance: String(config.startingBalanceUsd ?? ""),
    maxPositions: String(config.maxPositions ?? ""),
    entry: String(config.entryM5ChangePct ?? ""),
    anomaly: String(config.maxEntryM5ChangePct ?? ""),
    stop: String(config.stopLossPct ?? ""),
    target: String(config.takeProfitPct ?? ""),
    trailing: config.trailingStopPct == null ? "" : String(config.trailingStopPct),
    relVol: config.relativeVolumeMin == null ? "" : String(config.relativeVolumeMin),
    minSamples: String(config.minSampleTrades ?? 30),
  };
}

function draftsEqual(a: DraftFields, b: DraftFields): boolean {
  return (
    a.balance === b.balance &&
    a.maxPositions === b.maxPositions &&
    a.entry === b.entry &&
    a.anomaly === b.anomaly &&
    a.stop === b.stop &&
    a.target === b.target &&
    a.trailing === b.trailing &&
    a.relVol === b.relVol &&
    a.minSamples === b.minSamples
  );
}

export function StrategySection() {
  const { snapshot, refresh } = useSnapshot();
  const config = snapshot?.engine.config;
  const configRevision = snapshot?.engine.updatedAt ?? null;
  const [draft, setDraft] = useState<DraftFields | null>(null);
  const [baselineRevision, setBaselineRevision] = useState<string | null>(null);
  const [baselineDraft, setBaselineDraft] = useState<DraftFields | null>(null);
  const [serverConflict, setServerConflict] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [versionName, setVersionName] = useState("default");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dirtyRef = useRef(false);

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

  // D17: key drafts by config revision; preserve dirty edits across snapshot polls.
  useEffect(() => {
    if (!config || !configRevision) return;
    const next = draftFromConfig(config);
    if (baselineRevision === null) {
      setDraft(next);
      setBaselineDraft(next);
      setBaselineRevision(configRevision);
      setServerConflict(false);
      dirtyRef.current = false;
      return;
    }
    if (configRevision === baselineRevision) return;
    if (dirtyRef.current) {
      setServerConflict(true);
      return;
    }
    setDraft(next);
    setBaselineDraft(next);
    setBaselineRevision(configRevision);
    setServerConflict(false);
  }, [config, configRevision, baselineRevision]);

  const dirty = useMemo(() => {
    if (!draft || !baselineDraft) return false;
    return !draftsEqual(draft, baselineDraft);
  }, [draft, baselineDraft]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  if (!snapshot || !draft) return null;

  const activeDraft = draft;
  const ops = snapshot.opsControls;
  const instances = snapshot.strategyInstances ?? [];

  function updateField<K extends keyof DraftFields>(key: K, value: DraftFields[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function resetDraftToServer() {
    if (!config || !configRevision) return;
    const next = draftFromConfig(config);
    setDraft(next);
    setBaselineDraft(next);
    setBaselineRevision(configRevision);
    setServerConflict(false);
    dirtyRef.current = false;
    setMessage("Draft reset to server config.");
  }

  async function patchOpsFlag(flag: "pauseNewEntries" | "allowDemoPaperEntries" | "multiMarketPaperIngest", value: boolean) {
    setMessage(null);
    try {
      await api("/engine/config", {
        method: "PATCH",
        body: JSON.stringify({ [flag]: value }),
      });
      await refresh();
      setMessage(`Ops flag ${flag}=${value} applied (works while RUNNING).`);
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
          startingBalanceUsd: activeDraft.balance,
          maxPositions: Number(activeDraft.maxPositions),
          entryM5ChangePct: activeDraft.entry,
          maxEntryM5ChangePct: activeDraft.anomaly,
          stopLossPct: activeDraft.stop,
          takeProfitPct: activeDraft.target,
          trailingStopPct: activeDraft.trailing === "" ? null : activeDraft.trailing,
          relativeVolumeMin: activeDraft.relVol === "" ? null : activeDraft.relVol,
          minSampleTrades: Number(activeDraft.minSamples),
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
            startingBalanceUsd: activeDraft.balance,
            maxPositions: Number(activeDraft.maxPositions),
            entryM5ChangePct: activeDraft.entry,
            maxEntryM5ChangePct: activeDraft.anomaly,
            stopLossPct: activeDraft.stop,
            takeProfitPct: activeDraft.target,
            trailingStopPct: activeDraft.trailing === "" ? null : activeDraft.trailing,
            relativeVolumeMin: activeDraft.relVol === "" ? null : activeDraft.relVol,
            minSampleTrades: Number(activeDraft.minSamples),
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
            <p className="text-muted">
              {ops?.note ?? "Alert ACK does not clear safety suspensions."} Operational flags apply while RUNNING;
              strategy parameters still require pause.
            </p>
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
      <Panel
        title="Strategy laboratory"
        extra={dirty ? "Unsaved draft" : `rev ${configRevision?.slice(0, 19) ?? "—"}`}
        className="animate-odin-fade"
      >
        <form className="grid max-w-xl gap-3 p-4" onSubmit={(event) => void saveEngine(event)}>
          <p className="text-xs text-muted">
            Pause the engine before saving live strategy config. Starting balance changes only while stopped and before any order.
            Drafts survive snapshot polling until you reset or save.
          </p>
          {serverConflict ? (
            <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              Server config revision changed while you had unsaved edits.{" "}
              <button type="button" className="underline" onClick={resetDraftToServer}>
                Discard draft and load server
              </button>
            </div>
          ) : null}
          <Field id="balance" label="Starting balance USD" value={activeDraft.balance} onChange={(v) => updateField("balance", v)} />
          <Field id="positions" label="Max positions" value={activeDraft.maxPositions} onChange={(v) => updateField("maxPositions", v)} />
          <Field id="entry" label="Entry 5-minute change %" value={activeDraft.entry} onChange={(v) => updateField("entry", v)} />
          <Field id="anomaly" label="Maximum 5-minute change %" value={activeDraft.anomaly} onChange={(v) => updateField("anomaly", v)} />
          <Field id="stop" label="Stop loss %" value={activeDraft.stop} onChange={(v) => updateField("stop", v)} />
          <Field id="target" label="Take profit %" value={activeDraft.target} onChange={(v) => updateField("target", v)} />
          <Field id="trailing" label="Trailing stop % (empty = off)" value={activeDraft.trailing} onChange={(v) => updateField("trailing", v)} />
          <Field id="relvol" label="Relative volume min (empty = off)" value={activeDraft.relVol} onChange={(v) => updateField("relVol", v)} />
          <Field id="minsamples" label="Min sample trades (release gate)" value={activeDraft.minSamples} onChange={(v) => updateField("minSamples", v)} />
          {message ? (
            <p className={`text-sm ${message.includes("saved") || message.includes("stored") || message.includes("applied") || message.includes("reset") ? "text-profit" : "text-loss"}`}>
              {message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="w-fit">
              Save live paper config
            </Button>
            <Button type="button" variant="outline" className="w-fit" onClick={() => void snapshotVersion()}>
              Snapshot version
            </Button>
            {dirty ? (
              <Button type="button" variant="ghost" className="w-fit" onClick={resetDraftToServer}>
                Discard draft
              </Button>
            ) : null}
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
