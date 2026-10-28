"use client";

import { EmptyState, Panel } from "@/components/terminal/panel";
import { useSnapshot } from "@/components/terminal/snapshot-context";
import { formatDuration, formatPct, formatPx, formatQty, formatUsd, signedClass } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PositionsSection() {
  const { snapshot } = useSnapshot();
  if (!snapshot) return null;
  const positions = snapshot.portfolio.positions;

  return (
    <Panel title="Open positions" extra={`${positions.length} open`} className="animate-odin-fade">
      {positions.length === 0 ? (
        <EmptyState title="No open paper positions" detail="Positions appear after filled BUY orders on the paper ledger." />
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.12em] text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Mark</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">uPnL</th>
                <th className="px-3 py-2">Stop</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Protection</th>
                <th className="px-3 py-2">Exposure</th>
                <th className="px-3 py-2">Hold</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.pairAddress} className="border-b border-border/70">
                  <td className="px-3 py-2">
                    <div>{position.baseSymbol}</div>
                    <div className="text-[10px] text-muted">{position.markState}</div>
                  </td>
                  <td className="mono px-3 py-2">{formatQty(position.baseQty)}</td>
                  <td className="mono px-3 py-2">{formatPx(position.avgCostUsd)}</td>
                  <td className="mono px-3 py-2">{formatPx(position.markUsd)}</td>
                  <td className="mono px-3 py-2">{formatUsd(position.marketValueUsd)}</td>
                  <td className={cn("mono px-3 py-2", signedClass(position.unrealizedPnlUsd))}>
                    {formatUsd(position.unrealizedPnlUsd)}
                  </td>
                  <td className="mono px-3 py-2">{formatPx(position.stopUsd)}</td>
                  <td className="mono px-3 py-2">{formatPx(position.targetUsd)}</td>
                  <td className="px-3 py-2 text-[11px]">
                    {position.protected ? (
                      <span className="text-foreground">
                        Protected
                        <span className="block text-[10px] text-muted">
                          {(position.protectionKinds ?? []).join("/") || "OCO"} · {position.protectionOrigin ?? "—"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">Unprotected</span>
                    )}
                  </td>
                  <td className="mono px-3 py-2">{formatPct(position.exposurePct)}</td>
                  <td className="mono px-3 py-2">{formatDuration(position.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
