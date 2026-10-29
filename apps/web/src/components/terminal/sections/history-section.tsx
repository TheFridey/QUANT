"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatLondonDateTime, formatPx, formatQty, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type HistoryKind = "orders" | "trades";

type HistoryItem = {
  id: string;
  clientOrderId?: string;
  pairAddress?: string;
  baseSymbol: string;
  side: string;
  intent: string;
  status: string;
  qty: string;
  rejectReason: string | null;
  executionMode?: string;
  strategyVersion?: string | null;
  createdAt: string;
  recordKind?: "order" | "trade";
  fillCount?: number;
  avgFillPx?: string | null;
  fillQty?: string;
  fillNotionalUsd?: string;
  fillFeesUsd?: string;
  fills: Array<{
    id?: string;
    priceUsd: string;
    qty: string;
    feeUsd: string;
    notionalUsd: string;
    slippageBps?: string;
    observationId?: string;
  }>;
};

type HistoryPage = {
  kind: HistoryKind;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: HistoryItem[];
  note?: string;
};

const PAGE_SIZE = 40;

export function HistorySection() {
  const { snapshot } = useSnapshot();
  const [kind, setKind] = useState<HistoryKind>("orders");
  const [side, setSide] = useState<string>("");
  const [symbol, setSymbol] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);

  const meta = snapshot?.historyMeta;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        kind,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (side) params.set("side", side);
      if (symbol.trim()) params.set("symbol", symbol.trim());
      const result = await api<HistoryPage>(`/terminal/history?${params.toString()}`);
      setPage(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "History load failed");
      // Fallback: snapshot window only
      if (snapshot?.orders) {
        setPage({
          kind,
          limit: PAGE_SIZE,
          offset: 0,
          total: snapshot.orders.length,
          hasMore: false,
          nextOffset: null,
          items: snapshot.orders.map((order) => ({
            ...order,
            recordKind: order.fills.length > 0 ? "trade" : "order",
            fillCount: order.fills.length,
          })),
          note: "Showing snapshot window (paginated history unavailable).",
        });
      }
    } finally {
      setLoading(false);
    }
  }, [kind, offset, side, symbol, snapshot?.orders]);

  useEffect(() => {
    void load();
  }, [load]);

  const inspect = page?.items.find((item) => item.id === inspectId) ?? null;
  const items = page?.items ?? [];

  function openDetail(id: string) {
    setInspectId(id);
  }

  return (
    <>
      <Panel
        title="Trade history"
        extra={
          meta
            ? `ledger ${meta.orderTotal} orders / ${meta.fillTotal} fills · page ${items.length}`
            : `${items.length} rows`
        }
        className="animate-odin-fade"
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-3 py-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-[0.12em] text-muted">View</Label>
            <div className="flex gap-1" role="group" aria-label="Order versus trade view">
              {(
                [
                  ["orders", "Orders"],
                  ["trades", "Trades (fills)"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setKind(value);
                    setOffset(0);
                  }}
                  className={cn(
                    "rounded border px-2.5 py-1.5 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    kind === value ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted",
                  )}
                  aria-pressed={kind === value}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-side" className="text-[10px] uppercase tracking-[0.12em] text-muted">
              Side
            </Label>
            <select
              id="history-side"
              value={side}
              onChange={(event) => {
                setSide(event.target.value);
                setOffset(0);
              }}
              className="h-9 rounded-md border border-border bg-panel px-2 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <option value="">All</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-symbol" className="text-[10px] uppercase tracking-[0.12em] text-muted">
              Symbol
            </Label>
            <Input
              id="history-symbol"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setOffset(0);
                  void load();
                }
              }}
              placeholder="e.g. SOL"
              className="h-9 w-[120px] text-xs"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setOffset(0);
              void load();
            }}
            disabled={loading}
          >
            {loading ? "Loading…" : "Apply"}
          </Button>
          {meta?.truncated ? (
            <p className="text-[11px] text-muted">
              Snapshot embeds {meta.snapshotLimit}; ledger has {meta.orderTotal}. Use pagination below.
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="status" className="border-b border-border px-3 py-2 text-xs text-warning">
            {error}
          </p>
        ) : null}
        {page?.note ? <p className="border-b border-border px-3 py-2 text-[11px] text-muted">{page.note}</p> : null}

        {items.length === 0 ? (
          <EmptyState title="No ledger rows" detail="Orders and fills from the paper ledger appear here." />
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[920px] text-left text-xs">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Intent</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Fill / avg</th>
                  <th className="px-3 py-2">Fee</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((order) => {
                  const kindLabel = order.recordKind === "trade" || (order.fills?.length ?? 0) > 0 ? "TRADE" : "ORDER";
                  const fillPx =
                    order.avgFillPx ??
                    (order.fills[0] ? order.fills[0].priceUsd : null);
                  const fee =
                    order.fillFeesUsd ??
                    (order.fills[0] ? order.fills[0].feeUsd : null);
                  return (
                    <tr
                      key={order.id}
                      className="border-b border-border/70 hover:bg-white/[0.02]"
                    >
                      <td className="mono px-3 py-2 text-muted">{formatLondonDateTime(order.createdAt)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em]",
                            kindLabel === "TRADE"
                              ? "border-profit/30 text-profit"
                              : "border-border text-muted",
                          )}
                        >
                          {kindLabel}
                          {order.fillCount && order.fillCount > 1 ? ` ×${order.fillCount}` : ""}
                        </span>
                      </td>
                      <td className="px-3 py-2">{order.side}</td>
                      <td className="px-3 py-2">{order.baseSymbol}</td>
                      <td className="px-3 py-2">{order.intent}</td>
                      <td className="px-3 py-2">{order.status}</td>
                      <td className="mono px-3 py-2">{formatQty(order.fillQty ?? order.qty)}</td>
                      <td className="mono px-3 py-2">
                        {fillPx ? formatPx(fillPx) : order.rejectReason ?? "—"}
                      </td>
                      <td className="mono px-3 py-2">{fee ? formatUsd(fee) : "—"}</td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => openDetail(order.id)}
                          aria-label={`Open detail for ${order.side} ${order.baseSymbol} ${order.status}`}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
          <p className="text-[11px] text-muted" aria-live="polite">
            {page
              ? `Showing ${page.offset + 1}–${page.offset + items.length} of ${page.total}`
              : "—"}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={loading || offset <= 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={loading || !page?.hasMore}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>

      <Dialog open={inspect !== null} onOpenChange={(open) => !open && setInspectId(null)}>
        <DialogContent>
          <DialogTitle>
            {inspect?.recordKind === "trade" || (inspect?.fills.length ?? 0) > 0 ? "Trade detail" : "Order detail"}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted">
            {inspect
              ? `${inspect.side} ${inspect.baseSymbol} · ${inspect.status} · ${inspect.intent}`
              : "Paper ledger row"}
          </DialogDescription>
          {inspect ? (
            <div className="mt-3 space-y-3 text-xs">
              <dl className="grid grid-cols-2 gap-2">
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">Created</dt>
                  <dd className="mono">{formatLondonDateTime(inspect.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">Client order</dt>
                  <dd className="mono truncate">{inspect.clientOrderId ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">Qty</dt>
                  <dd className="mono">{formatQty(inspect.qty)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">Strategy</dt>
                  <dd className="mono truncate">{inspect.strategyVersion ?? "—"}</dd>
                </div>
              </dl>
              {inspect.fills.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted">
                    Fills ({inspect.fills.length})
                    {inspect.avgFillPx ? ` · avg ${formatPx(inspect.avgFillPx)}` : ""}
                  </div>
                  <ul className="divide-y divide-border rounded border border-border">
                    {inspect.fills.map((fill, index) => (
                      <li key={fill.id ?? index} className="mono grid grid-cols-4 gap-2 px-2 py-1.5 text-[11px]">
                        <span>{formatPx(fill.priceUsd)}</span>
                        <span>{formatQty(fill.qty)}</span>
                        <span>{formatUsd(fill.feeUsd)}</span>
                        <span className="text-muted">{formatUsd(fill.notionalUsd)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted">
                  {inspect.rejectReason ? `Rejected: ${inspect.rejectReason}` : "No fills on this order."}
                </p>
              )}
              <pre className="max-h-[30vh] overflow-auto rounded border border-border bg-panel p-2 text-[11px] text-muted">
                {JSON.stringify(inspect, null, 2)}
              </pre>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
