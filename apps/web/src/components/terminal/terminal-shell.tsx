"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PriceChart } from "@/components/terminal/price-chart";
import { api, apiBase, setToken, token } from "@/lib/api";
import { formatLondon, formatPct, formatPx, formatQty, formatRate, formatUsd } from "@/lib/format";
import type { DataState, Snapshot } from "@/lib/types";

const STATE_CLASS: Record<DataState, string> = {
  LIVE: "border-profit text-profit",
  DELAYED: "border-primary text-primary",
  STALE: "border-loss text-loss",
  REPLAY: "border-muted text-muted",
  DEMO: "border-muted text-muted",
};

export function TerminalShell() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [points, setPoints] = useState<Array<{ time: number; priceUsd: string }>>([]);
  const [notional, setNotional] = useState("10");
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [ticketPending, setTicketPending] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [socketState, setSocketState] = useState("connecting");
  const [clock, setClock] = useState("");

  const refresh = useCallback(async () => {
    const next = await api<Snapshot>("/terminal/snapshot");
    setSnapshot(next);
    setError(null);
    setSelected((current) => current ?? next.market.pairs[0]?.pairAddress ?? null);
  }, []);

  useEffect(() => {
    if (!token()) {
      router.replace("/login");
      return;
    }
    let stop = false;
    refresh()
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Snapshot failed"))
      .finally(() => setLoading(false));
    const poll = window.setInterval(() => {
      if (!stop) void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Snapshot failed"));
    }, 5000);
    const tick = window.setInterval(() => setClock(formatLondon(new Date().toISOString())), 1000);
    setClock(formatLondon(new Date().toISOString()));
    let socket: Socket | null = null;
    const session = token();
    if (session) {
      socket = io(apiBase(), { auth: { token: session }, transports: ["websocket"] });
      socket.on("connect", () => setSocketState("live"));
      socket.on("disconnect", () => setSocketState("down"));
      socket.on("terminal", () => void refresh().catch(() => undefined));
    }
    return () => {
      stop = true;
      window.clearInterval(poll);
      window.clearInterval(tick);
      socket?.close();
    };
  }, [refresh, router]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api<{ points: Array<{ time: number; priceUsd: string }> }>(`/market/observations?pairAddress=${encodeURIComponent(selected)}`)
      .then((result) => {
        if (!cancelled) setPoints(result.points);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, snapshot?.serverTime]);

  const pair = snapshot?.market.pairs.find((item) => item.pairAddress === selected) ?? null;
  const position = snapshot?.portfolio.positions.find((item) => item.pairAddress === selected) ?? null;
  const agents = useMemo(() => ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR", "ARCHIVIST"], []);

  async function control(path: string, body?: unknown) {
    setTicketError(null);
    await api(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
    await refresh();
  }

  async function place(side: "BUY" | "SELL", event?: FormEvent) {
    event?.preventDefault();
    if (!pair) return;
    setTicketPending(true);
    setTicketError(null);
    try {
      const result = await api<{ status: string; error: string | null; orders: Array<{ status: string; rejectReason: string | null }> }>(
        "/orders",
        {
          method: "POST",
          body: JSON.stringify(side === "BUY" ? { side, pairAddress: pair.pairAddress, notionalUsd: notional } : { side, pairAddress: pair.pairAddress }),
        },
      );
      const rejected = result.orders.find((order) => order.status === "REJECTED");
      if (result.status !== "COMPLETE") setTicketError(result.error ?? `Worker status ${result.status}`);
      else if (rejected) setTicketError(rejected.rejectReason ?? "Order rejected");
      await refresh();
    } catch (caught) {
      setTicketError(caught instanceof Error ? caught.message : "Order failed");
    } finally {
      setTicketPending(false);
    }
  }

  if (loading) return <main className="grid min-h-screen place-items-center text-muted">Loading the ledger…</main>;
  if (!snapshot) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-xl">ODIN // QUANT</h1>
          <p className="text-sm text-loss">{error ?? "The terminal could not read the book."}</p>
          <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      </main>
    );
  }

  const dataState = snapshot.market.dataState;
  const can = (action: string) => snapshot.engine.allowedActions.includes(action);

  return (
    <main className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <div>
          <div className="text-sm font-semibold tracking-wide">ODIN // QUANT</div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted">Paper venue · London {clock}</div>
        </div>
        <Badge>PAPER</Badge>
        <Badge className={dataState ? STATE_CLASS[dataState] : ""}>{dataState ?? "NO DATA"}</Badge>
        <Badge className={snapshot.engine.status === "RUNNING" ? "border-profit text-profit" : snapshot.engine.status === "EMERGENCY_STOP" ? "border-loss text-loss" : ""}>
          {snapshot.engine.status}
        </Badge>
        <div className="mono ml-auto text-right text-sm">
          <div>{snapshot.portfolio.equityUsd === null ? "Equity unavailable" : formatUsd(snapshot.portfolio.equityUsd)}</div>
          <div className="text-xs text-muted">Cash {formatUsd(snapshot.portfolio.cashUsd)} · {snapshot.portfolio.valuation}</div>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" disabled={!can("start")} onClick={() => void control("/engine/start")}>Start</Button>
        <Button size="sm" variant="outline" disabled={!can("pause")} onClick={() => void control("/engine/pause")}>Pause</Button>
        <Button size="sm" variant="outline" disabled={!can("resume")} onClick={() => void control("/engine/resume")}>Resume</Button>
        <Button size="sm" variant="danger" disabled={!can("emergency_stop")} onClick={() => setEmergencyOpen(true)}>Emergency stop</Button>
        <Button size="sm" variant="ghost" disabled={!can("stop")} onClick={() => void control("/engine/stop")}>Stand down</Button>
        <Button size="sm" variant="outline" onClick={() => setConfigOpen(true)}>Risk</Button>
        <span className="text-xs text-muted">Socket {socketState}</span>
        <span className="text-xs text-muted">{snapshot.cycle ? `${snapshot.cycle.stage} · ${snapshot.cycle.status}` : "No cycle yet"}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setToken(null); router.push("/login"); }}>Sign out</Button>
      </div>
      {error ? <div className="border-b border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div> : null}
      {dataState && dataState !== "LIVE" ? (
        <div className="border-b border-primary/40 bg-primary/10 px-3 py-2 text-sm">
          Latest snapshot is {dataState}. A paper buy is accepted only when the selected pair itself is LIVE.
        </div>
      ) : null}
      {snapshot.market.pairs.length === 0 ? (
        <div className="border-b border-border px-3 py-2 text-sm text-muted">No live observations persisted. The worker has not recorded a DexScreener snapshot.</div>
      ) : null}

      <section className="hidden min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_340px] grid-rows-[minmax(0,1fr)_220px] gap-2 p-2 lg:grid">
        <Tape pairs={snapshot.market.pairs} selected={selected} onSelect={setSelected} className="row-span-1" />
        <Panel title={pair ? `${pair.baseSymbol} / ${pair.quoteSymbol}` : "Mark"} extra={pair?.dexId}>
          <PriceChart points={points} />
        </Panel>
        <Book snapshot={snapshot} pair={pair} position={position} notional={notional} setNotional={setNotional} pending={ticketPending} ticketError={ticketError} onPlace={place} className="row-span-2" />
        <Panel title="Audit" className="col-span-2">
          <Audit decisions={snapshot.decisions} agents={agents} />
        </Panel>
      </section>

      <section className="min-h-0 flex-1 p-2 lg:hidden">
        <Tabs defaultValue="market">
          <TabsList className="mb-2 w-full">
            <TabsTrigger value="market">Market</TabsTrigger>
            <TabsTrigger value="book">Book</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>
          <TabsContent value="market" className="space-y-2">
            <div className="h-64 rounded-md border border-border"><PriceChart points={points} /></div>
            <Tape pairs={snapshot.market.pairs} selected={selected} onSelect={setSelected} />
          </TabsContent>
          <TabsContent value="book">
            <Book snapshot={snapshot} pair={pair} position={position} notional={notional} setNotional={setNotional} pending={ticketPending} ticketError={ticketError} onPlace={place} />
          </TabsContent>
          <TabsContent value="audit"><Audit decisions={snapshot.decisions} agents={agents} /></TabsContent>
        </Tabs>
      </section>

      <Dialog open={emergencyOpen} onOpenChange={setEmergencyOpen}>
        <DialogContent>
          <DialogTitle className="text-lg">Emergency stop</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted">
            New paper orders halt immediately. Flatten sells only pairs that still have an allowable mark. Missing marks are left open.
          </DialogDescription>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => void control("/engine/emergency-stop", { flatten: false }).then(() => setEmergencyOpen(false))}>Halt</Button>
            <Button variant="outline" onClick={() => void control("/engine/emergency-stop", { flatten: true }).then(() => setEmergencyOpen(false))}>Halt and flatten</Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfigDialog open={configOpen} onOpenChange={setConfigOpen} snapshot={snapshot} onSaved={refresh} />
    </main>
  );
}

function Panel({ title, extra, className, children }: { title: string; extra?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card ${className ?? ""}`}>
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-muted">
        <span>{title}</span>
        {extra ? <span>{extra}</span> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

function Tape({ pairs, selected, onSelect, className }: { pairs: Snapshot["market"]["pairs"]; selected: string | null; onSelect: (pair: string) => void; className?: string }) {
  return (
    <Panel title="Tape" className={className}>
      {pairs.length === 0 ? <p className="p-3 text-sm text-muted">Waiting for the first DexScreener snapshot.</p> : null}
      <ul>
        {pairs.map((pair) => (
          <li key={pair.pairAddress}>
            <button type="button" onClick={() => onSelect(pair.pairAddress)} className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/5 ${selected === pair.pairAddress ? "bg-white/5" : ""}`}>
              <span>
                <span className="block text-sm">{pair.baseSymbol} <span className="text-[10px] text-muted">{pair.freshness}</span></span>
                <span className="text-[11px] text-muted">{pair.quoteSymbol} · {pair.dexId}</span>
              </span>
              <span className="mono text-right text-sm">
                <span className="block">{formatPx(pair.priceUsd)}</span>
                <span className={Number(pair.priceChangeM5Pct ?? 0) >= 0 ? "text-profit" : "text-loss"}>{formatPct(pair.priceChangeM5Pct)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Book({
  snapshot, pair, position, notional, setNotional, pending, ticketError, onPlace, className,
}: {
  snapshot: Snapshot;
  pair: Snapshot["market"]["pairs"][number] | null;
  position: Snapshot["portfolio"]["positions"][number] | null;
  notional: string;
  setNotional: (value: string) => void;
  pending: boolean;
  ticketError: string | null;
  onPlace: (side: "BUY" | "SELL", event?: FormEvent) => Promise<void>;
  className?: string;
}) {
  const live = pair?.freshness === "LIVE" && pair.priceUsd !== null && snapshot.engine.status === "RUNNING";
  return (
    <Panel title="Book" className={className}>
      <div className="space-y-3 p-3 text-sm">
        <dl className="grid grid-cols-2 gap-2">
          <Metric label="Cash" value={formatUsd(snapshot.portfolio.cashUsd)} />
          <Metric label="Equity" value={snapshot.portfolio.equityUsd === null ? "Incomplete" : formatUsd(snapshot.portfolio.equityUsd)} />
          <Metric label="Realized" value={formatUsd(snapshot.portfolio.realizedPnlUsd)} />
          <Metric label="Unrealized" value={formatUsd(snapshot.portfolio.unrealizedPnlUsd)} />
          <Metric label="Fees" value={formatUsd(snapshot.portfolio.feesUsd)} />
          <Metric label="Win rate" value={snapshot.portfolio.closedTrades === 0 ? "—" : formatRate(snapshot.portfolio.winRate)} />
        </dl>
        <p className="text-xs text-muted">Win rate is closed trades only. It stays blank until a position is closed. Return {snapshot.portfolio.returnPct === null ? "—" : formatPct(snapshot.portfolio.returnPct)}.</p>
        {pair ? (
          <p className="text-xs text-muted">
            Liquidity {formatUsd(pair.liquidityUsd)} · 24h {formatUsd(pair.volume24hUsd)} · 5m {formatPct(pair.priceChangeM5Pct)}
          </p>
        ) : null}
        <PairAudit decisions={snapshot.decisions} pairAddress={pair?.pairAddress ?? null} />
        {snapshot.portfolio.positions.length === 0 ? <p className="text-muted">No open paper positions.</p> : (
          <ul className="space-y-2">
            {snapshot.portfolio.positions.map((item) => (
              <li key={item.pairAddress} className="rounded border border-border p-2">
                <div className="flex justify-between"><span>{item.baseSymbol}</span><span className="mono">{formatQty(item.baseQty)}</span></div>
                <div className="text-xs text-muted">Mark {formatPx(item.markUsd)} · {item.markState} · uPnL {formatUsd(item.unrealizedPnlUsd)}</div>
              </li>
            ))}
          </ul>
        )}
        <form className="space-y-2 border-t border-border pt-3" onSubmit={(event) => void onPlace("BUY", event)}>
          <div className="text-xs uppercase tracking-wide text-muted">Paper ticket {pair ? pair.baseSymbol : ""}</div>
          <Label htmlFor="notional">Notional USD</Label>
          <Input id="notional" value={notional} onChange={(event) => setNotional(event.target.value)} inputMode="decimal" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!live || pending}>Buy</Button>
            <Button type="button" size="sm" variant="outline" disabled={!position || snapshot.engine.status !== "RUNNING" || pending || (pair?.freshness !== "LIVE" && pair?.freshness !== "DELAYED")} onClick={() => void onPlace("SELL")}>Close</Button>
          </div>
          {!live ? <p className="text-xs text-muted">Buys require a LIVE quote and a running engine.</p> : null}
          {ticketError ? <p className="text-xs text-loss">{ticketError}</p> : null}
        </form>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted">Recent orders</div>
          {snapshot.orders.length === 0 ? <p className="text-muted">No paper orders recorded.</p> : (
            <ul className="space-y-1 text-xs">
              {snapshot.orders.slice(0, 8).map((order) => (
                <li key={order.id} className="flex justify-between gap-2">
                  <span>{order.side} {order.baseSymbol} {order.status}</span>
                  <span className="mono">{order.fills[0] ? formatPx(order.fills[0].priceUsd) : order.rejectReason ?? formatQty(order.qty)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Audit({ decisions, agents }: { decisions: Snapshot["decisions"]; agents: string[] }) {
  return (
    <div className="grid h-full grid-cols-1 gap-2 p-2 md:grid-cols-[160px_minmax(0,1fr)]">
      <ul className="space-y-1 text-xs">
        {agents.map((agent) => {
          const latest = [...decisions].reverse().find((decision) => decision.agent === agent);
          return <li key={agent} className="rounded border border-border px-2 py-1"><div>{agent}</div><div className="text-muted">{latest?.decision ?? "—"}</div></li>;
        })}
      </ul>
      <div className="overflow-auto text-xs">
        {decisions.length === 0 ? <p className="text-muted">No decisions recorded for the latest cycle.</p> : null}
        {decisions.slice(-12).reverse().map((decision) => (
          <div key={decision.id} className="grid grid-cols-[72px_88px_64px_minmax(0,1fr)] gap-2 border-b border-border/70 py-1">
            <span className="mono text-muted">{formatLondon(decision.createdAt)}</span>
            <span>{decision.agent}</span>
            <span>{decision.decision}</span>
            <span className="truncate text-muted">{decision.reasonText.join(" ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PairAudit({ decisions, pairAddress }: { decisions: Snapshot["decisions"]; pairAddress: string | null }) {
  if (!pairAddress) return null;
  const latest = ["SENTINEL", "PULSE", "AEGIS", "ATLAS", "EXECUTOR"]
    .map((agent) => [...decisions].reverse().find((decision) => decision.agent === agent && decision.pairAddress === pairAddress))
    .filter((decision) => decision !== undefined);
  if (latest.length === 0) return <p className="text-xs text-muted">No decision yet for this pair in the latest cycle.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {latest.map((decision) => (
        <li key={decision.id} className="flex justify-between gap-2">
          <span>{decision.agent} {decision.decision}</span>
          <span className="truncate text-muted">{decision.reasonText[0]}</span>
        </li>
      ))}
    </ul>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

function ConfigDialog({ open, onOpenChange, snapshot, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; snapshot: Snapshot; onSaved: () => Promise<void> }) {
  const config = snapshot.engine.config;
  const [balance, setBalance] = useState(String(config?.startingBalanceUsd ?? "100"));
  const [maxPositions, setMaxPositions] = useState(String(config?.maxPositions ?? "3"));
  const [entry, setEntry] = useState(String(config?.entryM5ChangePct ?? "2"));
  const [anomaly, setAnomaly] = useState(String(config?.maxEntryM5ChangePct ?? "25"));
  const [stop, setStop] = useState(String(config?.stopLossPct ?? "3"));
  const [target, setTarget] = useState(String(config?.takeProfitPct ?? "5"));
  const [message, setMessage] = useState<string | null>(null);

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
      await onSaved();
      onOpenChange(false);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Config rejected");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Risk and strategy</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted">Pause the engine before saving. Automatic entries also require a SOL, USDC, or USDT quote mint. The starting balance changes only while stopped and before any order.</DialogDescription>
        <form className="mt-3 space-y-2" onSubmit={(event) => void save(event)}>
          <Label htmlFor="balance">Starting balance USD</Label>
          <Input id="balance" value={balance} onChange={(event) => setBalance(event.target.value)} />
          <Label htmlFor="positions">Max positions</Label>
          <Input id="positions" value={maxPositions} onChange={(event) => setMaxPositions(event.target.value)} />
          <Label htmlFor="entry">Entry 5-minute change %</Label>
          <Input id="entry" value={entry} onChange={(event) => setEntry(event.target.value)} />
          <Label htmlFor="anomaly">Maximum 5-minute change %</Label>
          <Input id="anomaly" value={anomaly} onChange={(event) => setAnomaly(event.target.value)} />
          <Label htmlFor="stop">Stop loss %</Label>
          <Input id="stop" value={stop} onChange={(event) => setStop(event.target.value)} />
          <Label htmlFor="target">Take profit %</Label>
          <Input id="target" value={target} onChange={(event) => setTarget(event.target.value)} />
          {message ? <p className="text-sm text-loss">{message}</p> : null}
          <Button type="submit">Save</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
