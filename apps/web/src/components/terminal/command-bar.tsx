"use client";

import { useEffect, useRef, useState } from "react";
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
  const { snapshot, socketState, lastRefreshAt, control, error } = useSnapshot();
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
  const socketOk = socketState === "connected";
  const marketLive = dataState === "LIVE";
  const refreshAgeMs = lastRefreshAt ? Date.now() - new Date(lastRefreshAt).getTime() : null;

  return (
    <>
      {/* UI item 14: compact sticky header on small screens. */}
      <header className="panel sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <div className="min-w-[150px]">
          <div className="text-sm font-semibold tracking-[0.08em]">ODIN // QUANT</div>
          <div className="hidden text-[10px] uppercase tracking-[0.16em] text-muted sm:block">Command centre · London {clock}</div>
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

        {/* UI item 5: one health pill; the individual checks are in its tooltip and in Settings. */}
        <HealthPill
          checks={[
            { label: "Live connection", value: socketState, ok: socketOk },
            { label: "Market data", value: marketLive ? "live quotes" : (dataState ?? "no data").toLowerCase(), ok: marketLive },
            {
              label: "Last refresh",
              value: refreshAgeMs == null ? "—" : refreshAgeMs < 1500 ? "just now" : `${Math.round(refreshAgeMs / 1000)}s ago`,
              ok: refreshAgeMs != null && refreshAgeMs < 15_000,
            },
            { label: "Agents reporting", value: `${agentActive} of 6`, ok: agentActive > 0 },
            {
              label: "Cycle",
              value: snapshot.cycle ? `${snapshot.cycle.stage}` : "idle",
              ok: snapshot.cycle?.status === "COMPLETE" || snapshot.cycle?.status === "RUNNING",
            },
            { label: "Redis", value: snapshot.health?.redis ?? "unknown", ok: snapshot.health?.redis === "up" },
          ]}
        />

        <div className="mono ml-auto text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Portfolio equity</div>
          <AnimatedValue
            className="text-base"
            value={snapshot.portfolio.equityUsd === null ? "Incomplete marks" : formatUsd(snapshot.portfolio.equityUsd)}
          />
          <div className="hidden text-[10px] text-muted sm:block">
            Cash {formatUsd(snapshot.portfolio.cashUsd)} · {snapshot.portfolio.valuation}
          </div>
        </div>

        <div className="flex items-center gap-1.5 md:hidden">
          <HeaderMenu
            label="Engine"
            items={[
              { label: "Start", disabled: !can("start"), onSelect: () => void control("/engine/start") },
              { label: "Pause", disabled: !can("pause"), onSelect: () => void control("/engine/pause") },
              { label: "Resume", disabled: !can("resume"), onSelect: () => void control("/engine/resume") },
            ]}
          />
          <Button size="xs" variant="danger" disabled={!can("emergency_stop")} onClick={() => setEmergencyOpen(true)}>
            Emergency stop
          </Button>
        </div>
        <div className="hidden flex-wrap items-center gap-1.5 md:flex">
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
        </div>
        {/* UI item 8: Sign out lives in the account menu so Emergency stop stands alone. */}
        <div className="flex items-center">
          <HeaderMenu
            label="Account"
            items={[
              {
                label: "Sign out",
                onSelect: () => {
                  setToken(null);
                  router.push("/login");
                },
              },
            ]}
          />
        </div>
      </header>
      {error ? <div className="border-b border-loss/40 bg-loss/10 px-3 py-1.5 text-xs text-loss">{error}</div> : null}
      {socketState === "error" ? (
        <div className="border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          Terminal socket connect_error — transport down; snapshot polling continues.
        </div>
      ) : null}
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

function HealthPill({ checks }: { checks: Array<{ label: string; value: string; ok: boolean }> }) {
  const failing = checks.filter((check) => !check.ok);
  const healthy = failing.length === 0;
  const detail = checks.map((check) => `${check.ok ? "OK" : "!!"} ${check.label}: ${check.value}`).join("\n");
  return (
    <div
      title={detail}
      className={cn(
        "flex items-center gap-2 rounded border px-2.5 py-1 text-[11px]",
        healthy ? "border-profit/40 text-profit" : "border-warning/50 text-warning",
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", healthy ? "bg-profit" : "bg-warning")} />
      {healthy ? "All systems normal" : `${failing.length} ${failing.length === 1 ? "check needs" : "checks need"} attention`}
      <span className="sr-only">{detail}</span>
    </div>
  );
}

/** Small disclosure menu for the header (account actions; engine controls on mobile). */
function HeaderMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; disabled?: boolean; onSelect: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <Button size="xs" variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
      </Button>
      {open ? (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-36 rounded border border-border bg-panel p-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="w-full rounded px-3 py-1.5 text-left text-xs hover:bg-white/5 focus-visible:bg-white/5 disabled:cursor-not-allowed disabled:text-muted"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
