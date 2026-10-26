"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AnimatedValue } from "@/components/terminal/animated-value";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { setToken } from "@/lib/api";
import { formatLondon, formatUsd } from "@/lib/format";
import type { DataState } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATE_CLASS: Record<DataState, string> = {
  LIVE: "border-profit/50 text-profit",
  DELAYED: "border-primary/50 text-primary",
  STALE: "border-loss/50 text-loss",
  REPLAY: "border-warning/50 text-warning",
  DEMO: "border-warning/50 text-warning",
};

export function CommandBar() {
  const router = useRouter();
  const { snapshot, socketState, control, error } = useSnapshot();
  const [clock, setClock] = useState("");
  const [emergencyOpen, setEmergencyOpen] = useState(false);

  useEffect(() => {
    const tick = window.setInterval(() => setClock(formatLondon(new Date().toISOString())), 1000);
    setClock(formatLondon(new Date().toISOString()));
    return () => window.clearInterval(tick);
  }, []);

  if (!snapshot) return null;

  const dataState = snapshot.market.dataState;
  const can = (action: string) => snapshot.engine.allowedActions.includes(action);
  const agentActive = snapshot.agents?.filter((agent) => agent.decision).length ?? 0;
  const mode = snapshot.market.mode === "replay" ? "REPLAY" : snapshot.market.mode === "demo" ? "DEMO" : "PAPER";

  return (
    <>
      <header className="panel z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <div className="min-w-[150px]">
          <div className="text-sm font-semibold tracking-[0.08em]">ODIN // QUANT</div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Command centre · London {clock}</div>
        </div>

        <Badge className="border-primary/40 text-primary">{mode}</Badge>
        <Badge className={dataState ? STATE_CLASS[dataState] : ""}>{dataState ?? "NO DATA"}</Badge>
        <Badge
          className={cn(
            snapshot.engine.status === "RUNNING" && "border-profit/50 text-profit",
            snapshot.engine.status === "EMERGENCY_STOP" && "border-loss/50 text-loss",
            snapshot.engine.status === "PAUSED" && "border-warning/50 text-warning",
          )}
        >
          {snapshot.engine.status}
        </Badge>

        <StatusPill label="Market" value={socketState === "live" ? "WS live" : socketState} ok={socketState === "live"} />
        <StatusPill label="Agents" value={`${agentActive}/6`} ok={agentActive > 0} />
        <StatusPill
          label="Cycle"
          value={snapshot.cycle ? `${snapshot.cycle.stage}` : "idle"}
          ok={snapshot.cycle?.status === "COMPLETE" || snapshot.cycle?.status === "RUNNING"}
        />

        <div className="mono ml-auto text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Portfolio equity</div>
          <AnimatedValue
            className="text-base"
            value={snapshot.portfolio.equityUsd === null ? "Incomplete marks" : formatUsd(snapshot.portfolio.equityUsd)}
          />
          <div className="text-[10px] text-muted">
            Cash {formatUsd(snapshot.portfolio.cashUsd)} · {snapshot.portfolio.valuation}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" disabled={!can("start")} onClick={() => void control("/engine/start")}>
            Start
          </Button>
          <Button size="xs" variant="outline" disabled={!can("pause")} onClick={() => void control("/engine/pause")}>
            Pause
          </Button>
          <Button size="xs" variant="outline" disabled={!can("resume")} onClick={() => void control("/engine/resume")}>
            Resume
          </Button>
          <Button size="xs" variant="danger" disabled={!can("emergency_stop")} onClick={() => setEmergencyOpen(true)}>
            Emergency stop
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setToken(null);
              router.push("/login");
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      {error ? <div className="border-b border-loss/40 bg-loss/10 px-3 py-1.5 text-xs text-loss">{error}</div> : null}
      {dataState && dataState !== "LIVE" ? (
        <div className="border-b border-primary/30 bg-primary/5 px-3 py-1.5 text-xs text-primary">
          Market snapshot is {dataState}. Paper buys require a LIVE quote on the selected pair.
        </div>
      ) : null}

      <Dialog open={emergencyOpen} onOpenChange={setEmergencyOpen}>
        <DialogContent>
          <DialogTitle className="text-lg">Emergency stop</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted">
            Halts new paper orders. Flatten sells only pairs that still have an allowable mark; missing marks remain open.
          </DialogDescription>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="danger"
              onClick={() => void control("/engine/emergency-stop", { flatten: false }).then(() => setEmergencyOpen(false))}
            >
              Halt
            </Button>
            <Button
              variant="outline"
              onClick={() => void control("/engine/emergency-stop", { flatten: true }).then(() => setEmergencyOpen(false))}
            >
              Halt and flatten
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusPill({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="hidden items-center gap-2 rounded border border-border px-2 py-1 md:flex">
      <span className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-profit animate-odin-pulse" : "bg-loss")} />
      <div>
        <div className="text-[9px] uppercase tracking-[0.14em] text-muted">{label}</div>
        <div className="text-[11px]">{value}</div>
      </div>
    </div>
  );
}
