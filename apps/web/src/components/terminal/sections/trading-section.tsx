"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { PriceChart, type ChartPoint } from "@/components/terminal/price-chart";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { estimateTicket } from "@/lib/estimates";
import { formatLondonDateTime, formatPct, formatPx, formatQty, formatUsd, formatUsdCompact, signedClass } from "@/lib/format";
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
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [notional, setNotional] = useState("10");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [sellQty, setSellQty] = useState("");
  const [reviewing, setReviewing] = useState(false);
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
    api<{ points: ChartPoint[] }>(`/market/observations?pairAddress=${encodeURIComponent(selected)}`)
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

  const price = pair?.priceUsd ? Number(pair.priceUsd) : position?.markUsd ? Number(position.markUsd) : null;
  const stopPct = Number(config?.stopLossPct ?? 3);
  const targetPct = Number(config?.takeProfitPct ?? 5);
  const cash = Number(snapshot?.portfolio.availableFundsUsd ?? snapshot?.portfolio.cashUsd ?? 0);
  const exposure = snapshot?.portfolio.exposureUsd != null ? Number(snapshot.portfolio.exposureUsd) : null;
  const riskCap = snapshot?.portfolio.openRiskCapUsd != null ? Number(snapshot.portfolio.openRiskCapUsd) : null;

  // UI item 9: one estimate drives the ticket, the review step and the close confirmation.
  const estimate = useMemo(() => {
    if (!price) return null;
    const qty = side === "BUY" ? Number(notional) / price : Number(sellQty || position?.baseQty || 0);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    return estimateTicket({
      side,
      priceUsd: price,
      qty,
      liquidityUsd: pair?.liquidityUsd ? Number(pair.liquidityUsd) : null,
      feeBps: Number(config?.feeBps ?? 30),
      spreadBps: Number(config?.spreadBpsEstimate ?? 5),
      stopLossPct: stopPct,
      exposureUsd: exposure,
    });
  }, [price, side, notional, sellQty, position?.baseQty, pair?.liquidityUsd, config, stopPct, exposure]);
  const affordable = estimate === null || side === "SELL" || cash + 1e-9 >= estimate.notionalUsd + estimate.feeUsd;

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

  async function place(orderSide: "BUY" | "SELL", event?: FormEvent) {
    const side = orderSide;
    event?.preventDefault();
    if (!selected) return;
    setTicketPending(true);
    setTicketError(null);
    const clientIntentId = intentRef.current && receipt?.pending ? intentRef.current : newClientIntentId(side);
    intentRef.current = clientIntentId;
    try {
      const fullClose = !sellQty || (position && Number(sellQty) >= Number(position.baseQty));
      const body =
        side === "BUY"
          ? { side, pairAddress: selected, notionalUsd: notional, clientIntentId }
          : fullClose
            ? { side, pairAddress: selected, clientIntentId }
            : { side, pairAddress: selected, clientIntentId, scope: "NET" as const, qty: Number(sellQty).toFixed(8) };
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
        <PriceChart
          points={points}
          levels={position ? { entryUsd: position.avgCostUsd, stopUsd: position.stopUsd, targetUsd: position.targetUsd } : undefined}
        />
      </Panel>

      <Panel title="Paper ticket">
        <div className="space-y-3 p-3 text-sm">
          {pair ? (
            <p className="text-xs text-muted">
              Liquidity {formatUsdCompact(pair.liquidityUsd)} · 24h {formatUsdCompact(pair.volume24hUsd)} · 5m {formatPct(pair.priceChangeM5Pct)}
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
          <div role="group" aria-label="Order side" className="grid grid-cols-2 gap-1 rounded border border-border p-0.5">
            {(["BUY", "SELL"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={side === option}
                onClick={() => {
                  setSide(option);
                  setReviewing(false);
                }}
                className={cn(
                  "rounded px-2 py-1 text-xs font-medium",
                  side === option ? (option === "BUY" ? "bg-profit/20 text-profit" : "bg-loss/20 text-loss") : "text-muted",
                )}
              >
                {option === "BUY" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reviewing) setReviewing(true);
              else void place(side, event).then(() => setReviewing(false));
            }}
          >
            {side === "BUY" ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="notional">Notional (USD)</Label>
                  <Input
                    id="notional"
                    value={notional}
                    inputMode="decimal"
                    onChange={(event) => {
                      setNotional(event.target.value);
                      setReviewing(false);
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input
                    id="quantity"
                    inputMode="decimal"
                    value={price && Number(notional) > 0 ? formatQty((Number(notional) / price).toFixed(8)).replace(/,/g, "") : ""}
                    onChange={(event) => {
                      const qty = Number(event.target.value);
                      if (price && Number.isFinite(qty)) setNotional((qty * price).toFixed(2));
                      setReviewing(false);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div>
                <Label htmlFor="sell-qty">Quantity to sell</Label>
                <Input
                  id="sell-qty"
                  inputMode="decimal"
                  placeholder={position ? `All (${formatQty(position.baseQty)})` : "No open position"}
                  value={sellQty}
                  onChange={(event) => {
                    setSellQty(event.target.value);
                    setReviewing(false);
                  }}
                />
              </div>
            )}
            {side === "BUY" && price ? (
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]" title="Strategy defaults; the engine arms these after the fill">
                <div>
                  <dt className="text-muted">Stop (strategy, −{stopPct}%)</dt>
                  <dd className="mono">{formatPx(String(price * (1 - stopPct / 100)))}</dd>
                </div>
                <div>
                  <dt className="text-muted">Target (strategy, +{targetPct}%)</dt>
                  <dd className="mono">{formatPx(String(price * (1 + targetPct / 100)))}</dd>
                </div>
              </dl>
            ) : null}
            {reviewing && estimate ? (
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 rounded border border-primary/40 bg-panel-2/40 p-2 text-[11px]" aria-live="polite">
                <div>
                  <dt className="text-muted">Est. quantity</dt>
                  <dd className="mono">{formatQty(estimate.qty.toFixed(8))}</dd>
                </div>
                <div>
                  <dt className="text-muted">Est. fees</dt>
                  <dd className="mono">{formatUsd(estimate.feeUsd.toFixed(2))}</dd>
                </div>
                <div>
                  <dt className="text-muted">Est. impact</dt>
                  <dd className="mono">
                    {estimate.impactBps === null ? "—" : `${estimate.impactBps.toFixed(0)} bps · ${formatUsd((estimate.impactUsd ?? 0).toFixed(2))}`}
                  </dd>
                </div>
                {side === "BUY" ? (
                  <div>
                    <dt className="text-muted">Loss if stopped</dt>
                    <dd className="mono text-loss">{formatUsd((estimate.stopRiskUsd ?? 0).toFixed(2))}</dd>
                  </div>
                ) : (
                  <div>
                    <dt className="text-muted">Est. proceeds</dt>
                    <dd className="mono">{formatUsd((estimate.proceedsUsd ?? 0).toFixed(2))}</dd>
                  </div>
                )}
                <div className="col-span-2">
                  <dt className="text-muted">Open risk after trade</dt>
                  <dd className="mono">
                    {estimate.postTradeExposureUsd === null ? "—" : formatUsd(estimate.postTradeExposureUsd.toFixed(2))}
                    {riskCap !== null ? <span className="text-muted"> of {formatUsd(riskCap.toFixed(2))} cap</span> : null}
                  </dd>
                </div>
              </dl>
            ) : null}
            <div className="flex gap-2">
              {side === "BUY" ? (
                <Button type="submit" size="sm" disabled={!live || ticketPending || !estimate || !affordable}>
                  {reviewing ? "Confirm buy" : "Review buy"}
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={
                    !position ||
                    !engineOkForSell ||
                    ticketPending ||
                    (pair != null && pair.freshness !== "LIVE" && pair.freshness !== "DELAYED")
                  }
                >
                  {reviewing ? "Confirm sell" : "Review sell"}
                </Button>
              )}
              {reviewing ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setReviewing(false)}>
                  Back
                </Button>
              ) : null}
            </div>
            {side === "BUY" && !live ? <p className="text-xs text-muted">Buying needs a live quote and a running engine. Selling also works while paused.</p> : null}
            {side === "BUY" && !affordable ? <p className="text-xs text-loss">Not enough cash for this size plus fees.</p> : null}
            {ticketError ? <p className="text-xs text-loss">{ticketError}</p> : null}
            {receipt ? (
              <p className={`text-xs ${receipt.pending ? "text-warning" : "text-muted"}`}>
                {receipt.pending ? "Pending · " : ""}
                {receipt.message ?? receipt.status}
                {receipt.replayed ? " · replayed" : ""}
              </p>
            ) : null}
          </form>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted">Recent orders</div>
            {snapshot.orders.length === 0 ? (
              <p className="text-xs text-muted">No paper orders recorded.</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="font-normal">Order</th>
                    <th className="font-normal text-right">Qty</th>
                    <th className="font-normal text-right">Time</th>
                    <th className="font-normal text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.orders.slice(0, 10).map((order) => (
                    <tr key={order.id}>
                      <td>
                        <button type="button" className="text-left hover:text-primary" onClick={() => setInspectId(order.id)}>
                          {order.side === "BUY" ? "Buy" : "Sell"} {order.baseSymbol}
                        </button>
                      </td>
                      <td className="mono text-right">{formatQty(order.fills[0]?.qty ?? order.qty)}</td>
                      <td className="mono text-right text-muted">{formatLondonDateTime(order.createdAt).slice(-8)}</td>
                      <td className={cn("text-right", order.status === "REJECTED" ? "text-loss" : order.status === "FILLED" ? "text-profit" : "text-muted")}>
                        <span title={order.rejectReason ?? undefined}>{order.status.toLowerCase()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
