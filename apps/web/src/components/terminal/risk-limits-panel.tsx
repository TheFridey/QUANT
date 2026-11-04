"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import {
  diffRiskDraft,
  draftFromConfig,
  patchFromChanges,
  RISK_LIMIT_FIELDS,
  riskDraftNotes,
  validateRiskDraft,
  type RiskLimitChange,
  type RiskLimitDraft,
  type RiskLimitKey,
} from "@/lib/risk-limits";

type ConfigRevision = {
  id: string;
  source: string;
  actor: string | null;
  createdAt: string;
  changes: Array<{ key: string; from: unknown; to: unknown }>;
};

const RISK_KEYS = new Set<string>(RISK_LIMIT_FIELDS.map((field) => field.key));

/**
 * Operator editor for the PAPER account's risk limits. Saves through the audited
 * PATCH /engine/config: admin only, engine paused, server-side bounds, and an
 * EngineConfigRevision per change. It never resumes the engine.
 */
export function RiskLimitsPanel() {
  const { snapshot, refresh, control } = useSnapshot();
  const config = snapshot?.engine.config ?? null;
  const revision = snapshot?.engine.updatedAt ?? null;
  const status = snapshot?.engine.status ?? null;
  const [baseline, setBaseline] = useState<RiskLimitDraft | null>(null);
  const [baselineRevision, setBaselineRevision] = useState<string | null>(null);
  const [draft, setDraft] = useState<RiskLimitDraft | null>(null);
  const [pending, setPending] = useState<RiskLimitChange[] | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<ConfigRevision[]>([]);
  const dirtyRef = useRef(false);

  const loadHistory = useCallback(async () => {
    try {
      const result = await api<{ revisions: ConfigRevision[] }>("/engine/config/history?limit=50");
      setHistory(result.revisions.filter((row) => row.changes.some((change) => RISK_KEYS.has(change.key))).slice(0, 8));
    } catch {
      /* history is informational */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Keep unsaved edits across snapshot polls; flag a conflict only if the stored limits themselves move
  // underneath them (pausing or resuming also bumps the engine revision but changes no limit).
  useEffect(() => {
    if (!config || !revision) return;
    if (baselineRevision === revision) return;
    const next = draftFromConfig(config);
    if (baselineRevision !== null && dirtyRef.current) {
      if (baseline && diffRiskDraft(baseline, next).length === 0) setBaselineRevision(revision);
      else setConflict(true);
      return;
    }
    setBaseline(next);
    setDraft(next);
    setBaselineRevision(revision);
    setConflict(false);
  }, [config, revision, baselineRevision, baseline]);

  const errors = useMemo(() => (draft ? validateRiskDraft(draft) : {}), [draft]);
  const changes = useMemo(() => (draft && baseline ? diffRiskDraft(baseline, draft) : []), [draft, baseline]);
  const notes = useMemo(
    () =>
      draft
        ? riskDraftNotes(draft, {
            equityUsd: snapshot?.portfolio.equityUsd ?? null,
            highWaterMarkUsd: snapshot?.portfolio.highWaterMarkUsd ?? null,
          })
        : [],
    [draft, snapshot?.portfolio.equityUsd, snapshot?.portfolio.highWaterMarkUsd],
  );

  useEffect(() => {
    dirtyRef.current = changes.length > 0;
  }, [changes.length]);

  if (!snapshot || !draft || !baseline) return null;

  const activeDraft = draft;
  const paused = status === "PAUSED" || status === "STOPPED";
  const valid = Object.keys(errors).length === 0;

  function update(key: RiskLimitKey, value: string) {
    setPending(null);
    setMessage(null);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function discard() {
    if (!config || !revision) return;
    const next = draftFromConfig(config);
    setBaseline(next);
    setDraft(next);
    setBaselineRevision(revision);
    setConflict(false);
    setPending(null);
    dirtyRef.current = false;
    setMessage(null);
  }

  function review(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (!valid || changes.length === 0) return;
    setPending(changes);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/engine/config", { method: "PATCH", body: JSON.stringify(patchFromChanges(pending)) });
      dirtyRef.current = false;
      setBaseline({ ...activeDraft });
      setPending(null);
      setConflict(false);
      await refresh();
      await loadHistory();
      setMessage({ ok: true, text: "Risk limits saved and recorded in the config history. The engine is still paused; resume it when ready." });
    } catch (caught) {
      setMessage({ ok: false, text: caught instanceof Error ? caught.message : "Change rejected" });
    } finally {
      setBusy(false);
    }
  }

  function setDefaults() {
    setPending(null);
    setMessage(null);
    const next = { ...activeDraft };
    for (const field of RISK_LIMIT_FIELDS) next[field.key] = field.defaultValue;
    setDraft(next);
  }

  return (
    <Panel title="Risk limits (PAPER)" extra={changes.length > 0 ? `${changes.length} unsaved` : `engine ${status ?? "—"}`} className="lg:col-span-2">
      <form className="grid gap-4 p-4" onSubmit={review} aria-label="Risk limits">
        <p className="text-xs text-muted">
          These limits apply to the paper account only; live money stays refused. Saving needs an admin login and a paused
          engine, and every change is recorded with your name in the config history. Saving never resumes the engine.
        </p>

        {!paused ? (
          <div className="flex flex-wrap items-center gap-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
            <span>The engine is {status}. Pause it to change risk limits.</span>
            <Button type="button" size="xs" variant="warning" onClick={() => void control("/engine/pause")}>
              Pause engine
            </Button>
          </div>
        ) : null}

        {conflict ? (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            The server config changed while you had unsaved edits.{" "}
            <button type="button" className="underline" onClick={discard}>
              Discard my edits and load the server values
            </button>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {RISK_LIMIT_FIELDS.map((field) => {
            const error = errors[field.key];
            const changed = changes.some((change) => change.key === field.key);
            return (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`risk-${field.key}`}>{field.label}</Label>
                <Input
                  id={`risk-${field.key}`}
                  inputMode="decimal"
                  value={activeDraft[field.key]}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={`risk-${field.key}-help`}
                  className={changed ? "border-accent" : undefined}
                  onChange={(event) => update(field.key, event.target.value)}
                />
                <p id={`risk-${field.key}-help`} className={`text-[11px] ${error ? "text-loss" : "text-muted"}`}>
                  {error ?? `${field.help} Range ${field.min}–${field.max}; default ${field.defaultValue}; saved ${baseline[field.key] || "—"}.`}
                </p>
              </div>
            );
          })}
        </div>

        {notes.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {notes.map((note) => (
              <li key={note.text} className={note.tone === "warning" ? "text-warning" : "text-muted"}>
                {note.text}
              </li>
            ))}
          </ul>
        ) : null}

        {pending ? (
          <div className="rounded border border-border bg-panel-2 p-3 text-xs" role="alertdialog" aria-label="Confirm risk limit changes">
            <p className="mb-2 font-medium">Apply these changes to the paper account?</p>
            <ul className="mono mb-3 space-y-1">
              {pending.map((change) => (
                <li key={change.key}>
                  {change.label}: {change.from} → {change.to}
                  {change.loosens ? <span className="text-warning"> (looser)</span> : <span className="text-muted"> (tighter)</span>}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={busy} onClick={() => void confirm()}>
                {busy ? "Saving…" : "Confirm and save"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setPending(null)}>
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {message ? (
          <p role="status" aria-live="polite" className={`text-sm ${message.ok ? "text-profit" : "text-loss"}`}>
            {message.text}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="w-fit" disabled={!paused || !valid || changes.length === 0 || pending !== null}>
            Review changes
          </Button>
          <Button type="button" variant="outline" className="w-fit" onClick={setDefaults}>
            Fill defaults
          </Button>
          {changes.length > 0 ? (
            <Button type="button" variant="ghost" className="w-fit" onClick={discard}>
              Discard edits
            </Button>
          ) : null}
        </div>

        <div className="border-t border-border pt-3">
          <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted">Recent risk-limit changes</div>
          {history.length === 0 ? (
            <p className="text-[11px] text-muted">No risk-limit changes recorded yet.</p>
          ) : (
            <ul className="max-h-48 divide-y divide-border/70 overflow-auto text-[11px]">
              {history.map((row) => (
                <li key={row.id} className="py-1.5">
                  <span className="mono text-muted">{row.createdAt.slice(0, 19).replace("T", " ")} UTC</span> ·{" "}
                  <span className="mono">{row.actor ?? row.source}</span> ·{" "}
                  {row.changes
                    .filter((change) => RISK_KEYS.has(change.key))
                    .map((change) => `${change.key} ${String(change.from ?? "—")} → ${String(change.to ?? "—")}`)
                    .join(", ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </Panel>
  );
}
