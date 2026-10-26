"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export function StrategySection() {
  const { snapshot, refresh } = useSnapshot();
  const config = snapshot?.engine.config;
  const [balance, setBalance] = useState("");
  const [maxPositions, setMaxPositions] = useState("");
  const [entry, setEntry] = useState("");
  const [anomaly, setAnomaly] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setBalance(String(config.startingBalanceUsd ?? ""));
    setMaxPositions(String(config.maxPositions ?? ""));
    setEntry(String(config.entryM5ChangePct ?? ""));
    setAnomaly(String(config.maxEntryM5ChangePct ?? ""));
    setStop(String(config.stopLossPct ?? ""));
    setTarget(String(config.takeProfitPct ?? ""));
  }, [config]);

  if (!snapshot) return null;

  async function save(event: FormEvent) {
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
        }),
      });
      await refresh();
      setMessage("Strategy config saved.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Config rejected");
    }
  }

  return (
    <Panel title="Strategy laboratory" extra={`Engine ${snapshot.engine.status}`} className="animate-odin-fade">
      <form className="grid max-w-xl gap-3 p-4" onSubmit={(event) => void save(event)}>
        <p className="text-xs text-muted">
          Pause the engine before saving. Starting balance changes only while stopped and before any order. Automatic entries require a SOL, USDC, or USDT quote mint.
        </p>
        <Field id="balance" label="Starting balance USD" value={balance} onChange={setBalance} />
        <Field id="positions" label="Max positions" value={maxPositions} onChange={setMaxPositions} />
        <Field id="entry" label="Entry 5-minute change %" value={entry} onChange={setEntry} />
        <Field id="anomaly" label="Maximum 5-minute change %" value={anomaly} onChange={setAnomaly} />
        <Field id="stop" label="Stop loss %" value={stop} onChange={setStop} />
        <Field id="target" label="Take profit %" value={target} onChange={setTarget} />
        {message ? <p className={`text-sm ${message.includes("saved") ? "text-profit" : "text-loss"}`}>{message}</p> : null}
        <Button type="submit" className="w-fit">
          Save strategy
        </Button>
      </form>
    </Panel>
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
