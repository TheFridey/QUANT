"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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

type OrderReceipt = {
  cycleId: string;
  clientIntentId: string | null;
  accepted: boolean;
  replayed: boolean;
  pending: boolean;
  status: string;
  stage?: string;
  error: string | null;
  message?: string;
  orders: Array<{
    id?: string;
    clientOrderId?: string;
    status: string;
    side: string;
    qty: string;
    rejectReason: string | null;
    fills: Array<{ priceUsd: string; qty: string; feeUsd: string }>;
  }>;
};

function newClientIntentId(side: "BUY" | "SELL"): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`;
  return `intent_${side.toLowerCase()}_${rand}`;
}

export function TradingSection() {
  const { snapshot, refresh } = useSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const [points, setPoints] = useState<Array<{ time: number; priceUsd: string }>>([]);
  const [notional, setNotional] = useState("10");
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [ticketPending, setTicketPending] = useState(false);
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const intentRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    setSelected((current) => current ?? snapshot.market.pairs[0]?.pairAddress ?? snapshot.portfolio.positions[0]?.pairAddress ?? null);
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

  useEffect(() => {
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, []);

  const pair = snapshot?.market.pairs.find((item) => item.pairAddress === selected) ?? null;
  const position = snapshot?.portfolio.positions.find((item) => item.pairAddress === selected) ?? null;
  const inspect = snapshot?.orders.find((order) => order.id === inspectId) ?? null;
  const engineOkForBuy = snapshot?.engine.status === "RUNNING";
  const engineOkForSell = snapshot?.engine.status === "RUNNING" || snapshot?.engine.status === "PAUSED";
  const live = Boolean(pair?.freshness === "LIVE" && pair.priceUsd !== null && engineOkForBuy);
  const config = snapshot?.engine.config;

  const preview = useMemo(() => {
    if (!snapshot) return null;
    const price = pair?.priceUsd ? Number(pair.priceUsd) : null;
    const notion = Number(notional);
    const feeBps = Number(config?.feeBps ?? 30);
    const stopPct = Number(config?.stopLossPct ?? 3);
    const slipBps = Number(config?.maxSlippageBps ?? 150);
    const cash = Number(snapshot.portfolio.availableFundsUsd ?? snapshot.portfolio.cashUsd);
    if (!price || !Number.isFinite(notion) || notion <= 0) {
      return null;
    }
    const qty = notion / price;
    const feeUsd = (notion * feeBps) / 10_000;
    const slipUsd = (notion * slipBps) / 10_000;
    const stopLossUsd = (notion * stopPct) / 100;
    return {
      qty,
      feeUsd,
      slipUsd,
      stopLossUsd,
      cash,
      account: snapshot.execution?.metricsAccountId ?? "primary",
      environment: snapshot.execution?.tradingEnvironment ?? "MARKET_DATA_PAPER",
      affordable: cash + 1e-9 >= notion + feeUsd,
    };
  }, [pair?.priceUsd, notional, config, snapshot]);

  async function pollReceipt(cycleId: string, clientIntentId: string) {
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void api<OrderReceipt>(
        `/orders/receipt?cycleId=${encodeURIComponent(cycleId)}&clientIntentId=${encodeURIComponent(clientIntentId)}`,
      )
        .then((next) => {
          setReceipt(next);
          if (!next.pending) {
            if (pollRef.current != null) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setTicketPending(false);
            const rejected = next.orders.find((order) => order.status === "REJECTED");
            if (next.status !== "COMPLETE" && next.error) setTicketError(next.error);
            else if (rejected) setTicketError(rejected.rejectReason ?? "Order rejected");
            else setTicketError(null);
            void refresh();
          }
        })
        .catch(() => undefined);
    }, 750);
  }

  async function place(side: "BUY" | "SELL", event?: FormEvent) {
    event?.preventDefault();
    if (!selected) return;
    setTicketPending(true);
    setTicketError(null);
    const clientIntentId = intentRef.current && receipt?.pending ? intentRef.current : newClientIntentId(side);
    intentRef.current = clientIntentId;
    try {
      const body =
        side === "BUY"
          ? { side, pairAddress: selected, notionalUsd: notional, clientIntentId }
          : { side, pairAddress: selected, clientIntentId };
      const result = await api<OrderReceipt>("/orders", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setReceipt(result);
      if (result.pending) {
        await pollReceipt(result.cycleId, clientIntentId);
      } else {
        setTicketPending(false);
        const rejected = result.orders.find((order) => order.status === "REJECTED");
        if (result.status !== "COMPLETE" && result.error) setTicketError(result.error);
        else if (rejected) setTicketError(rejected.rejectReason ?? "Order rejected");
        await refresh();
      }
    } catch (caught) {
      setTicketPending(false);
      setTicketError(caught instanceof Error ? caught.message : "Order failed");
    }
  }

  if (!snapshot) return null;

  const heldOffTape = snapshot.portfolio.positions.filter(
    (row) => !snapshot.market.pairs.some((item) => item.pairAddress === row.pairAddress),
  );

  return (
    <div className="grid gap-3 xl:grid-cols-[260px_minmax(0,1fr)_300px] animate-odin-fade">
      <Panel title="Universe tape" extra={`${snapshot.market.pairs.length} pairs`}>
        {snapshot.market.pairs.length === 0 && heldOffTape.length === 0 ? (
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
            {heldOffTape.map((item) => (
              <li key={`held-${item.pairAddress}`}>
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
                      {item.baseSymbol} <span className="text-[10px] text-warning">held</span>
                    </span>
                    <span className="text-[11px] text-muted">Not on discovery tape</span>
                  </span>
                  <span className="mono text-right text-sm">{formatQty(item.baseQty)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={pair ? `${pair.baseSymbol} / ${pair.quoteSymbol}` : selected ?? "Mark"} extra={pair?.dexId} className="min-h-[320px]">
        <PriceChart points={points} />
      </Panel>

      <Panel title="Paper ticket">
        <div className="space-y-3 p-3 text-sm">
          {pair ? (
            <p className="text-xs text-muted">
              Liquidity {formatUsd(pair.liquidityUsd)} · 24h {formatUsd(pair.volume24hUsd)} · 5m {formatPct(pair.priceChangeM5Pct)}
            </p>
          ) : selected ? (
            <p className="text-xs text-muted">Held instrument selected for reduce-only close.</p>
          ) : (
            <p className="text-xs text-muted">Select a pair from the tape.</p>
          )}
          {position ? (
            <div className="rounded border border-border p-2 text-xs">
              Open {formatQty(position.baseQty)} · mark {formatPx(position.markUsd)} · uPnL{" "}
              <span className={signedClass(position.unrealizedPnlUsd)}>{formatUsd(position.unrealizedPnlUsd)}</span>
            </div>
          ) : null}
          {preview ? (
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 rounded border border-border/80 bg-panel-2/40 p-2 text-[11px]">
              <div>
                <dt className="text-muted">Est. qty</dt>
                <dd className="mono">{formatQty(String(preview.qty))}</dd>
              </div>
              <div>
                <dt className="text-muted">Est. fees</dt>
                <dd className="mono">{formatUsd(String(preview.feeUsd))}</dd>
              </div>
              <div>
                <dt className="text-muted">Stop risk</dt>
                <dd className="mono">{formatUsd(String(preview.stopLossUsd))}</dd>
              </div>
              <div>
                <dt className="text-muted">Cash / budget</dt>
                <dd className={cn("mono", preview.affordable ? "" : "text-loss")}>{formatUsd(String(preview.cash))}</dd>
              </div>
              <div className="col-span-2 text-muted">
                Account {preview.account} · {preview.environment}
              </div>
            </dl>
          ) : null}
          <form className="space-y-2" onSubmit={(event) => void place("BUY", event)}>
            <Label htmlFor="notional">Notional USD</Label>
            <Input id="notional" value={notional} onChange={(event) => setNotional(event.target.value)} inputMode="decimal" />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!live || ticketPending || (preview != null && !preview.affordable)}>
                Buy
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !position ||
                  !engineOkForSell ||
                  ticketPending ||
                  (pair != null && pair.freshness !== "LIVE" && pair.freshness !== "DELAYED")
                }
                onClick={() => void place("SELL")}
              >
                Close
              </Button>
            </div>
            {!live ? <p className="text-xs text-muted">Buys require a LIVE quote and a running engine. Close works while paused.</p> : null}
            {ticketError ? <p className="text-xs text-loss">{ticketError}</p> : null}
            {receipt ? (
              <p className={`text-xs ${receipt.pending ? "text-warning" : "text-muted"}`}>
                {receipt.pending ? "Pending · " : ""}
                {receipt.message ?? receipt.status}
                {receipt.replayed ? " · replayed intent" : ""} · {receipt.cycleId}
              </p>
            ) : null}
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
