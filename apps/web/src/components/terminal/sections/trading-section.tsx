"use client";

import { type FormEvent, useEffect, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { PriceChart } from "@/components/terminal/price-chart";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatLondonDateTime, formatPct, formatPx, formatQty, formatUsd, signedClass } from "@/lib/format";
import { cn } from "@/lib/utils";

export function TradingSection() {
  const { snapshot, refresh } = useSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const [points, setPoints] = useState<Array<{ time: number; priceUsd: string }>>([]);
  const [notional, setNotional] = useState("10");
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [ticketPending, setTicketPending] = useState(false);
  const [inspectId, setInspectId] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    setSelected((current) => current ?? snapshot.market.pairs[0]?.pairAddress ?? null);
  }, [snapshot]);

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

  if (!snapshot) return null;
  const pair = snapshot.market.pairs.find((item) => item.pairAddress === selected) ?? null;
  const position = snapshot.portfolio.positions.find((item) => item.pairAddress === selected) ?? null;
  const inspect = snapshot.orders.find((order) => order.id === inspectId) ?? null;
  const live = pair?.freshness === "LIVE" && pair.priceUsd !== null && snapshot.engine.status === "RUNNING";

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

  return (
    <div className="grid gap-3 xl:grid-cols-[260px_minmax(0,1fr)_300px] animate-odin-fade">
      <Panel title="Universe tape" extra={`${snapshot.market.pairs.length} pairs`}>
        {snapshot.market.pairs.length === 0 ? (
          <EmptyState title="No live observations" detail="Worker has not persisted a DexScreener snapshot yet." />
        ) : (
          <ul>
            {snapshot.market.pairs.map((item) => (
              <li key={item.pairAddress}>
                <button
                  type="button"
                  onClick={() => setSelected(item.pairAddress)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/[0.03]",
                    selected === item.pairAddress && "bg-white/[0.04]",
                  )}
                >
                  <span>
                    <span className="block text-sm">
                      {item.baseSymbol} <span className="text-[10px] text-muted">{item.freshness}</span>
                    </span>
                    <span className="text-[11px] text-muted">
                      {item.quoteSymbol} · {item.dexId}
                    </span>
                  </span>
                  <span className="mono text-right text-sm">
                    <span className="block">{formatPx(item.priceUsd)}</span>
                    <span className={signedClass(item.priceChangeM5Pct)}>{formatPct(item.priceChangeM5Pct)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={pair ? `${pair.baseSymbol} / ${pair.quoteSymbol}` : "Mark"} extra={pair?.dexId} className="min-h-[320px]">
        <PriceChart points={points} />
      </Panel>

      <Panel title="Paper ticket">
        <div className="space-y-3 p-3 text-sm">
          {pair ? (
            <p className="text-xs text-muted">
              Liquidity {formatUsd(pair.liquidityUsd)} · 24h {formatUsd(pair.volume24hUsd)} · 5m {formatPct(pair.priceChangeM5Pct)}
            </p>
          ) : (
            <p className="text-xs text-muted">Select a pair from the tape.</p>
          )}
          {position ? (
            <div className="rounded border border-border p-2 text-xs">
              Open {formatQty(position.baseQty)} · mark {formatPx(position.markUsd)} · uPnL{" "}
              <span className={signedClass(position.unrealizedPnlUsd)}>{formatUsd(position.unrealizedPnlUsd)}</span>
            </div>
          ) : null}
          <form className="space-y-2" onSubmit={(event) => void place("BUY", event)}>
            <Label htmlFor="notional">Notional USD</Label>
            <Input id="notional" value={notional} onChange={(event) => setNotional(event.target.value)} inputMode="decimal" />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!live || ticketPending}>
                Buy
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !position ||
                  snapshot.engine.status !== "RUNNING" ||
                  ticketPending ||
                  (pair?.freshness !== "LIVE" && pair?.freshness !== "DELAYED")
                }
                onClick={() => void place("SELL")}
              >
                Close
              </Button>
            </div>
            {!live ? <p className="text-xs text-muted">Buys require a LIVE quote and a running engine.</p> : null}
            {ticketError ? <p className="text-xs text-loss">{ticketError}</p> : null}
          </form>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted">Recent orders</div>
            {snapshot.orders.length === 0 ? (
              <p className="text-xs text-muted">No paper orders recorded.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {snapshot.orders.slice(0, 10).map((order) => (
                  <li key={order.id}>
                    <button type="button" className="flex w-full justify-between gap-2 text-left hover:text-primary" onClick={() => setInspectId(order.id)}>
                      <span>
                        {order.side} {order.baseSymbol} {order.status}
                      </span>
                      <span className="mono text-muted">{order.fills[0] ? formatPx(order.fills[0].priceUsd) : order.rejectReason ?? formatQty(order.qty)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>

      <Dialog open={inspect !== null} onOpenChange={(open) => !open && setInspectId(null)}>
        <DialogContent>
          <DialogTitle>Trade inspection</DialogTitle>
          <DialogDescription className="text-sm text-muted">Ledger-backed order and fill details. No invented prices.</DialogDescription>
          {inspect ? (
            <div className="mt-3 space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>Side {inspect.side}</div>
                <div>Status {inspect.status}</div>
                <div>Intent {inspect.intent}</div>
                <div>Qty {formatQty(inspect.qty)}</div>
                <div className="col-span-2 text-muted">{formatLondonDateTime(inspect.createdAt)}</div>
              </div>
              {inspect.rejectReason ? <p className="text-loss">{inspect.rejectReason}</p> : null}
              <ul className="space-y-1 text-xs">
                {inspect.fills.map((fill, index) => (
                  <li key={fill.id ?? index} className="rounded border border-border p-2 mono">
                    {formatPx(fill.priceUsd)} · qty {formatQty(fill.qty)} · fee {formatUsd(fill.feeUsd)}
                    {fill.slippageBps != null ? ` · slip ${fill.slippageBps} bps` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
