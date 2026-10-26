"use client";

import { useState } from "react";
import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatLondonDateTime, formatPx, formatQty, formatUsd } from "@/lib/format";

export function HistorySection() {
  const { snapshot } = useSnapshot();
  const [inspectId, setInspectId] = useState<string | null>(null);
  if (!snapshot) return null;
  const inspect = snapshot.orders.find((order) => order.id === inspectId) ?? null;

  return (
    <>
      <Panel title="Trade history" extra={`${snapshot.orders.length} recent orders`} className="animate-odin-fade">
        {snapshot.orders.length === 0 ? (
          <EmptyState title="No paper orders" detail="Orders and fills from the ledger appear here." />
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Intent</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Fill</th>
                  <th className="px-3 py-2">Fee</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.orders.map((order) => (
                  <tr
                    key={order.id}
                    className="cursor-pointer border-b border-border/70 hover:bg-white/[0.02]"
                    onClick={() => setInspectId(order.id)}
                  >
                    <td className="mono px-3 py-2 text-muted">{formatLondonDateTime(order.createdAt)}</td>
                    <td className="px-3 py-2">{order.side}</td>
                    <td className="px-3 py-2">{order.baseSymbol}</td>
                    <td className="px-3 py-2">{order.intent}</td>
                    <td className="px-3 py-2">{order.status}</td>
                    <td className="mono px-3 py-2">{formatQty(order.qty)}</td>
                    <td className="mono px-3 py-2">{order.fills[0] ? formatPx(order.fills[0].priceUsd) : order.rejectReason ?? "—"}</td>
                    <td className="mono px-3 py-2">{order.fills[0] ? formatUsd(order.fills[0].feeUsd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Dialog open={inspect !== null} onOpenChange={(open) => !open && setInspectId(null)}>
        <DialogContent>
          <DialogTitle>Order detail</DialogTitle>
          <DialogDescription className="text-sm text-muted">Paper order from the Nest ledger.</DialogDescription>
          {inspect ? (
            <pre className="mt-3 max-h-[50vh] overflow-auto rounded border border-border bg-panel p-2 text-[11px] text-muted">
              {JSON.stringify(inspect, null, 2)}
            </pre>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
